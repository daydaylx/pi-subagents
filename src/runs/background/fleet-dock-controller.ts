/**
 * Fleet Status Dock Controller (PHASE-04).
 *
 * Haelt den Interaktionszustand des Docks: welcher Eintrag ausgewaehlt ist
 * (per stabilem FleetAgentEntry.key, nicht Index - siehe fleet-projection.ts),
 * ob eine Detailzeile aufgeklappt ist, und ob der Dock aktuell Tastaturfokus
 * beansprucht. Liefert sowohl das Component fuer ctx.ui.setWidget() als auch
 * den ctx.ui.onTerminalInput()-Handler.
 *
 * Throttling: buildFleetEntries() scannt fuer "recent" Async-Eintraege die
 * Festplatte (listAsyncRuns()). Da das von setWidget's Factory-Overload
 * zurueckgegebene Component.render() potenziell sehr haeufig aufgerufen wird
 * (jede Invalidierung, jeder Tastendruck an anderer Stelle), wird das
 * Ergebnis fuer REFRESH_INTERVAL_MS zwischengespeichert statt bei jedem
 * render()-Aufruf neu zu berechnen.
 *
 * Fokus-Design: pi-tui hat keinen oeffentlichen Fokus-Mechanismus
 * (focusedComponent ist privat). Der Dock beansprucht Fokus deshalb ueber
 * eine eigene Heuristik: "down" bei leerem Editor aktiviert ihn; ist er
 * aktiv, werden nur up/down/return/escape konsumiert. Ein Guard am Anfang
 * jedes Tastendrucks deaktiviert den Dock selbstheilend, sobald der Editor
 * wieder Text enthaelt (z.B. weil der Nutzer zu tippen begonnen hat), statt
 * bei jeder anderen Taste explizit zu raten, ob sie Text erzeugt.
 *
 * KNOWN GAP: Editor-Inhalt, der ohne dazwischenliegenden Tastendruck
 * erscheint (z.B. Paste ueber einen anderen Kanal als das Terminal-Input),
 * wird erst beim naechsten Tastendruck erkannt - der Guard prueft nur beim
 * Einlauf jedes Terminal-Inputs, nicht kontinuierlich.
 *
 * PHASE-06 - Stop/Dismiss: "s" bewaffnet eine Stop-Bestaetigung fuer den
 * selektierten Eintrag (nur source==="async", siehe fleet-stop.ts); ein
 * zweites "s" auf demselben Eintrag loest options.onStop() aus, jede andere
 * Taste ausser Escape entwaffnet still (kein versehentliches Stoppen durch
 * eine Taste, die zufaellig spaeter "s" ist). "d" blendet einen selektierten,
 * bereits terminalen (completed/error/stopped) Top-Level-Eintrag lokal aus
 * (dismissedKeys) - rein clientseitig, keine Rueckwirkung auf state.asyncJobs
 * oder status.json. completedEntryVisibleMs() blendet zusaetzlich terminale
 * Top-Level-Eintraege automatisch aus, sobald sie aelter als das Fenster
 * sind - Kind-Eintraege eines ausgeblendeten Eintrags kaskadieren mit,
 * begrenzt auf depth===0 fuer den Alters-Check selbst (ein einzelner
 * abgeschlossener Schritt soll seinen noch laufenden Parallel-/Chain-Lauf
 * nicht mitausblenden).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { SubagentState } from "../../shared/types.ts";
import { renderFleetDock, MAX_DOCK_ROWS } from "../../tui/fleet-dock.ts";
import { buildFleetEntries, type BuildFleetEntriesDeps, type FleetAgentEntry, type FleetAgentState } from "../shared/fleet-projection.ts";

type Theme = ExtensionContext["ui"]["theme"];
type TerminalInputResult = { consume?: boolean; data?: string } | undefined;

export const DEFAULT_REFRESH_INTERVAL_MS = 250;
export const DEFAULT_COMPLETED_ENTRY_VISIBLE_MS = 5 * 60 * 1000;

const TERMINAL_STATES: ReadonlySet<FleetAgentState> = new Set(["completed", "error", "stopped"]);

function isTerminalState(state: FleetAgentState): boolean {
	return TERMINAL_STATES.has(state);
}

export interface FleetDockControllerOptions {
	now?: () => number;
	refreshIntervalMs?: number;
	maxRows?: number;
	deps?: BuildFleetEntriesDeps;
	// PHASE-05: wenn gesetzt, oeffnet Enter (bei vorhandener Selektion) den
	// Inspector statt der inline toggleExpanded()-Detailzeile. Optional und
	// rueckwaertskompatibel - ohne diese Option (z.B. in bestehenden Tests)
	// bleibt das PHASE-04-Verhalten unveraendert.
	onOpenInspector?: (key: string) => void;
	// PHASE-06: Fenster, nach dem ein abgeschlossener/fehlgeschlagener/
	// gestoppter Top-Level-Eintrag automatisch aus dem Dock verschwindet.
	completedEntryVisibleMs?: number;
	// PHASE-06: wird nach der zweiten "s"-Bestaetigung mit dem Key des
	// betroffenen Eintrags aufgerufen. Der Controller selbst liefert keinen
	// Stop-Kanal (bleibt reine Zustandsmaschine) - die Wiring-Schicht
	// entscheidet, wie tatsaechlich gestoppt wird (siehe fleet-stop.ts).
	onStop?: (key: string) => void;
}

export class FleetDockController {
	private selectedKey: string | undefined;
	private lastIndex = 0;
	private expandedKey: string | undefined;
	private active = false;
	private cachedEntries: FleetAgentEntry[] = [];
	private cachedAt = Number.NEGATIVE_INFINITY;
	private readonly dismissedKeys = new Set<string>();
	private stopArmedKey: string | undefined;
	private readonly state: SubagentState;
	private readonly options: FleetDockControllerOptions;

	// Keine TS-Parameter-Properties hier: --experimental-strip-types (test:unit)
	// kann diese Syntax nicht strippen, nur --experimental-transform-types kann das.
	constructor(state: SubagentState, options: FleetDockControllerOptions = {}) {
		this.state = state;
		this.options = options;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private refreshIntervalMs(): number {
		return this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
	}

	private maxRows(): number {
		return this.options.maxRows ?? MAX_DOCK_ROWS;
	}

	private completedEntryVisibleMs(): number {
		return this.options.completedEntryVisibleMs ?? DEFAULT_COMPLETED_ENTRY_VISIBLE_MS;
	}

	/**
	 * Entfernt dismisste Eintraege sowie automatisch verfallene Top-Level-
	 * Eintraege (terminal, aelter als completedEntryVisibleMs()). Kaskadiert
	 * auf Kind-Eintraege ueber parentKey, da buildFleetEntries() Eltern immer
	 * vor ihren Kindern liefert (siehe fleet-projection.ts).
	 */
	private filterVisible(entries: FleetAgentEntry[], now: number): FleetAgentEntry[] {
		const removedKeys = new Set<string>();
		const visible: FleetAgentEntry[] = [];
		for (const entry of entries) {
			const parentRemoved = entry.parentKey !== undefined && removedKeys.has(entry.parentKey);
			const expired = entry.depth === 0 && isTerminalState(entry.state) && now - entry.updatedAt >= this.completedEntryVisibleMs();
			if (parentRemoved || this.dismissedKeys.has(entry.key) || expired) {
				removedKeys.add(entry.key);
				continue;
			}
			visible.push(entry);
		}
		return visible;
	}

	/** Liefert die aktuelle FleetAgentEntry-Liste, throttled auf refreshIntervalMs(). */
	getEntries(): FleetAgentEntry[] {
		const now = this.now();
		if (now - this.cachedAt < this.refreshIntervalMs()) return this.cachedEntries;
		const raw = buildFleetEntries(this.state, { now: () => now, ...this.options.deps });
		this.cachedEntries = this.filterVisible(raw, now);
		this.cachedAt = now;
		this.resolveSelection();
		return this.cachedEntries;
	}

	/** Erzwingt eine Neuberechnung beim naechsten getEntries()-Aufruf. */
	invalidateCache(): void {
		this.cachedAt = Number.NEGATIVE_INFINITY;
	}

	private resolveSelection(): void {
		const entries = this.cachedEntries;
		if (this.stopArmedKey !== undefined && !entries.some((entry) => entry.key === this.stopArmedKey)) {
			// Der bewaffnete Eintrag ist verschwunden (gestoppt+abgelaufen, dismisst,
			// oder ausserhalb des Sichtbarkeitsfensters) - eine stehende Bestaetigung
			// darf nicht auf einen spaeter wiederverwendeten Key uebertragen werden.
			this.stopArmedKey = undefined;
		}
		if (entries.length === 0) {
			this.selectedKey = undefined;
			this.expandedKey = undefined;
			this.lastIndex = 0;
			return;
		}
		if (this.selectedKey !== undefined) {
			const idx = entries.findIndex((entry) => entry.key === this.selectedKey);
			if (idx !== -1) {
				this.lastIndex = idx;
				return;
			}
		}
		const clamped = Math.min(this.lastIndex, entries.length - 1);
		this.selectedKey = entries[clamped]!.key;
		this.lastIndex = clamped;
		if (this.expandedKey !== undefined && !entries.some((entry) => entry.key === this.expandedKey)) {
			this.expandedKey = undefined;
		}
	}

	getSelectedKey(): string | undefined {
		return this.selectedKey;
	}

	getExpandedKey(): string | undefined {
		return this.expandedKey;
	}

	isActive(): boolean {
		return this.active;
	}

	moveSelection(direction: 1 | -1): void {
		const entries = this.getEntries();
		if (entries.length === 0) return;
		const currentIdx = this.selectedKey !== undefined ? entries.findIndex((entry) => entry.key === this.selectedKey) : -1;
		const base = currentIdx === -1 ? 0 : currentIdx;
		const nextIdx = Math.max(0, Math.min(entries.length - 1, base + direction));
		this.selectedKey = entries[nextIdx]!.key;
		this.lastIndex = nextIdx;
	}

	toggleExpanded(): void {
		if (this.selectedKey === undefined) return;
		this.expandedKey = this.expandedKey === this.selectedKey ? undefined : this.selectedKey;
	}

	/** true, solange fuer key eine Stop-Bestaetigung aussteht ("s" wurde einmal gedrueckt). */
	isStopArmed(key: string): boolean {
		return this.stopArmedKey === key;
	}

	/**
	 * Blendet einen bereits terminalen (completed/error/stopped) Top-Level-
	 * Eintrag lokal aus. Laufende/pausierte Eintraege und Kind-Zeilen koennen
	 * nicht direkt dismisst werden (Aenderungsregel: nur "erledigte
	 * Eintraege"). Wirkt sofort, nicht erst nach dem naechsten throttled
	 * getEntries()-Aufruf.
	 */
	dismiss(key: string | undefined = this.selectedKey): boolean {
		if (key === undefined) return false;
		const entry = this.cachedEntries.find((candidate) => candidate.key === key);
		if (!entry || entry.depth !== 0 || !isTerminalState(entry.state)) return false;
		this.dismissedKeys.add(key);
		this.invalidateCache();
		this.getEntries();
		return true;
	}

	activate(): void {
		const entries = this.getEntries();
		this.active = true;
		if (this.selectedKey === undefined && entries.length > 0) {
			this.selectedKey = entries[0]!.key;
			this.lastIndex = 0;
		}
	}

	deactivate(): void {
		this.active = false;
		this.stopArmedKey = undefined;
	}

	/**
	 * Terminal-Input-Handler fuer ctx.ui.onTerminalInput(). ctx ist absichtlich
	 * auf getEditorText() minimiert statt des vollen ExtensionUIContext, um die
	 * Kopplung an den echten Editor-Zustand testbar zu halten.
	 */
	handleTerminalInput(ctx: { getEditorText(): string }, data: string): TerminalInputResult {
		if (isKeyRelease(data)) return undefined;
		if (this.active && ctx.getEditorText().length > 0) {
			this.deactivate();
		}
		if (!this.active) {
			if (ctx.getEditorText().length === 0 && matchesKey(data, "down")) {
				this.activate();
				return { consume: true };
			}
			return undefined;
		}
		if (this.stopArmedKey !== undefined) {
			if (matchesKey(data, "s") && this.stopArmedKey === this.selectedKey) {
				const key = this.stopArmedKey;
				this.stopArmedKey = undefined;
				this.options.onStop?.(key);
				return { consume: true };
			}
			// Jede andere Taste entwaffnet still statt ihre eigentliche Wirkung zu
			// entfalten UND das Stoppen auszuloesen - verhindert ein versehentliches
			// Stoppen durch eine spaeter zufaellig erneut gedrueckte "s"-Taste nach
			// einer Aktion, die den Fokus/die Selektion veraendert hat.
			this.stopArmedKey = undefined;
			if (matchesKey(data, "escape")) return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			this.deactivate();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			this.moveSelection(-1);
			return { consume: true };
		}
		if (matchesKey(data, "down")) {
			this.moveSelection(1);
			return { consume: true };
		}
		if (matchesKey(data, "return")) {
			if (this.options.onOpenInspector && this.selectedKey !== undefined) {
				this.options.onOpenInspector(this.selectedKey);
			} else {
				this.toggleExpanded();
			}
			return { consume: true };
		}
		if (matchesKey(data, "s")) {
			const key = this.selectedKey;
			const entry = key !== undefined ? this.cachedEntries.find((candidate) => candidate.key === key) : undefined;
			if (!entry || entry.source !== "async" || !entry.canStop || !entry.asyncDir) return undefined;
			this.stopArmedKey = entry.key;
			return { consume: true };
		}
		if (matchesKey(data, "d")) {
			return this.dismiss() ? { consume: true } : undefined;
		}
		return undefined;
	}

	/** Component fuer setWidget's Factory-Overload. Kein eigener Render-Cache noetig, da getEntries() bereits throttled. */
	createComponent(theme: Theme): Component {
		return {
			render: (width: number): string[] => {
				const entries = this.getEntries();
				return renderFleetDock(entries, this.selectedKey, {
					width,
					theme,
					expandedKey: this.expandedKey,
					maxRows: this.maxRows(),
					now: this.now(),
					stopArmedKey: this.stopArmedKey,
					// PHASE-08: nur mit Tastaturfokus wird die Tastenkuerzelzeile
					// gerendert (siehe fleet-dock.ts).
					active: this.active,
				});
			},
			invalidate: () => {},
		};
	}
}

export function createFleetDockController(state: SubagentState, options?: FleetDockControllerOptions): FleetDockController {
	return new FleetDockController(state, options);
}
