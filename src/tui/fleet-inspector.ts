/**
 * Fleet Inspector – Rendering (PHASE-05).
 *
 * Reine Renderfunktion, analog zu renderFleetDock() (fleet-dock.ts): nimmt
 * einen bereits aufgeloesten FleetAgentEntry, seine Kinder und ein bereits
 * gelesenes Transcript entgegen, kein I/O, kein eigener Zustand (Scroll-
 * Position/Expand-Flag kommen vom Aufrufer). Wiederverwendet stateGlyph()/
 * entryLine() aus fleet-dock.ts fuer die Children-Zeilen, damit sie optisch
 * identisch zu Dock-Zeilen sind.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatTokens } from "../shared/formatters.ts";
import type { FleetAgentEntry, FleetAttentionReason } from "../runs/shared/fleet-projection.ts";
import type { TranscriptEvent } from "../runs/shared/fleet-transcript-reader.ts";
import { compactActivityDetail, entryLine, stateGlyph } from "./fleet-dock.ts";
import { modelThinkingBadge, statJoin, themeBold, truncLine } from "./render.ts";

type Theme = ExtensionContext["ui"]["theme"];

export const DEFAULT_INSPECTOR_MAX_VISIBLE_LINES = 20;
export const MAX_INSPECTOR_CHILDREN_ROWS = 5;

export interface InspectorTranscriptView {
	events: TranscriptEvent[];
	truncated: boolean;
	error?: string;
}

export interface RenderFleetInspectorOptions {
	width: number;
	theme: Theme;
	scrollFromBottom: number;
	toolDetailsExpanded: boolean;
	maxVisibleLines?: number;
	now?: number;
	// PHASE-06: true, waehrend fuer den offenen Eintrag eine Stop-Bestaetigung
	// aussteht (erstes "s" wurde gedrueckt, siehe fleet-inspector-controller.ts).
	stopArmed?: boolean;
}

const ATTENTION_REASON_TEXT: Record<FleetAttentionReason, string> = {
	control_notice: "control notice",
	watchdog_reviewing: "watchdog reviewing",
	watchdog_stalled: "watchdog stalled",
	supervisor_pending: "waiting for supervisor decision",
};

function toolStatusGlyph(event: TranscriptEvent & { type: "tool" }, theme: Theme): string {
	if (event.toolState === "running") return "\u2026";
	if (event.toolState === "awaiting_result") return "(laeuft)";
	return event.isError ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
}

function eventLines(event: TranscriptEvent, theme: Theme, width: number, toolDetailsExpanded: boolean): string[] {
	if (event.type === "user") {
		return [truncLine(`${theme.fg("dim", "user:")} ${event.text}`, width)];
	}

	if (event.type === "assistant") {
		const errorSuffix = event.errorMessage ? theme.fg("error", ` (${event.errorMessage})`) : "";
		return [truncLine(`${theme.fg("dim", "assistant:")} ${event.text}${errorSuffix}`, width)];
	}

	if (event.type === "tool") {
		const duration = event.startTs !== undefined && event.endTs !== undefined ? ` ${formatDuration(Math.max(0, event.endTs - event.startTs))}` : "";
		const argsSuffix = event.argsPreview ? ` (${event.argsPreview})` : "";
		const compact = truncLine(`${theme.fg("dim", "tool:")} ${event.toolName}${argsSuffix} ${toolStatusGlyph(event, theme)}${duration}`, width);
		if (!toolDetailsExpanded) return [compact];
		const resultLine = truncLine(theme.fg("dim", `      \u23bf ${event.resultText ?? "(kein Ergebnis)"}`), width);
		return [compact, resultLine];
	}

	// notice
	const color = event.kind === "stderr" ? "warning" : "dim";
	return [truncLine(theme.fg(color, event.text), width)];
}

/**
 * Rendert die Inspector-Zeilen fuer einen ausgewaehlten Agenten. entry
 * undefined bedeutet: der zuvor geoeffnete Lauf ist inzwischen aus der
 * Fleet-Liste verschwunden (abgeschlossen und aus der Retention gefallen).
 * Die live needsAttention/attentionReason von entry fliesst NUR hier ein
 * (eigene Kopfzeile) - sie ist kein TranscriptEvent, da sie ein aktueller
 * Zustand und kein historisches Transcript-Faktum ist.
 */
export function renderFleetInspector(
	entry: FleetAgentEntry | undefined,
	children: FleetAgentEntry[],
	transcript: InspectorTranscriptView,
	opts: RenderFleetInspectorOptions,
): string[] {
	const { width, theme, toolDetailsExpanded } = opts;
	const now = opts.now ?? Date.now();
	const maxVisibleLines = opts.maxVisibleLines ?? DEFAULT_INSPECTOR_MAX_VISIBLE_LINES;

	if (!entry) {
		return [truncLine(theme.fg("dim", "Agent nicht mehr verfuegbar."), width)];
	}

	const lines: string[] = [];

	const location = `${entry.source} \u00b7 run ${entry.runId}${entry.childIndex !== undefined ? ` \u00b7 child ${entry.childIndex}` : ""}`;
	lines.push(truncLine(`${stateGlyph(entry.state, theme)} ${themeBold(theme, entry.agent)}  (${location})`, width));

	const badge = modelThinkingBadge(theme, entry.model, entry.thinking);
	if (badge) lines.push(truncLine(badge.trimStart(), width));

	if (entry.description) lines.push(truncLine(theme.fg("dim", entry.description), width));

	const tokenTotal = entry.tokens ?? entry.tokenUsage?.total;
	const statsLine = statJoin(theme, [
		entry.state,
		formatDuration(Math.max(0, now - entry.startedAt)),
		entry.turnCount !== undefined ? `${entry.turnCount} turns` : "",
		entry.toolCount !== undefined ? `${entry.toolCount} tools` : "",
		tokenTotal !== undefined ? `${formatTokens(tokenTotal)} tok` : "",
		// PHASE-08: gleiche Pfadkuerzung wie im Dock, damit Dock- und
		// Inspector-Statuszeile identisch aussehen.
		entry.activityDetail !== undefined ? compactActivityDetail(entry.activityDetail) : "",
	]);
	if (statsLine) lines.push(truncLine(statsLine, width));

	if (entry.needsAttention || entry.state === "error") {
		const reasonText = (entry.attentionReason ? ATTENTION_REASON_TEXT[entry.attentionReason] : undefined) ?? (entry.state === "error" ? "error" : "needs attention");
		const color = entry.state === "error" ? "error" : "warning";
		lines.push(truncLine(theme.fg(color, `\u26a0 ${reasonText}`), width));
	}

	if (opts.stopArmed) {
		lines.push(truncLine(theme.fg("warning", "Stop bestaetigen: erneut 's' druecken (Escape zum Abbrechen)"), width));
	}

	if (children.length > 0) {
		const visibleChildren = children.slice(0, MAX_INSPECTOR_CHILDREN_ROWS);
		const hiddenChildren = children.slice(MAX_INSPECTOR_CHILDREN_ROWS);
		lines.push(truncLine(theme.fg("dim", "children:"), width));
		for (const child of visibleChildren) lines.push(entryLine(child, false, now, theme, width));
		if (hiddenChildren.length > 0) lines.push(truncLine(theme.fg("dim", `  +${hiddenChildren.length} weitere`), width));
	}

	const truncatedSuffix = transcript.truncated ? " (gekuerzt)" : "";
	lines.push(truncLine(themeBold(theme, `Live-Transcript${truncatedSuffix}:`), width));

	if (transcript.error) {
		lines.push(truncLine(theme.fg("error", transcript.error), width));
	} else {
		const allLines = transcript.events.flatMap((event) => eventLines(event, theme, width, toolDetailsExpanded));
		if (allLines.length === 0) {
			lines.push(truncLine(theme.fg("dim", "keine Ereignisse"), width));
		} else {
			const effectiveScroll = Math.min(Math.max(0, opts.scrollFromBottom), Math.max(0, allLines.length - maxVisibleLines));
			const windowStart = Math.max(0, allLines.length - maxVisibleLines - effectiveScroll);
			const windowEnd = Math.min(allLines.length, windowStart + maxVisibleLines);
			lines.push(...allLines.slice(windowStart, windowEnd));
			if (allLines.length > maxVisibleLines) {
				lines.push(truncLine(theme.fg("dim", `[${windowStart + 1}\u2013${windowEnd} / ${allLines.length}]`), width));
			}
		}
	}

	const stopHint = entry.source === "async" && entry.canStop ? " \u00b7 s stop" : "";
	lines.push(
		truncLine(
			theme.fg(
				"dim",
				`\u2191\u2193 scroll \u00b7 PgUp/PgDn page \u00b7 Space ${toolDetailsExpanded ? "collapse" : "expand"} tool details${stopHint} \u00b7 Esc close`,
			),
			width,
		),
	);

	return lines;
}
