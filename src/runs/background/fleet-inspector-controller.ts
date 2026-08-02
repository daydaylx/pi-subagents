/**
 * Fleet Inspector Controller (PHASE-05).
 *
 * Haelt den Interaktionszustand des Inspectors: welcher Dock-Key geoeffnet
 * ist, Scroll-Position (scrollFromBottom, im Renderer geklemmt - siehe
 * fleet-inspector.ts), ob Tool-Details global aufgeklappt sind, und einen
 * throttled Transcript-Read-Cache. Liest Entries NIE ueber eine eigene
 * buildFleetEntries()-Instanz - der injizierte getEntries()-Accessor zeigt
 * in der Wiring-Schicht auf denselben FleetDockController, um einen
 * zweiten, unabhaengig throttled Disk-Scan zu vermeiden.
 *
 * Throttle fuer Transcript-Reads: 500ms (teurer als das bereits im Speicher
 * liegende FleetAgentEntry[], daher groesseres Intervall als der Docks
 * 250ms). invalidateTranscriptCache() wird von der Wiring-Schicht bei jedem
 * tool_result-Event aufgerufen - das ist die "ereignisnahe" Haelfte der
 * Aktualisierung, die 500ms-Throttle der "begrenzte Poll-Fallback" aus
 * CONCEPT.md.
 *
 * Kein Editor-Leerheits-Guard noetig (anders als FleetDockController): der
 * Inspector oeffnet nur aus einem bereits aktiven Dock heraus (per Enter,
 * siehe fleet-dock-controller.ts's onOpenInspector-Option) und die Wiring-
 * Schicht routet waehrend seiner Offenzeit alle Eingaben exklusiv hierher -
 * es gibt keinen Editor-Text-Zustand, gegen den er sich selbstheilen muesste.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { FleetAgentEntry } from "../shared/fleet-projection.ts";
import { readChildTranscript, type ReadChildTranscriptResult } from "../shared/fleet-transcript-reader.ts";
import { DEFAULT_INSPECTOR_MAX_VISIBLE_LINES, renderFleetInspector } from "../../tui/fleet-inspector.ts";

type Theme = ExtensionContext["ui"]["theme"];
type TerminalInputResult = { consume?: boolean; data?: string } | undefined;

export const DEFAULT_INSPECTOR_REFRESH_INTERVAL_MS = 500;

const EMPTY_TRANSCRIPT: ReadChildTranscriptResult = { events: [], truncated: false };

export interface FleetInspectorControllerOptions {
	now?: () => number;
	refreshIntervalMs?: number;
	maxVisibleLines?: number;
	trustedRoots?: () => string[];
	readTranscript?: typeof readChildTranscript;
}

export class FleetInspectorController {
	private isOpenFlag = false;
	private openKey: string | undefined;
	private scrollFromBottom = 0;
	private toolDetailsExpanded = false;
	private cachedTranscript: ReadChildTranscriptResult = EMPTY_TRANSCRIPT;
	private cachedAt = Number.NEGATIVE_INFINITY;
	private readonly getEntries: () => FleetAgentEntry[];
	private readonly options: FleetInspectorControllerOptions;

	// Keine TS-Parameter-Properties: --experimental-strip-types (test:unit) kann
	// diese Syntax nicht strippen, nur --experimental-transform-types (test:
	// integration/e2e) kann das - siehe FleetDockController fuer denselben Grund.
	constructor(getEntries: () => FleetAgentEntry[], options: FleetInspectorControllerOptions = {}) {
		this.getEntries = getEntries;
		this.options = options;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private refreshIntervalMs(): number {
		return this.options.refreshIntervalMs ?? DEFAULT_INSPECTOR_REFRESH_INTERVAL_MS;
	}

	private maxVisibleLines(): number {
		return this.options.maxVisibleLines ?? DEFAULT_INSPECTOR_MAX_VISIBLE_LINES;
	}

	private readTranscriptFn(): typeof readChildTranscript {
		return this.options.readTranscript ?? readChildTranscript;
	}

	isOpen(): boolean {
		return this.isOpenFlag;
	}

	/** Oeffnet den Inspector fuer einen Dock-Key; setzt Scroll/Expand/Cache zurueck. */
	open(key: string): void {
		this.isOpenFlag = true;
		this.openKey = key;
		this.scrollFromBottom = 0;
		this.toolDetailsExpanded = false;
		this.invalidateTranscriptCache();
	}

	close(): void {
		this.isOpenFlag = false;
	}

	getSelectedEntry(): FleetAgentEntry | undefined {
		if (this.openKey === undefined) return undefined;
		return this.getEntries().find((entry) => entry.key === this.openKey);
	}

	getChildren(): FleetAgentEntry[] {
		if (this.openKey === undefined) return [];
		return this.getEntries().filter((entry) => entry.parentKey === this.openKey);
	}

	/** Throttled Transcript-Read; liefert leeres Ergebnis, solange kein Eintrag/transcriptPath vorhanden ist. */
	getTranscript(): ReadChildTranscriptResult {
		const entry = this.getSelectedEntry();
		if (!entry?.transcriptPath) return EMPTY_TRANSCRIPT;
		const now = this.now();
		if (now - this.cachedAt < this.refreshIntervalMs()) return this.cachedTranscript;
		const trustedRoots = this.options.trustedRoots?.() ?? [];
		this.cachedTranscript = this.readTranscriptFn()(entry.transcriptPath, trustedRoots);
		this.cachedAt = now;
		return this.cachedTranscript;
	}

	/** Erzwingt einen sofortigen Re-Read beim naechsten getTranscript()-Aufruf. */
	invalidateTranscriptCache(): void {
		this.cachedAt = Number.NEGATIVE_INFINITY;
	}

	scrollUp(lines = 1): void {
		this.scrollFromBottom = Math.max(0, this.scrollFromBottom + lines);
	}

	scrollDown(lines = 1): void {
		this.scrollFromBottom = Math.max(0, this.scrollFromBottom - lines);
	}

	pageUp(): void {
		this.scrollUp(this.maxVisibleLines());
	}

	pageDown(): void {
		this.scrollDown(this.maxVisibleLines());
	}

	/** Grosszuegig; renderFleetInspector() klemmt auf den tatsaechlichen Zeileninhalt. */
	scrollToTop(): void {
		this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
	}

	scrollToBottom(): void {
		this.scrollFromBottom = 0;
	}

	getScrollFromBottom(): number {
		return this.scrollFromBottom;
	}

	toggleToolDetails(): void {
		this.toolDetailsExpanded = !this.toolDetailsExpanded;
	}

	isToolDetailsExpanded(): boolean {
		return this.toolDetailsExpanded;
	}

	/**
	 * Nur relevant, waehrend isOpen() - das Gating (Inspector vor Dock) erfolgt
	 * in der Wiring-Schicht (fleet-dock-wiring.ts's routeTerminalInput), nicht
	 * hier. Konsumiert alles Bekannte, damit waehrend offenem Inspector nichts
	 * zum Dock oder Editor durchsickert.
	 */
	handleTerminalInput(data: string): TerminalInputResult {
		if (isKeyRelease(data)) return undefined;
		if (!this.isOpenFlag) return undefined;

		if (matchesKey(data, "escape")) {
			this.close();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			this.scrollUp();
			return { consume: true };
		}
		if (matchesKey(data, "down")) {
			this.scrollDown();
			return { consume: true };
		}
		if (matchesKey(data, "pageUp")) {
			this.pageUp();
			return { consume: true };
		}
		if (matchesKey(data, "pageDown")) {
			this.pageDown();
			return { consume: true };
		}
		if (matchesKey(data, "home")) {
			this.scrollToTop();
			return { consume: true };
		}
		if (matchesKey(data, "end")) {
			this.scrollToBottom();
			return { consume: true };
		}
		if (matchesKey(data, "space")) {
			this.toggleToolDetails();
			return { consume: true };
		}
		if (matchesKey(data, "return")) {
			// Reserviert (Drill-down in Kinder ist Nicht-Ziel dieser Phase) - trotzdem
			// konsumiert, damit nichts zum Editor durchsickert, waehrend offen.
			return { consume: true };
		}
		return undefined;
	}

	/** Component fuer setWidget's Factory-Overload. render() liefert [] wenn geschlossen - erzeugt keine sichtbare Luecke (siehe DECISIONS.md). */
	createComponent(theme: Theme): Component {
		return {
			render: (width: number): string[] => {
				if (!this.isOpenFlag) return [];
				const entry = this.getSelectedEntry();
				const children = this.getChildren();
				const transcript = this.getTranscript();
				return renderFleetInspector(entry, children, transcript, {
					width,
					theme,
					scrollFromBottom: this.scrollFromBottom,
					toolDetailsExpanded: this.toolDetailsExpanded,
					maxVisibleLines: this.maxVisibleLines(),
					now: this.now(),
				});
			},
			invalidate: () => {},
		};
	}
}

export function createFleetInspectorController(getEntries: () => FleetAgentEntry[], options?: FleetInspectorControllerOptions): FleetInspectorController {
	return new FleetInspectorController(getEntries, options);
}
