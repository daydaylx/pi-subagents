/**
 * Fleet Status Dock – Rendering (PHASE-04, Aurora-Politur in PHASE-08).
 *
 * Reine Renderfunktion: FleetAgentEntry[] -> string[]. Kein I/O, kein
 * eigener Zustand (Auswahl/Expansion werden vom Aufrufer als Parameter
 * uebergeben). Analog zu buildWidgetLines() im alten Async-Widget
 * (../tui/render.ts), aber unabhaengig vom AsyncJobState-Typ.
 *
 * PHASE-06: needs_attention sortiert jetzt strikt vor running (eigener Rang,
 * nicht mehr gleichrangig+updatedAt-Tiebreak) - ein Attention-Eintrag soll
 * nicht mehr rein durch Alter unter die MAX_DOCK_ROWS-Sichtgrenze rutschen
 * und unmarkiert in der "+N weitere"-Zeile verschwinden koennen. Die
 * Aktivitaetszeile eines needsAttention-Eintrags wird zusaetzlich in
 * "warning" statt "dim" gerendert, statt sich allein auf das ⚠-Glyphenzeichen
 * zu verlassen.
 *
 * PHASE-08 (Aurora-UI, Darstellung - kein Verhaltenswechsel):
 * 1. Jeder Zustand hat ein EIGENES Glyphenzeichen. Vorher teilten sich
 *    paused und stopped "■" in derselben Farbe und waren damit ohne
 *    Farbunterscheidung ununterscheidbar - die Regel "Status nicht
 *    ausschliesslich ueber Farbe kommunizieren" war faktisch verletzt.
 *    Zusaetzlich traegt jeder Nicht-Running-Zustand ein ausgeschriebenes
 *    Textlabel in der Statuszeile.
 * 2. Die Auswahl wird ueber drei redundante Kanaele markiert: "›"-Praefix
 *    (Glyphe), Akzentfarbe und Fettdruck.
 * 3. Feste Namensspalte je Terminalbreite (nameColumnWidth) statt frei
 *    fliessender Namen: die Aktivitaetsspalte beginnt dadurch in jeder Zeile an
 *    derselben Stelle und wandert nicht mit der Namenslaenge.
 * 4. Budgetbasierte Kuerzung statt reinem Zeilenende-Abschnitt: Laufzeit und
 *    Tokenzahl sind fixe Bestandteile und ueberleben immer; nur die
 *    Aktivitaetsbeschreibung wird auf das verbleibende Budget gekuerzt.
 *    Pfade darin werden ueber compactPath() auf die letzten beiden Segmente
 *    eingedampft ("…/plan-mode/index.ts") statt am Zeilenende abgeschnitten.
 * 5. Kopfzeile mit Zaehlern und - nur bei Tastaturfokus - eine Zeile mit den
 *    tatsaechlich verfuegbaren Tastenkuerzeln (siehe CONCEPT.md-Zielbild).
 *    Ohne Fokus entfaellt die Kuerzelzeile und die Hinweise "↓ select" und
 *    "Super+↓ jump" (PHASE-09: bewusstes, editorunabhaengiges Kuerzel, siehe
 *    fleet-dock-controller.ts) stehen stattdessen in der Kopfzeile - der
 *    Fussabdruck waechst gegenueber PHASE-04 damit auch ohne Fokus um genau
 *    die eine Kopfzeile.
 *
 * PHASE-09 (Uebersichtlichkeit, Nutzerfeedback nach Live-Einsatz):
 * 1. Laufzeit und Tokenzahl standen bisher direkt hinter der
 *    Aktivitaetsbeschreibung und damit je nach deren Laenge an einer anderen
 *    Spaltenposition - senkrechtes Scannen/Vergleichen war nicht moeglich.
 *    Beide Werte stehen jetzt in einer eigenen, fest breiten,
 *    rechtsbuendigen Spalte (statsBlockText()) am Zeilenende, unabhaengig von
 *    der Aktivitaetstextlaenge und der Verschachtelungstiefe (siehe Punkt 3).
 *    Ersetzt die widersprochene Aussage aus PHASE-08-Punkt 3 oben.
 * 2. Zwischen Namensspalte und Mittelteil steht jetzt eine reine
 *    Leerraum-Luecke statt eines "·"-Trenners - eine Trennzeichenebene
 *    weniger pro Zeile fuer mehr visuelle Ruhe.
 * 3. Verschachtelte Eintraege (entry.depth > 0, von einem anderen Agenten
 *    gestartet) werden um zwei Leerzeichen pro Ebene eingerueckt (INDENT_UNIT)
 *    - die Eltern/Kind-Hierarchie ist damit direkt im Dock sichtbar, nicht
 *    mehr nur in der "children:"-Liste des Inspectors. Die Statsspalte bleibt
 *    dabei unveraendert am selben Zeilenende ausgerichtet (die Einrueckung
 *    geht zulasten des Mittelteil-Budgets, nicht der Statsspalte).
 *
 * Bewusst NICHT enthalten: Spinner, Ticker oder sonstige Animationen. Das
 * Dock rendert ausschliesslich aus dem uebergebenen Zustand (Anforderung
 * "Kein permanenter schneller Spinner fuer jede Agentenzeile").
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatTokens, shortenPath } from "../shared/formatters.ts";
import type { FleetAgentEntry, FleetAgentState } from "../runs/shared/fleet-projection.ts";
import { themeBold, truncLine } from "./render.ts";

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

/**
 * Feste, rechtsbuendige Statsspalte (Laufzeit · Tokens). PHASE-09: vorher
 * folgten Laufzeit und Tokenzahl direkt auf die Aktivitaetsbeschreibung und
 * standen dadurch in jeder Zeile an einer anderen Spaltenposition -
 * senkrechtes Scannen/Vergleichen war nicht moeglich (Nutzerfeedback). Beide
 * Werte werden jetzt einzeln auf eine feste Breite rechtsbuendig aufgefuellt,
 * sodass ihre Ziffern in jeder Zeile an derselben Stelle stehen, unabhaengig
 * von der Laenge der Aktivitaetsbeschreibung davor.
 */
const STATS_DURATION_WIDTH = 6;
const STATS_TOKENS_WIDTH = 5;
const STATS_BLOCK_WIDTH = STATS_DURATION_WIDTH + SEPARATOR.length + STATS_TOKENS_WIDTH;
const STATS_GAP = 2;

/** Zwei Leerzeichen pro Verschachtelungsebene (PHASE-09: sichtbare Eltern/Kind-Hierarchie im Dock selbst, nicht nur im Inspector). */
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

export function entryLine(entry: FleetAgentEntry, isSelected: boolean, now: number, theme: Theme, width: number): string {
	const nameCell = nameColumnWidth(width);
	const indent = INDENT_UNIT.repeat(entry.depth);
	const prefix = isSelected ? theme.fg("accent", "› ") : "  ";
	const glyph = stateGlyph(entry.state, theme);
	const nameText = fitName(entry.agent, nameCell);
	// Auswahl redundant markiert: Glyphe (›), Farbe (accent) und Fettdruck.
	const name = themeBold(theme, isSelected ? theme.fg("accent", nameText) : nameText);

	const fixedLeftWidth = 2 /* Praefix */ + indent.length + 2 /* Glyphe + Leerzeichen */ + nameCell + 2 /* Luecke nach Namen */;
	const middleBudget = Math.max(0, width - fixedLeftWidth - STATS_BLOCK_WIDTH - STATS_GAP);

	// PHASE-06: needsAttention faerbt Mittelteil und Statsspalte "warning" statt
	// "dim" - das Glyphenzeichen allein reicht nicht als deutliche Anzeige.
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

function detailLines(entry: FleetAgentEntry, theme: Theme, width: number): string[] {
	// PHASE-09: folgt der Einrueckung der Eintragszeile selbst, damit
	// aufgeklappte Details sichtbar unter einem eingerueckten Kind-Eintrag
	// stehen statt immer auf dieselbe Spalte zurueckzufallen.
	const indent = `      ${INDENT_UNIT.repeat(entry.depth)}`;
	const lines: string[] = [];
	// Wie in middleZoneText(): der reine State-Fallback aus pickActivityDetail()
	// ist hier keine zusaetzliche Information (das Glyphenzeichen und das
	// Textlabel der Statuszeile sagen dasselbe).
	if (entry.activityDetail && entry.activityDetail !== entry.state) {
		lines.push(truncLine(theme.fg("dim", `${indent}⎿  ${compactActivityDetail(entry.activityDetail)}`), width));
	}
	if (entry.tokenUsage) {
		lines.push(
			truncLine(
				theme.fg("dim", `${indent}tokens: ${formatTokens(entry.tokenUsage.input)} in / ${formatTokens(entry.tokenUsage.output)} out`),
				width,
			),
		);
	}
	if (entry.transcriptPath) {
		const staleSuffix = entry.transcriptPathMaybeStale ? " (moeglicherweise veraltet)" : "";
		lines.push(truncLine(theme.fg("dim", `${indent}transcript: ${compactPath(entry.transcriptPath, 3)}${staleSuffix}`), width));
	}
	return lines;
}

export interface RenderFleetDockOptions {
	width: number;
	theme: Theme;
	expandedKey?: string;
	maxRows?: number;
	now?: number;
	// PHASE-06: Key eines Eintrags mit ausstehender Stop-Bestaetigung (erstes
	// "s" wurde gedrueckt). Rendert eine explizite Bestaetigungszeile direkt
	// unter dem betroffenen Eintrag.
	stopArmedKey?: string;
	// PHASE-08: true, waehrend das Dock Tastaturfokus haelt
	// (FleetDockController.isActive()). Nur dann wird die Tastenkuerzelzeile
	// gerendert - ohne Fokus waere sie irrefuehrend und kostet nur Hoehe.
	active?: boolean;
}

function stopConfirmLine(entry: FleetAgentEntry, theme: Theme, width: number): string {
	const indent = `      ${INDENT_UNIT.repeat(entry.depth)}`;
	return truncLine(theme.fg("warning", `${indent}Stop bestaetigen: erneut 's' druecken (Escape zum Abbrechen)`), width);
}

/**
 * Kopfzeile mit Zaehlern (CONCEPT.md-Zielbild: "AGENTS · 2 active · 1 needs
 * attention"). Der Attention-Zaehler erscheint nur, wenn es tatsaechlich einen
 * gibt, und wird als einziges Segment in "warning" gerendert.
 */
export function dockHeaderLine(entries: FleetAgentEntry[], theme: Theme, width: number, active: boolean): string {
	const activeCount = entries.filter((entry) => !TERMINAL_STATES.has(entry.state)).length;
	const attentionCount = entries.filter((entry) => entry.needsAttention || entry.state === "needs_attention").length;
	const segments = [theme.fg("dim", "AGENTS"), theme.fg("dim", `${activeCount} active`)];
	if (attentionCount > 0) segments.push(theme.fg("warning", `${attentionCount} needs attention`));
	if (!active) segments.push(theme.fg("dim", "↓ select"), theme.fg("dim", "Super+↓ jump"));
	const dot = theme.fg("dim", "·");
	return truncLine(`  ${segments.join(` ${dot} `)}`, width);
}

/**
 * Tastenkuerzelzeile. Zeigt nur Kuerzel, die auf den aktuell ausgewaehlten
 * Eintrag auch tatsaechlich wirken - dieselben Bedingungen wie im
 * FleetDockController (stop nur fuer stoppbare Async-Laeufe, dismiss nur fuer
 * terminale Top-Level-Eintraege).
 */
export function dockHintLine(selected: FleetAgentEntry | undefined, theme: Theme, width: number): string {
	const hints = ["↑↓ select", "enter inspect"];
	if (selected && selected.source === "async" && selected.canStop && selected.asyncDir) hints.push("s stop");
	if (selected && selected.depth === 0 && TERMINAL_STATES.has(selected.state)) hints.push("d dismiss");
	hints.push("esc back");
	return truncLine(theme.fg("dim", `  ${hints.join(SEPARATOR)}`), width);
}

/**
 * Rendert die Fleet-Status-Dock-Zeilen aus einer bereits gebauten
 * FleetAgentEntry-Liste. Enthaelt keine Aufrufe von buildFleetEntries()
 * selbst - der Aufrufer (fleet-dock-controller.ts) ist fuer Beschaffung,
 * Throttling und Key-basierte Selektion zustaendig.
 */
export function renderFleetDock(entries: FleetAgentEntry[], selectedKey: string | undefined, opts: RenderFleetDockOptions): string[] {
	const { width, theme, expandedKey, maxRows = MAX_DOCK_ROWS, now = Date.now(), stopArmedKey, active = false } = opts;
	if (entries.length === 0) {
		return [truncLine(theme.fg("dim", "keine aktiven Subagenten"), width)];
	}
	const sorted = sortFleetEntries(entries);
	const visible = sorted.slice(0, maxRows);
	const hidden = sorted.slice(maxRows);
	const lines: string[] = [dockHeaderLine(sorted, theme, width, active)];
	for (const entry of visible) {
		lines.push(entryLine(entry, entry.key === selectedKey, now, theme, width));
		if (expandedKey === entry.key) lines.push(...detailLines(entry, theme, width));
		if (stopArmedKey === entry.key) lines.push(stopConfirmLine(entry, theme, width));
	}
	if (hidden.length > 0) {
		lines.push(truncLine(theme.fg("dim", `  +${hidden.length} weitere`), width));
	}
	if (active) {
		lines.push(dockHintLine(sorted.find((entry) => entry.key === selectedKey), theme, width));
	}
	return lines;
}
