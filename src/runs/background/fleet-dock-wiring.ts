/**
 * Fleet Status Dock Wiring (PHASE-04).
 *
 * Verdraht FleetDockController mit der Pi-Extension-API: Widget-Registrierung
 * (setWidget mit aboveEditor/belowEditor-Placement), Terminal-Input-Handler
 * (ctx.ui.onTerminalInput) und die Deaktivierung des alten Async-Widgets bei
 * aktiver FleetView oder explizit deaktiviertem ui.asyncWidget.
 *
 * Wird von src/extension/index.ts ueber genau 3 additive Call-Sites
 * angebunden (in resetSessionState, im tool_result-Handler, in
 * runtimeCleanup) - keine bestehende Zeile dort wird veraendert.
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
 * Verifikationsdurchlauf gefunden, siehe DECISIONS.md DEC-026).
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
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FLEET_DOCK_WIDGET_KEY, WIDGET_KEY, type ExtensionConfig, type SubagentState } from "../../shared/types.ts";
import { createFleetDockController, type FleetDockController } from "./fleet-dock-controller.ts";

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
	const controller: FleetDockController | undefined = fleetViewEnabled ? createFleetDockController(state) : undefined;
	let unsubscribeTerminalInput: (() => void) | undefined;

	// Schicht 1 (siehe Kopfkommentar): staendig gueltig fuer die gesamte
	// Lebensdauer dieser Extension-Instanz, nicht nur nach einem tool_result.
	state.suppressAsyncWidget = overridesOldWidget;

	function onSessionStart(ctx: ExtensionContext): void {
		if (!controller || !ctx.hasUI) return;
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) =>
			controller.handleTerminalInput({ getEditorText: () => ctx.ui.getEditorText() }, data),
		);
		ctx.ui.setWidget(FLEET_DOCK_WIDGET_KEY, (_tui, theme) => controller.createComponent(theme), { placement });
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
			}
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	}

	return { fleetViewEnabled, onSessionStart, onToolResult, dispose };
}
