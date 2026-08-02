/**
 * Fleet Status Dock – Rendering (PHASE-04).
 *
 * Reine Renderfunktion: FleetAgentEntry[] -> string[]. Kein I/O, kein
 * eigener Zustand (Auswahl/Expansion werden vom Aufrufer als Parameter
 * uebergeben). Analog zu buildWidgetLines() im alten Async-Widget
 * (../tui/render.ts), aber unabhaengig vom AsyncJobState-Typ.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatTokens, shortenPath } from "../shared/formatters.ts";
import type { FleetAgentEntry, FleetAgentState } from "../runs/shared/fleet-projection.ts";
import { themeBold, truncLine } from "./render.ts";

type Theme = ExtensionContext["ui"]["theme"];

export const MAX_DOCK_ROWS = 6;

// Sortier-Rang: needs_attention und running zuerst (gleichrangig, danach nach
// updatedAt sortiert), dann paused, dann alle Terminalzustaende zuletzt.
const STATE_RANK: Record<FleetAgentState, number> = {
	needs_attention: 0,
	running: 0,
	paused: 1,
	completed: 2,
	error: 2,
	stopped: 2,
};

export function sortFleetEntries(entries: FleetAgentEntry[]): FleetAgentEntry[] {
	return [...entries].sort((a, b) => {
		const rankDiff = STATE_RANK[a.state] - STATE_RANK[b.state];
		if (rankDiff !== 0) return rankDiff;
		return b.updatedAt - a.updatedAt;
	});
}

export function stateGlyph(state: FleetAgentState, theme: Theme): string {
	if (state === "needs_attention") return theme.fg("warning", "⚠");
	if (state === "running") return theme.fg("accent", "●");
	if (state === "paused") return theme.fg("warning", "■");
	if (state === "stopped") return theme.fg("warning", "■");
	if (state === "completed") return theme.fg("success", "✓");
	return theme.fg("error", "✗");
}

function entryStats(entry: FleetAgentEntry, now: number, theme: Theme): string {
	const parts: string[] = [];
	if (entry.activityDetail) parts.push(entry.activityDetail);
	parts.push(formatDuration(Math.max(0, now - entry.startedAt)));
	const tokenTotal = entry.tokens ?? entry.tokenUsage?.total;
	if (tokenTotal !== undefined) parts.push(formatTokens(tokenTotal));
	if (parts.length === 0) return "";
	const dot = theme.fg("dim", "·");
	return ` ${dot} ${parts.map((part) => theme.fg("dim", part)).join(` ${dot} `)}`;
}

export function entryLine(entry: FleetAgentEntry, isSelected: boolean, now: number, theme: Theme, width: number): string {
	const prefix = isSelected ? theme.fg("accent", "› ") : "  ";
	const glyph = stateGlyph(entry.state, theme);
	const name = themeBold(theme, entry.agent);
	return truncLine(`${prefix}${glyph} ${name}${entryStats(entry, now, theme)}`, width);
}

function detailLines(entry: FleetAgentEntry, theme: Theme, width: number): string[] {
	const lines: string[] = [];
	if (entry.activityDetail) {
		lines.push(truncLine(theme.fg("dim", `      ⎿  ${entry.activityDetail}`), width));
	}
	if (entry.tokenUsage) {
		lines.push(
			truncLine(
				theme.fg("dim", `      tokens: ${formatTokens(entry.tokenUsage.input)} in / ${formatTokens(entry.tokenUsage.output)} out`),
				width,
			),
		);
	}
	if (entry.transcriptPath) {
		const staleSuffix = entry.transcriptPathMaybeStale ? " (moeglicherweise veraltet)" : "";
		lines.push(truncLine(theme.fg("dim", `      transcript: ${shortenPath(entry.transcriptPath)}${staleSuffix}`), width));
	}
	return lines;
}

export interface RenderFleetDockOptions {
	width: number;
	theme: Theme;
	expandedKey?: string;
	maxRows?: number;
	now?: number;
}

/**
 * Rendert die Fleet-Status-Dock-Zeilen aus einer bereits gebauten
 * FleetAgentEntry-Liste. Enthaelt keine Aufrufe von buildFleetEntries()
 * selbst - der Aufrufer (fleet-dock-controller.ts) ist fuer Beschaffung,
 * Throttling und Key-basierte Selektion zustaendig.
 */
export function renderFleetDock(entries: FleetAgentEntry[], selectedKey: string | undefined, opts: RenderFleetDockOptions): string[] {
	const { width, theme, expandedKey, maxRows = MAX_DOCK_ROWS, now = Date.now() } = opts;
	if (entries.length === 0) {
		return [truncLine(theme.fg("dim", "keine aktiven Subagenten"), width)];
	}
	const sorted = sortFleetEntries(entries);
	const visible = sorted.slice(0, maxRows);
	const hidden = sorted.slice(maxRows);
	const lines: string[] = [];
	for (const entry of visible) {
		lines.push(entryLine(entry, entry.key === selectedKey, now, theme, width));
		if (expandedKey === entry.key) lines.push(...detailLines(entry, theme, width));
	}
	if (hidden.length > 0) {
		lines.push(truncLine(theme.fg("dim", `  +${hidden.length} weitere`), width));
	}
	return lines;
}
