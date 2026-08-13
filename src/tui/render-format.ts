/**
 * Low-level text, animation, and stat formatting helpers shared by widget and result rendering.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentProgress, Details } from "../shared/types.ts";
import {
  formatDuration,
  formatModelThinking,
  formatToolCall,
  formatTokens,
} from "../shared/formatters.ts";
import { getDisplayItems } from "../shared/utils.ts";
import { formatActivityLabel } from "../shared/status-format.ts";

export type Theme = ExtensionContext["ui"]["theme"];

export function liveDetailKeyText(): string {
  return keyText("app.tools.expand");
}

export function liveDetailHintText(): string {
  return `Press ${liveDetailKeyText()} for live detail`;
}

export function getTermWidth(): number {
  return process.stdout.columns || 120;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 *
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 *
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 */
export function truncLine(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;

  const targetWidth = maxWidth - 1;
  let result = "";
  let currentWidth = 0;
  let activeStyles: string[] = [];
  let i = 0;

  while (i < text.length) {
    const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (ansiMatch) {
      const code = ansiMatch[0];
      result += code;

      if (code === "\x1b[0m" || code === "\x1b[m") {
        activeStyles = [];
      } else {
        activeStyles.push(code);
      }
      i += code.length;
      continue;
    }

    let end = i;
    while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
      end++;
    }

    const textPortion = text.slice(i, end);
    for (const seg of segmenter.segment(textPortion)) {
      const grapheme = seg.segment;
      const graphemeWidth = visibleWidth(grapheme);

      if (currentWidth + graphemeWidth > targetWidth) {
        return result + activeStyles.join("") + "…";
      }

      result += grapheme;
      currentWidth += graphemeWidth;
    }
    i = end;
  }

  return result + activeStyles.join("") + "…";
}

export function wrapPlainText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const seg of segmenter.segment(rawLine)) {
      const grapheme = seg.segment;
      const graphemeWidth = visibleWidth(grapheme);
      if (currentWidth > 0 && currentWidth + graphemeWidth > maxWidth) {
        lines.push(current);
        current = grapheme;
        currentWidth = graphemeWidth;
        continue;
      }
      current += grapheme;
      currentWidth += graphemeWidth;
    }
    lines.push(current);
  }
  return lines;
}

export const RUNNING_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];
const STATIC_RUNNING_GLYPH = "●";

export type ProgressSeedSource = Partial<
  Pick<
    AgentProgress,
    | "index"
    | "toolCount"
    | "tokens"
    | "durationMs"
    | "lastActivityAt"
    | "currentToolStartedAt"
    | "turnCount"
  >
>;

export function runningSeed(
  ...values: Array<number | undefined>
): number | undefined {
  let seed: number | undefined;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) continue;
    seed = (seed ?? 0) + Math.trunc(value);
  }
  return seed;
}

export function runningGlyph(seed?: number): string {
  if (seed === undefined) return STATIC_RUNNING_GLYPH;
  return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

export function progressRunningSeed(
  progress: ProgressSeedSource | undefined,
): number | undefined {
  if (!progress) return undefined;
  return runningSeed(
    progress.index,
    progress.toolCount,
    progress.tokens,
    progress.durationMs,
    progress.lastActivityAt,
    progress.currentToolStartedAt,
    progress.turnCount,
  );
}

interface LegacyResultAnimationContext {
  state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> };
}

export function clearLegacyResultAnimationTimer(
  context: LegacyResultAnimationContext,
): void {
  const timer = context.state.subagentResultAnimationTimer;
  if (!timer) return;
  clearInterval(timer);
  context.state.subagentResultAnimationTimer = undefined;
}

export function extractOutputTarget(task: string): string | undefined {
  const writeToMatch = task.match(/\[Write to:\s*([^\]\n]+)\]/i);
  if (writeToMatch?.[1]?.trim()) return writeToMatch[1].trim();
  const findingsMatch = task.match(
    /Write your findings to(?: exactly this path)?:\s*([^\r\n]+)/i,
  );
  if (findingsMatch?.[1]?.trim()) return findingsMatch[1].trim();
  const outputMatch = task.match(/[Oo]utput(?:\s+to)?\s*:\s*(\S+)/i);
  if (outputMatch?.[1]?.trim()) return outputMatch[1].trim();
  return undefined;
}

export function hasEmptyTextOutputWithoutOutputTarget(
  task: string,
  output: string,
): boolean {
  if (output.trim()) return false;
  return !extractOutputTarget(task);
}

export function getToolCallLines(
  result: Pick<Details["results"][number], "messages" | "toolCalls">,
  expanded: boolean,
): string[] {
  if (result.messages) {
    return getDisplayItems(result.messages)
      .filter(
        (
          item,
        ): item is {
          type: "tool";
          name: string;
          args: Record<string, unknown>;
        } => item.type === "tool",
      )
      .map((item) => formatToolCall(item.name, item.args, expanded));
  }
  return (
    result.toolCalls?.map((toolCall) =>
      expanded ? toolCall.expandedText : toolCall.text,
    ) ?? []
  );
}

export function snapshotNowForProgress(
  progress: Pick<
    AgentProgress,
    "currentToolStartedAt" | "durationMs" | "lastActivityAt"
  >,
): number | undefined {
  if (
    progress.currentToolStartedAt !== undefined &&
    progress.durationMs !== undefined
  )
    return progress.currentToolStartedAt + progress.durationMs;
  return progress.lastActivityAt;
}

export function formatCurrentToolLine(
  progress: Pick<
    AgentProgress,
    "currentTool" | "currentToolArgs" | "currentToolStartedAt"
  >,
  availableWidth: number,
  expanded: boolean,
  snapshotNow?: number,
): string | undefined {
  if (!progress.currentTool) return undefined;
  const maxToolArgsLen = Math.max(50, availableWidth - 20);
  const toolArgsPreview = progress.currentToolArgs
    ? expanded || progress.currentToolArgs.length <= maxToolArgsLen
      ? progress.currentToolArgs
      : `${progress.currentToolArgs.slice(0, maxToolArgsLen)}...`
    : "";
  const durationSuffix =
    progress.currentToolStartedAt !== undefined && snapshotNow !== undefined
      ? ` | ${formatDuration(Math.max(0, snapshotNow - progress.currentToolStartedAt))}`
      : "";
  return toolArgsPreview
    ? `${progress.currentTool}: ${toolArgsPreview}${durationSuffix}`
    : `${progress.currentTool}${durationSuffix}`;
}

export function buildLiveStatusLine(
  progress: Pick<AgentProgress, "activityState" | "lastActivityAt">,
  snapshotNow?: number,
): string | undefined {
  if (progress.lastActivityAt !== undefined && snapshotNow !== undefined)
    return formatActivityLabel(
      progress.lastActivityAt,
      progress.activityState,
      snapshotNow,
    );
  if (progress.activityState === "needs_attention") return "needs attention";
  if (progress.activityState === "active_long_running")
    return "active but long-running";
  if (progress.lastActivityAt !== undefined) return "active";
  return undefined;
}

export function themeBold(theme: Theme, text: string): string {
  return (theme as { bold?: (value: string) => string }).bold?.(text) ?? text;
}

export function statJoin(theme: Theme, parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part) => theme.fg("dim", part))
    .join(` ${theme.fg("dim", "·")} `);
}

export function formatTokenStat(tokens: number): string {
  return `${formatTokens(tokens)} token`;
}

export function formatToolUseStat(count: number): string {
  return `${count} tool use${count === 1 ? "" : "s"}`;
}

export function formatTotalCostStat(
  totalCost: Details["totalCost"] | undefined,
): string {
  if (
    !totalCost ||
    (totalCost.inputTokens === 0 &&
      totalCost.outputTokens === 0 &&
      totalCost.costUsd === 0)
  )
    return "";
  const parts: string[] = [];
  if (totalCost.inputTokens)
    parts.push(`in:${formatTokens(totalCost.inputTokens)}`);
  if (totalCost.outputTokens)
    parts.push(`out:${formatTokens(totalCost.outputTokens)}`);
  if (totalCost.costUsd) parts.push(`$${totalCost.costUsd.toFixed(4)}`);
  return parts.join(" ");
}

export function formatProgressStats(
  theme: Theme,
  progress:
    Pick<AgentProgress, "toolCount" | "tokens" | "durationMs"> | undefined,
  includeDuration = true,
): string {
  if (!progress) return "";
  const parts: string[] = [];
  if (progress.toolCount > 0) parts.push(formatToolUseStat(progress.toolCount));
  if (progress.tokens > 0) parts.push(formatTokenStat(progress.tokens));
  if (includeDuration && progress.durationMs > 0)
    parts.push(formatDuration(progress.durationMs));
  return statJoin(theme, parts);
}

export function firstOutputLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

export function resultStatusLine(
  result: Details["results"][number],
  output: string,
): string {
  if (result.detached)
    return result.detachedReason
      ? `Detached: ${result.detachedReason}`
      : "Detached";
  if (result.stopped) return "Stopped";
  if (result.interrupted) return "Paused";
  if (result.exitCode !== 0)
    return `Error: ${result.error ?? (firstOutputLine(output) || `exit ${result.exitCode}`)}`;
  if (result.acceptance?.status && result.acceptance.status !== "not-required")
    return `Done · acceptance: ${result.acceptance.status}`;
  if (hasEmptyTextOutputWithoutOutputTarget(result.task, output))
    return "Done (no text output)";
  return "Done";
}

export function resultGlyph(
  result: Details["results"][number],
  output: string,
  theme: Theme,
  running = result.progress?.status === "running",
  seed = progressRunningSeed(result.progress ?? result.progressSummary),
  frame?: number,
): string {
  if (running) {
    if (frame !== undefined)
      return theme.fg("accent", runningGlyph((seed ?? 0) + frame));
    return theme.fg("accent", runningGlyph(seed));
  }
  if (result.detached) return theme.fg("warning", "■");
  if (result.stopped) return theme.fg("warning", "■");
  if (result.interrupted) return theme.fg("warning", "■");
  if (result.exitCode !== 0) return theme.fg("error", "✗");
  if (hasEmptyTextOutputWithoutOutputTarget(result.task, output))
    return theme.fg("warning", "✓");
  return theme.fg("success", "✓");
}

export function compactCurrentActivity(progress: AgentProgress): string {
  const snapshotNow = snapshotNowForProgress(progress);
  return (
    formatCurrentToolLine(progress, getTermWidth() - 4, false, snapshotNow) ??
    buildLiveStatusLine(progress, snapshotNow) ??
    "thinking…"
  );
}

export function modelThinkingBadge(
  theme: Theme,
  model?: string,
  thinking?: string,
): string {
  const label = formatModelThinking(model, thinking);
  return label ? theme.fg("dim", ` (${label})`) : "";
}
