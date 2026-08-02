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
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { SubagentState } from "../../shared/types.ts";
import { renderFleetDock, MAX_DOCK_ROWS } from "../../tui/fleet-dock.ts";
import { buildFleetEntries, type BuildFleetEntriesDeps, type FleetAgentEntry } from "../shared/fleet-projection.ts";

type Theme = ExtensionContext["ui"]["theme"];
type TerminalInputResult = { consume?: boolean; data?: string } | undefined;

export const DEFAULT_REFRESH_INTERVAL_MS = 250;

export interface FleetDockControllerOptions {
	now?: () => number;
	refreshIntervalMs?: number;
	maxRows?: number;
	deps?: BuildFleetEntriesDeps;
}

export class FleetDockController {
	private selectedKey: string | undefined;
	private lastIndex = 0;
	private expandedKey: string | undefined;
	private active = false;
	private cachedEntries: FleetAgentEntry[] = [];
	private cachedAt = Number.NEGATIVE_INFINITY;
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

	/** Liefert die aktuelle FleetAgentEntry-Liste, throttled auf refreshIntervalMs(). */
	getEntries(): FleetAgentEntry[] {
		const now = this.now();
		if (now - this.cachedAt < this.refreshIntervalMs()) return this.cachedEntries;
		this.cachedEntries = buildFleetEntries(this.state, { now: () => now, ...this.options.deps });
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
			this.toggleExpanded();
			return { consume: true };
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
				});
			},
			invalidate: () => {},
		};
	}
}

export function createFleetDockController(state: SubagentState, options?: FleetDockControllerOptions): FleetDockController {
	return new FleetDockController(state, options);
}
