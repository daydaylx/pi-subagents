/**
 * Fleet Status Dock Wiring (PHASE-04, erweitert um den Inspector in PHASE-05).
 *
 * Verdraht FleetDockController UND FleetInspectorController mit der
 * Pi-Extension-API: Widget-Registrierung (setWidget mit aboveEditor/
 * belowEditor-Placement, je ein Widget-Key pro Controller), ein einziger
 * gemeinsamer Terminal-Input-Handler (ctx.ui.onTerminalInput) und die
 * Deaktivierung des alten Async-Widgets bei aktiver FleetView oder explizit
 * deaktiviertem ui.asyncWidget.
 *
 * Wird von src/extension/index.ts ueber genau 3 additive Call-Sites
 * angebunden (in resetSessionState, im tool_result-Handler, in
 * runtimeCleanup) - keine bestehende Zeile dort wird veraendert. PHASE-05
 * fuegt in index.ts KEINE einzige neue Zeile hinzu: der Inspector wird
 * vollstaendig in diese bestehende Fabrik integriert, ihr Rueckgabetyp
 * (FleetDockWiring) bleibt unveraendert - dieselben drei Hook-Callbacks
 * uebernehmen die Inspector-Lifecycle-Pflege mit.
 *
 * Mutual-Exclusion-Design (Gesamtabschlusskriterium 8), zweischichtig:
 *
 * 1. state.suppressAsyncWidget (types.ts) wird hier synchron beim Aufbau
 *    gesetzt und von async-job-tracker.ts's rerenderWidget() bei JEDEM
 *    Aufruf live geprueft (Poller-Tick, handleStarted/handleComplete,
 *    Statusaenderungen laufender Jobs). Das deckt alle Stellen ab, an denen
 *    das alte Widget unabhaengig von einem tool_result-Event erneut gerendert
 *    werden kann - ohne dass async-job-tracker.ts's showAsyncWidget-Option
 *    (aus index.ts's unveraendertem Konstruktionsaufruf) angefasst wird.
 * 2. onToolResult() ueberschreibt zusaetzlich WIDGET_KEY aktiv mit
 *    setWidget(WIDGET_KEY, undefined), da index.ts's tool_result-Handler
 *    selbst einen direkten renderWidget()-Aufruf enthaelt (Zeile ~595, nicht
 *    ueber async-job-tracker.ts geroutet) - dessen unveraenderte Bedingung
 *    bleibt byte-identisch, ein reiner Zusatzaufruf danach genuegt.
 *
 * Ohne Schicht 1 kehrt das alte Widget bei jeder Job-Statusaenderung
 * zwischen zwei tool_result-Events zurueck (empirisch beim zweiten
 * Verifikationsdurchlauf gefunden, siehe DECISIONS.md DEC-026). Das deckt
 * gleichzeitig den PHASE-05-Punkt "Widget waehrend geoeffnetem Inspector
 * ausblenden" ab: suppressAsyncWidget gilt fuer die gesamte Lebensdauer bei
 * aktiver FleetView, unabhaengig vom Inspector-Offen-Zustand - keine
 * zusaetzliche Bedingung noetig (siehe DECISIONS.md).
 *
 * ui.asyncWidget-Praezedenz (siehe DECISIONS.md DEC-024/DEC-025): nur die
 * "verstecken"-Richtung ist umgesetzt (asyncWidget:false versteckt das alte
 * Widget zuverlaessig, auch wenn showAsyncWidget/fleetView das nicht
 * verlangen wuerden). Die umgekehrte Richtung (asyncWidget:true soll das
 * Widget erzwingen, obwohl config.ui.showAsyncWidget===false den
 * renderWidget()-Aufruf in index.ts bereits komplett uebersprungen hat)
 * ist bewusst NICHT umgesetzt: dafuer muesste diese Datei renderWidget()
 * und state.asyncJobs selbst duplizieren, ohne einen realen Anwendungsfall
 * in der dokumentierten Rueckfallkonfiguration (README.md) zu bedienen -
 * dort wird asyncWidget:true nur zusammen mit fleetView:false verwendet,
 * wo showAsyncWidget ohnehin unangetastet (default true) bleibt.
 *
 * Input-Routing (PHASE-05, Zwei-Ebenen-Escape): der eine gemeinsame
 * onTerminalInput-Handler prueft zuerst, ob der Inspector offen ist - wenn
 * ja, geht JEDE Eingabe exklusiv an ihn (er konsumiert Scroll/Space/Escape
 * vollstaendig, Escape schliesst dabei NUR ihn). Erst wenn er geschlossen
 * ist, faellt die Eingabe wie bisher an FleetDockController - dessen eigenes
 * Escape wird dadurch automatisch zur zweiten Eskalationsstufe (Dock
 * deaktivieren), ohne dass beide Controller je gleichzeitig auf dieselbe
 * Taste reagieren. Enter oeffnet den Inspector ueber FleetDockController-
 * Options onOpenInspector (siehe fleet-dock-controller.ts), nicht hier.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FLEET_DOCK_WIDGET_KEY, FLEET_INSPECTOR_WIDGET_KEY, WIDGET_KEY, type ExtensionConfig, type SubagentState } from "../../shared/types.ts";
import { createFleetDockController, type FleetDockController } from "./fleet-dock-controller.ts";
import { createFleetInspectorController, type FleetInspectorController } from "./fleet-inspector-controller.ts";
import { resolveInspectorTrustedRoots } from "../shared/fleet-transcript-reader.ts";
import { requestFleetStop } from "./fleet-stop.ts";
import type { FleetAgentEntry } from "../shared/fleet-projection.ts";

function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("Extension context no longer active");
}

export interface FleetDockWiring {
	readonly fleetViewEnabled: boolean;
	onSessionStart(ctx: ExtensionContext): void;
	onToolResult(ctx: ExtensionContext): void;
	dispose(): void;
}

export function createFleetDockWiring(state: SubagentState, config: ExtensionConfig): FleetDockWiring {
	const fleetViewEnabled = config.ui?.fleetView === true;
	const asyncWidgetExplicitlyDisabled = config.ui?.asyncWidget === false;
	const overridesOldWidget = fleetViewEnabled || asyncWidgetExplicitlyDisabled;
	const placement = config.ui?.fleetViewPlacement ?? "belowEditor";

	let inspectorController: FleetInspectorController | undefined;

	// PHASE-06: gemeinsamer Stop-Dispatch fuer Dock UND Inspector - beide
	// Controller kennen nur den Key, nicht den vollen FleetAgentEntry; die
	// Wiring-Schicht loest den Key gegen die aktuelle Entry-Liste auf und ruft
	// dann requestFleetStop() (siehe fleet-stop.ts, reiner Dispatch ueber den
	// bestehenden dateibasierten Control-Kanal, keine neue Orchestrierung).
	function handleFleetStop(key: string): void {
		const entry: FleetAgentEntry | undefined = controller?.getEntries().find((candidate) => candidate.key === key);
		if (!entry) return;
		requestFleetStop(entry);
		controller?.invalidateCache();
	}

	const controller: FleetDockController | undefined = fleetViewEnabled
		? createFleetDockController(state, {
				onOpenInspector: (key) => inspectorController?.open(key),
				onStop: handleFleetStop,
			})
		: undefined;
	inspectorController = controller
		? createFleetInspectorController(() => controller.getEntries(), {
				trustedRoots: () =>
					resolveInspectorTrustedRoots({
						sessionFile: state.lastUiContext?.sessionManager.getSessionFile() ?? null,
						projectCwd: state.baseCwd,
						worktreeBaseDir: config.worktreeBaseDir,
					}),
				onStop: handleFleetStop,
			})
		: undefined;

	let unsubscribeTerminalInput: (() => void) | undefined;

	// Schicht 1 (siehe Kopfkommentar): staendig gueltig fuer die gesamte
	// Lebensdauer dieser Extension-Instanz, nicht nur nach einem tool_result.
	state.suppressAsyncWidget = overridesOldWidget;

	function routeTerminalInput(ctx: ExtensionContext, data: string): { consume?: boolean; data?: string } | undefined {
		if (inspectorController?.isOpen()) return inspectorController.handleTerminalInput(data);
		if (!controller) return undefined;
		return controller.handleTerminalInput({ getEditorText: () => ctx.ui.getEditorText() }, data);
	}

	function onSessionStart(ctx: ExtensionContext): void {
		if (!controller || !ctx.hasUI) return;
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => routeTerminalInput(ctx, data));
		ctx.ui.setWidget(FLEET_DOCK_WIDGET_KEY, (_tui, theme) => controller.createComponent(theme), { placement });
		if (inspectorController) {
			ctx.ui.setWidget(FLEET_INSPECTOR_WIDGET_KEY, (_tui, theme) => inspectorController!.createComponent(theme), { placement });
		}
	}

	function onToolResult(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		// Schicht 2 (siehe Kopfkommentar): index.ts's eigener direkter
		// renderWidget()-Aufruf im selben Handler ist nicht ueber
		// async-job-tracker.ts geroutet und braucht daher einen Zusatzaufruf.
		if (overridesOldWidget) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		controller?.invalidateCache();
		// "ereignisnahe" Haelfte der Live-Transcript-Aktualisierung (die
		// 500ms-Throttle in FleetInspectorController ist der Poll-Fallback).
		inspectorController?.invalidateTranscriptCache();
		if (overridesOldWidget || controller) {
			ctx.ui.requestRender?.();
		}
	}

	function dispose(): void {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		if (!controller) return;
		try {
			if (state.lastUiContext?.hasUI) {
				state.lastUiContext.ui.setWidget(FLEET_DOCK_WIDGET_KEY, undefined);
				if (inspectorController) {
					state.lastUiContext.ui.setWidget(FLEET_INSPECTOR_WIDGET_KEY, undefined);
				}
			}
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	}

	return { fleetViewEnabled, onSessionStart, onToolResult, dispose };
}
