/** Compact, read-only rendering of the current FleetAgentEntry projection. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatTokens, shortenPath } from "../shared/formatters.ts";
import type { FleetAgentEntry, FleetAgentState } from "../runs/shared/fleet-projection.ts";
import { truncLine } from "./render.ts";

type Theme = ExtensionContext["ui"]["theme"];
type ThemeColor = Parameters<Theme["fg"]>[0];

export const MAX_DOCK_ROWS = 6;

/** Mindestbreite, unterhalb derer die Aktivitaetsbeschreibung ganz entfaellt statt zu einem Stummel zu werden. */
const MIN_DETAIL_WIDTH = 10;

const SEPARATOR = " · ";

// Sortier-Rang: needs_attention zuerst, dann running, dann paused, dann alle
// Terminalzustaende zuletzt.
const STATE_RANK: Record<FleetAgentState, number> = {
	needs_attention: 0,
	running: 1,
	paused: 2,
	completed: 3,
	error: 3,
	stopped: 3,
};

const TERMINAL_STATES: ReadonlySet<FleetAgentState> = new Set(["completed", "error", "stopped"]);

interface StateVisual {
	glyph: string;
	color: ThemeColor;
	/**
	 * Ausgeschriebener Zustand fuer die Statuszeile. Bewusst nicht fuer
	 * running (dort traegt die konkrete Taetigkeit die Information, siehe
	 * CONCEPT.md "Generische Ausgaben wie 'arbeitet' sind kein ausreichender
	 * Primaerstatus") und nicht fuer needs_attention (dort steht der Grund
	 * bereits in activityDetail).
	 */
	label?: string;
}

const STATE_VISUALS: Record<FleetAgentState, StateVisual> = {
	needs_attention: { glyph: "⚠", color: "warning" },
	running: { glyph: "●", color: "accent" },
	paused: { glyph: "‖", color: "warning", label: "paused" },
	stopped: { glyph: "■", color: "muted", label: "stopped" },
	completed: { glyph: "✓", color: "success", label: "done" },
	error: { glyph: "✗", color: "error", label: "error" },
};

export function sortFleetEntries(entries: FleetAgentEntry[]): FleetAgentEntry[] {
	return [...entries].sort((a, b) => {
		const rankDiff = STATE_RANK[a.state] - STATE_RANK[b.state];
		if (rankDiff !== 0) return rankDiff;
		return b.updatedAt - a.updatedAt;
	});
}

/**
 * Nachschlag mit Rueckfall. Die Vorgaengerfassung endete auf einem else-Zweig
 * und war damit total; ein Record-Zugriff waere es bei einem Zustandswert
 * ausserhalb der sechs bekannten nicht (TypeError beim Farbzugriff).
 */
function stateVisual(state: FleetAgentState): StateVisual {
	return STATE_VISUALS[state] ?? { glyph: "✗", color: "error", label: String(state) };
}

export function stateGlyph(state: FleetAgentState, theme: Theme): string {
	const visual = stateVisual(state);
	return theme.fg(visual.color, visual.glyph);
}

/**
 * Breite der festen Namensspalte. Skaliert mit der Terminalbreite, bleibt
 * aber fuer eine gegebene Breite konstant - dadurch stehen die Statusspalten
 * stabil untereinander, unabhaengig davon welche Agenten gerade laufen.
 * 80 -> 16, 120 -> 24, 160 -> 24 (gedeckelt).
 */
export function nameColumnWidth(width: number): number {
	return Math.max(12, Math.min(24, Math.floor(width * 0.2)));
}

/**
 * Kuerzt einen Pfad auf die letzten Segmente statt ihn am Zeilenende
 * abzuschneiden - der Dateiname ist die informationstragende Haelfte.
 */
export function compactPath(path: string, maxSegments = 2): string {
	const shortened = shortenPath(path);
	const segments = shortened.split("/").filter((segment) => segment.length > 0);
	if (segments.length <= maxSegments) return shortened;
	return `…/${segments.slice(-maxSegments).join("/")}`;
}

/** Ersetzt einen in Klammern eingebetteten Pfad (siehe pickActivityDetail) durch seine Kurzform. */
export function compactActivityDetail(detail: string): string {
	return detail.replace(/\(([^()]*\/[^()]*)\)/, (_match, path: string) => `(${compactPath(path)})`);
}

function fitDetail(detail: string, budget: number): string | undefined {
	const compact = compactActivityDetail(detail);
	if (compact.length <= budget) return compact;
	if (budget < MIN_DETAIL_WIDTH) return undefined;
	return `${compact.slice(0, budget - 1)}…`;
}

function fitName(name: string, cell: number): string {
	if (name.length > cell) return `${name.slice(0, Math.max(1, cell - 1))}…`;
	return name.padEnd(cell, " ");
}

/** Runtime and token values stay aligned so rows remain easy to scan. */
const STATS_DURATION_WIDTH = 6;
const STATS_TOKENS_WIDTH = 5;
const STATS_BLOCK_WIDTH = STATS_DURATION_WIDTH + SEPARATOR.length + STATS_TOKENS_WIDTH;
const STATS_GAP = 2;

/** Two spaces per nesting level make parent/child relationships visible. */
const INDENT_UNIT = "  ";

function statsBlockText(entry: FleetAgentEntry, now: number): string {
	const duration = formatDuration(Math.max(0, now - entry.startedAt)).padStart(STATS_DURATION_WIDTH, " ");
	const tokenTotal = entry.tokens ?? entry.tokenUsage?.total;
	const tokens = (tokenTotal !== undefined ? formatTokens(tokenTotal) : "").padStart(STATS_TOKENS_WIDTH, " ");
	return `${duration}${SEPARATOR}${tokens}`;
}

/**
 * Baut den linksbuendigen Mittelteil (Textlabel + Aktivitaetsbeschreibung).
 * Laufzeit/Tokens sind hier bewusst NICHT mehr enthalten (siehe statsBlockText).
 */
function middleZoneText(entry: FleetAgentEntry, budget: number): string {
	const visual = stateVisual(entry.state);
	const fixed: string[] = [];
	if (visual.label) fixed.push(visual.label);

	// pickActivityDetail() faellt ohne konkrete Taetigkeit auf den State-Namen
	// selbst zurueck - zusammen mit dem Textlabel ergaebe das "stopped · stopped".
	const rawDetail = entry.activityDetail ? entry.activityDetail : undefined;
	const meaningfulDetail = rawDetail !== undefined && rawDetail !== entry.state ? rawDetail : undefined;

	const fixedLength = fixed.reduce((sum, part) => sum + part.length + SEPARATOR.length, 0);
	const detail = meaningfulDetail !== undefined ? fitDetail(meaningfulDetail, budget - fixedLength) : undefined;

	const parts = [...fixed];
	if (detail !== undefined) parts.push(detail);
	// running ohne konkrete Taetigkeit hat weder Label noch Detail - dann bleibt
	// der rohe Zustand als schwaechste Stufe der Informationsprioritaet stehen.
	// Gleiches gilt, wenn das Budget fuer eine sinnvolle Kuerzung nicht reicht
	// (sehr schmale Terminals): lieber die eingedampfte Beschreibung zeigen und
	// truncLine() den Rest erledigen lassen als eine leere Mittelspalte.
	if (parts.length === 0 && rawDetail !== undefined) parts.push(compactActivityDetail(rawDetail));
	return parts.join(SEPARATOR);
}

export function entryLine(entry: FleetAgentEntry, now: number, theme: Theme, width: number): string {
	const nameCell = nameColumnWidth(width);
	const indent = INDENT_UNIT.repeat(entry.depth);
	const prefix = "  ";
	const glyph = stateGlyph(entry.state, theme);
	const nameText = fitName(entry.agent, nameCell);
	const name = nameText;

	const fixedLeftWidth = 2 /* Praefix */ + indent.length + 2 /* Glyphe + Leerzeichen */ + nameCell + 2 /* Luecke nach Namen */;
	const middleBudget = Math.max(0, width - fixedLeftWidth - STATS_BLOCK_WIDTH - STATS_GAP);

	// Attention is shown in warning color as well as with a distinct glyph.
	const partColor = entry.needsAttention ? "warning" : "dim";
	const middleText = middleZoneText(entry, middleBudget);
	// Auffuellung bewusst AUSSERHALB des theme.fg()-Aufrufs: die Farbmarkierung
	// umschliesst nur den sichtbaren Text, nicht die reinen Fuellzeichen davor
	// der Statsspalte.
	const middlePadding = " ".repeat(Math.max(0, middleBudget - middleText.length));
	const middle = `${theme.fg(partColor, middleText)}${middlePadding}`;
	const stats = theme.fg(partColor, statsBlockText(entry, now));

	return truncLine(`${prefix}${indent}${glyph} ${name}  ${middle}${" ".repeat(STATS_GAP)}${stats}`, width);
}

export interface RenderFleetDockOptions {
	width: number;
	theme: Theme;
	maxRows?: number;
	now?: number;
}

/**
 * Kopfzeile mit Zaehlern (CONCEPT.md-Zielbild: "AGENTS · 2 active · 1 needs
 * attention"). Der Attention-Zaehler erscheint nur, wenn es tatsaechlich einen
 * gibt, und wird als einziges Segment in "warning" gerendert.
 */
export function dockHeaderLine(entries: FleetAgentEntry[], theme: Theme, width: number): string {
	const activeCount = entries.filter((entry) => !TERMINAL_STATES.has(entry.state)).length;
	const attentionCount = entries.filter((entry) => entry.needsAttention || entry.state === "needs_attention").length;
	const segments = [theme.fg("dim", "AGENTS"), theme.fg("dim", `${activeCount} active`)];
	if (attentionCount > 0) segments.push(theme.fg("warning", `${attentionCount} needs attention`));
	const dot = theme.fg("dim", "·");
	return truncLine(`  ${segments.join(` ${dot} `)}`, width);
}

/**
 * Tastenkuerzelzeile. Zeigt nur Kuerzel, die auf den aktuell ausgewaehlten
 * Eintrag auch tatsaechlich wirken - dieselben Bedingungen wie im
 * FleetDockController (stop nur fuer stoppbare Async-Laeufe, dismiss nur fuer
 * terminale Top-Level-Eintraege).
 */
/**
 * Rendert die Fleet-Status-Dock-Zeilen aus einer bereits gebauten
 * FleetAgentEntry-Liste. Enthaelt keine Aufrufe von buildFleetEntries()
 * selbst - der Aufrufer (fleet-dock-controller.ts) ist fuer Beschaffung,
 * Throttling und Key-basierte Selektion zustaendig.
 */
export function renderFleetDock(entries: FleetAgentEntry[], opts: RenderFleetDockOptions): string[] {
	const { width, theme, maxRows = MAX_DOCK_ROWS, now = Date.now() } = opts;
	if (entries.length === 0) {
		return [truncLine(theme.fg("dim", "keine aktiven Subagenten"), width)];
	}
	const sorted = sortFleetEntries(entries);
	const visible = sorted.slice(0, maxRows);
	const hidden = sorted.slice(maxRows);
	const lines: string[] = [dockHeaderLine(sorted, theme, width)];
	for (const entry of visible) {
		lines.push(entryLine(entry, now, theme, width));
	}
	if (hidden.length > 0) {
		lines.push(truncLine(theme.fg("dim", `  +${hidden.length} weitere`), width));
	}
	return lines;
}
