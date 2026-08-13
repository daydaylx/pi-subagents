/**
 * Adaptive layout/session tracking for the async-jobs widget and its terminal entry points.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import {
  MAX_WIDGET_JOBS,
  WIDGET_KEY,
  type AsyncJobState,
} from "../shared/types.ts";
import { formatAgentRunningLabel } from "../shared/status-format.ts";
import {
  getTermWidth,
  liveDetailKeyText,
  runningGlyph,
  themeBold,
  truncLine,
  type Theme,
} from "./render-format.ts";
import {
  buildSingleWidgetLines,
  compactSingleWidgetLines,
  widgetActivity,
  widgetJobName,
  widgetJobsRunningSeed,
  widgetParallelAgentDetails,
  widgetStatusGlyph,
  widgetStats,
} from "./render-widget-core.ts";

type WidgetRenderTier = "full" | "single-line" | "progressive";

interface WidgetLayoutSession {
  expanded: boolean;
  rows: number;
  columns: number;
  tier: WidgetRenderTier;
  lockedRows?: number;
  visibleJobKeys: string[];
}

const RESERVED_NON_WIDGET_ROWS = 19;

let widgetLayoutSession: WidgetLayoutSession | undefined;

function resetWidgetLayoutSession(): void {
  widgetLayoutSession = undefined;
}

function estimateAvailableWidgetRows(): number {
  const rows = process.stdout.rows || 30;
  return Math.max(1, rows - RESERVED_NON_WIDGET_ROWS);
}

function currentTerminalRows(): number {
  return process.stdout.rows || 30;
}

function currentTerminalColumns(): number {
  return process.stdout.columns || 120;
}

function widgetSessionMatches(expanded: boolean): boolean {
  return (
    widgetLayoutSession?.expanded === expanded &&
    widgetLayoutSession.rows === currentTerminalRows() &&
    widgetLayoutSession.columns === currentTerminalColumns()
  );
}

function widgetHeaderCounts(jobs: AsyncJobState[]): {
  running: AsyncJobState[];
  queued: AsyncJobState[];
  complete: AsyncJobState[];
  failed: AsyncJobState[];
  paused: AsyncJobState[];
  stopped: AsyncJobState[];
} {
  return {
    running: jobs.filter((job) => job.status === "running"),
    queued: jobs.filter((job) => job.status === "queued"),
    complete: jobs.filter((job) => job.status === "complete"),
    failed: jobs.filter((job) => job.status === "failed"),
    paused: jobs.filter((job) => job.status === "paused"),
    stopped: jobs.filter((job) => job.status === "stopped"),
  };
}

function buildSingleLineWidgetLines(
  jobs: AsyncJobState[],
  theme: Theme,
  width: number,
): string[] {
  const counts = widgetHeaderCounts(jobs);
  const hasActive = counts.running.length > 0 || counts.queued.length > 0;
  const glyph =
    counts.running.length > 0
      ? runningGlyph(widgetJobsRunningSeed(counts.running))
      : hasActive
        ? "●"
        : "○";
  const parts: string[] = [];
  if (counts.running.length > 0)
    parts.push(`${counts.running.length}/${jobs.length} running`);
  if (counts.queued.length > 0) parts.push(`${counts.queued.length} queued`);
  if (counts.failed.length > 0) parts.push(`${counts.failed.length} failed`);
  if (counts.stopped.length > 0) parts.push(`${counts.stopped.length} stopped`);
  if (counts.paused.length > 0) parts.push(`${counts.paused.length} paused`);
  if (!hasActive && counts.complete.length > 0)
    parts.push(`${counts.complete.length}/${jobs.length} done`);
  return [
    truncLine(
      `${theme.fg(hasActive ? "accent" : "dim", glyph)} ${theme.fg(hasActive ? "accent" : "dim", "subagents")} (${parts.join(", ") || `${jobs.length} total`})`,
      width,
    ),
  ];
}

function orderedWidgetJobs(jobs: AsyncJobState[]): AsyncJobState[] {
  return [
    ...jobs.filter((job) => job.status === "running"),
    ...jobs.filter((job) => job.status === "queued"),
    ...jobs.filter(
      (job) => job.status !== "running" && job.status !== "queued",
    ),
  ];
}

function progressiveJobKey(job: AsyncJobState): string {
  return job.asyncId;
}

function isProgressiveActiveJob(job: AsyncJobState | undefined): boolean {
  return job?.status === "running" || job?.status === "queued";
}

function selectProgressiveJobKeys(
  jobs: AsyncJobState[],
  previousKeys: string[],
  bodyRows: number,
): string[] {
  if (bodyRows <= 0) return [];
  const jobsByKey = new Map(jobs.map((job) => [progressiveJobKey(job), job]));
  const selected: string[] = [];
  const append = (key: string): void => {
    if (selected.includes(key) || !jobsByKey.has(key)) return;
    selected.push(key);
  };
  for (const key of previousKeys) {
    if (!isProgressiveActiveJob(jobsByKey.get(key))) continue;
    append(key);
    if (selected.length >= bodyRows) return selected;
  }
  for (const job of orderedWidgetJobs(jobs)) {
    if (!isProgressiveActiveJob(job)) continue;
    const key = progressiveJobKey(job);
    append(key);
    if (selected.length >= bodyRows) break;
  }
  if (selected.length >= bodyRows) return selected;
  for (const key of previousKeys) {
    if (isProgressiveActiveJob(jobsByKey.get(key))) continue;
    append(key);
    if (selected.length >= bodyRows) return selected;
  }
  for (const job of orderedWidgetJobs(jobs)) {
    const key = progressiveJobKey(job);
    append(key);
    if (selected.length >= bodyRows) break;
  }
  return selected;
}

function progressiveHeaderLine(
  jobs: AsyncJobState[],
  theme: Theme,
  width: number,
): string {
  const counts = widgetHeaderCounts(jobs);
  const hasActive = counts.running.length > 0 || counts.queued.length > 0;
  const glyph =
    counts.running.length > 0
      ? runningGlyph(widgetJobsRunningSeed(counts.running))
      : hasActive
        ? "●"
        : "○";
  const parts: string[] = [];
  if (counts.running.length > 0)
    parts.push(formatAgentRunningLabel(counts.running.length));
  if (counts.queued.length > 0) parts.push(`${counts.queued.length} queued`);
  if (!hasActive) {
    if (counts.failed.length > 0) parts.push(`${counts.failed.length} failed`);
    if (counts.stopped.length > 0)
      parts.push(`${counts.stopped.length} stopped`);
    if (counts.paused.length > 0) parts.push(`${counts.paused.length} paused`);
    if (counts.complete.length > 0)
      parts.push(`${counts.complete.length}/${jobs.length} done`);
  }
  return truncLine(
    `${theme.fg(hasActive ? "accent" : "dim", glyph)} ${theme.fg(hasActive ? "accent" : "dim", "Async agents")} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(", ") || `${jobs.length} total`)}`,
    width,
  );
}

function progressiveJobLine(
  job: AsyncJobState,
  theme: Theme,
  width: number,
): string {
  const stats = widgetStats(job, theme);
  const activity = widgetActivity(job);
  const status = job.status === "complete" ? "done" : job.status;
  const parts = [
    themeBold(theme, widgetJobName(job)),
    theme.fg("dim", status),
    stats,
    activity && activity.toLowerCase() !== status
      ? theme.fg("dim", activity)
      : "",
  ].filter(Boolean);
  return truncLine(
    `  ${widgetStatusGlyph(job, theme)} ${parts.join(` ${theme.fg("dim", "·")} `)}`,
    width,
  );
}

function progressiveHiddenLine(
  hiddenJobs: AsyncJobState[],
  theme: Theme,
  width: number,
): string {
  const counts = widgetHeaderCounts(hiddenJobs);
  const parts: string[] = [];
  if (counts.running.length > 0) parts.push(`${counts.running.length} running`);
  if (counts.queued.length > 0) parts.push(`${counts.queued.length} queued`);
  const finished =
    counts.complete.length +
    counts.failed.length +
    counts.paused.length +
    counts.stopped.length;
  if (finished > 0) parts.push(`${finished} finished`);
  return truncLine(
    theme.fg(
      "dim",
      `  +${hiddenJobs.length} more${parts.length ? ` (${parts.join(", ")})` : ""}`,
    ),
    width,
  );
}

function buildProgressiveWidgetLines(
  jobs: AsyncJobState[],
  theme: Theme,
  width: number,
  lockedRows: number,
  previousKeys: string[],
): { lines: string[]; visibleJobKeys: string[] } {
  const rowCount = Math.max(1, lockedRows);
  if (rowCount === 1)
    return {
      lines: buildSingleLineWidgetLines(jobs, theme, width),
      visibleJobKeys: [],
    };

  const bodyRows = rowCount - 1;
  let visibleJobKeys = selectProgressiveJobKeys(jobs, previousKeys, bodyRows);
  const jobsByKey = new Map(jobs.map((job) => [progressiveJobKey(job), job]));
  let visibleJobs = visibleJobKeys
    .map((key) => jobsByKey.get(key))
    .filter((job): job is AsyncJobState => Boolean(job));
  let hiddenJobs = jobs.filter(
    (job) => !visibleJobKeys.includes(progressiveJobKey(job)),
  );
  const needsHiddenLine = hiddenJobs.length > 0;

  if (needsHiddenLine && visibleJobs.length >= bodyRows && bodyRows > 0) {
    visibleJobs = visibleJobs.slice(0, bodyRows - 1);
    visibleJobKeys = visibleJobs.map(progressiveJobKey);
    hiddenJobs = jobs.filter(
      (job) => !visibleJobKeys.includes(progressiveJobKey(job)),
    );
  }

  const lines = [
    progressiveHeaderLine(jobs, theme, width),
    ...visibleJobs.map((job) => progressiveJobLine(job, theme, width)),
  ];
  if (hiddenJobs.length > 0 && lines.length < rowCount)
    lines.push(progressiveHiddenLine(hiddenJobs, theme, width));
  while (lines.length < rowCount) lines.push(" ");
  return { lines: lines.slice(0, rowCount), visibleJobKeys };
}

function collapsedWidgetLineBudget(rows: number): number {
  return Math.max(10, Math.min(14, Math.floor(rows * 0.35)));
}

function fitWidgetLineBudget(
  lines: string[],
  theme: Theme,
  width: number,
  expanded: boolean,
): string[] {
  const rows = process.stdout.rows || 30;
  const budget = expanded
    ? Math.max(12, Math.min(24, Math.floor(rows * 0.55)))
    : collapsedWidgetLineBudget(rows);
  if (lines.length <= budget) return lines;
  const visibleLines = Math.max(1, budget - 1);
  const hiddenCount = lines.length - visibleLines;
  const hint = expanded
    ? `… ${hiddenCount} live-detail lines hidden`
    : `… ${hiddenCount} lines hidden · ${liveDetailKeyText()} expands`;
  return [
    ...lines.slice(0, visibleLines),
    truncLine(theme.fg("dim", hint), width),
  ];
}

function fitAdaptiveWidgetLines(
  jobs: AsyncJobState[],
  lines: string[],
  theme: Theme,
  width: number,
  expanded: boolean,
): string[] {
  if (expanded) {
    resetWidgetLayoutSession();
    return fitWidgetLineBudget(lines, theme, width, true);
  }

  const hasMatchingSession = widgetSessionMatches(expanded);
  const rows = currentTerminalRows();
  const columns = currentTerminalColumns();
  const availableRows = estimateAvailableWidgetRows();

  if (hasMatchingSession && widgetLayoutSession?.tier === "single-line") {
    return buildSingleLineWidgetLines(jobs, theme, width);
  }

  if (
    hasMatchingSession &&
    widgetLayoutSession?.tier === "progressive" &&
    widgetLayoutSession.lockedRows !== undefined
  ) {
    const rendered = buildProgressiveWidgetLines(
      jobs,
      theme,
      width,
      widgetLayoutSession.lockedRows,
      widgetLayoutSession.visibleJobKeys,
    );
    widgetLayoutSession.visibleJobKeys = rendered.visibleJobKeys;
    return rendered.lines;
  }

  if (lines.length <= availableRows) {
    widgetLayoutSession = {
      expanded,
      rows,
      columns,
      tier: "full",
      visibleJobKeys: [],
    };
    return fitWidgetLineBudget(lines, theme, width, false);
  }

  if (availableRows <= 2) {
    widgetLayoutSession = {
      expanded,
      rows,
      columns,
      tier: "single-line",
      visibleJobKeys: [],
    };
    return buildSingleLineWidgetLines(jobs, theme, width);
  }

  const lockedRows = Math.min(availableRows, collapsedWidgetLineBudget(rows));
  const rendered = buildProgressiveWidgetLines(
    jobs,
    theme,
    width,
    lockedRows,
    [],
  );
  widgetLayoutSession = {
    expanded,
    rows,
    columns,
    tier: "progressive",
    lockedRows,
    visibleJobKeys: rendered.visibleJobKeys,
  };
  return rendered.lines;
}

function buildWidgetComponent(
  jobs: AsyncJobState[],
  expanded: boolean,
): (_tui: unknown, theme: Theme) => Component {
  return (_tui, theme) => {
    const width = getTermWidth();
    const lines = expanded
      ? buildWidgetLines(jobs, theme, width, true)
      : jobs.length === 1
        ? compactSingleWidgetLines(jobs[0]!, theme, width)
        : buildWidgetLines(jobs, theme, width, false);
    const container = new Container();
    for (const line of fitAdaptiveWidgetLines(
      jobs,
      lines,
      theme,
      width,
      expanded,
    ))
      container.addChild(new Text(line, 1, 0));
    return container;
  };
}

export function buildWidgetLines(
  jobs: AsyncJobState[],
  theme: Theme,
  width = getTermWidth(),
  expanded = false,
): string[] {
  if (jobs.length === 0) return [];
  if (jobs.length === 1)
    return buildSingleWidgetLines(jobs[0]!, theme, width, expanded);
  const running = jobs.filter((job) => job.status === "running");
  const queued = jobs.filter((job) => job.status === "queued");
  const finished = jobs.filter(
    (job) => job.status !== "running" && job.status !== "queued",
  );

  const lines: string[] = [];
  const hasActive = running.length > 0 || queued.length > 0;
  const headerGlyph =
    running.length > 0
      ? runningGlyph(widgetJobsRunningSeed(running))
      : hasActive
        ? "●"
        : "○";
  lines.push(
    truncLine(
      `${theme.fg(hasActive ? "accent" : "dim", headerGlyph)} ${theme.fg(hasActive ? "accent" : "dim", "Async agents")} ${theme.fg("dim", "· background")}`,
      width,
    ),
  );

  const items: string[][] = [];
  let hiddenRunning = 0;
  let hiddenFinished = 0;
  let queuedSummaryShown = false;
  let slots = MAX_WIDGET_JOBS;

  for (const job of running) {
    if (slots <= 0) {
      hiddenRunning++;
      continue;
    }
    const stats = widgetStats(job, theme);
    items.push([
      `${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
      `  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
      ...widgetParallelAgentDetails(job, theme, expanded, width),
    ]);
    slots--;
  }

  if (queued.length > 0 && slots > 0) {
    items.push([
      `${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`,
    ]);
    queuedSummaryShown = true;
    slots--;
  }

  for (const job of finished) {
    if (slots <= 0) {
      hiddenFinished++;
      continue;
    }
    const stats = widgetStats(job, theme);
    items.push([
      `${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
      `  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
      ...widgetParallelAgentDetails(job, theme, expanded, width),
    ]);
    slots--;
  }

  const hiddenQueued =
    queued.length > 0 && !queuedSummaryShown ? queued.length : 0;
  const hiddenTotal = hiddenRunning + hiddenFinished + hiddenQueued;
  if (hiddenTotal > 0) {
    const parts: string[] = [];
    if (hiddenRunning > 0) parts.push(`${hiddenRunning} running`);
    if (hiddenQueued > 0) parts.push(`${hiddenQueued} queued`);
    if (hiddenFinished > 0) parts.push(`${hiddenFinished} finished`);
    items.push([theme.fg("dim", `+${hiddenTotal} more (${parts.join(", ")})`)]);
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const last = i === items.length - 1;
    const branch = last ? "└─" : "├─";
    const continuation = last ? "   " : "│  ";
    lines.push(truncLine(`${theme.fg("dim", branch)} ${item[0]}`, width));
    for (const detail of item.slice(1)) {
      lines.push(
        truncLine(`${theme.fg("dim", continuation)} ${detail}`, width),
      );
    }
  }

  return lines;
}

/**
 * Render the async jobs widget
 */
export function renderWidget(
  ctx: ExtensionContext,
  jobs: AsyncJobState[],
): void {
  if (jobs.length === 0) {
    resetWidgetLayoutSession();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(
    WIDGET_KEY,
    buildWidgetComponent(jobs, ctx.ui.getToolsExpanded?.() ?? false),
  );
}
