/**
 * Data shaping and line-building helpers for the async-jobs widget (single job detail).
 */

import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AsyncJobState,
  AsyncJobStep,
  AsyncParallelGroupStatus,
  Details,
  NestedRunSummary,
  NestedStepSummary,
  WorkflowNodeStatus,
} from "../shared/types.ts";
import { formatDuration } from "../shared/formatters.ts";
import { shortenPath } from "../shared/formatters.ts";
import { flatToLogicalStepIndex } from "../runs/background/parallel-groups.ts";
import { formatNestedAggregate } from "../runs/shared/nested-render.ts";
import {
  aggregateStepStatus,
  formatAgentRunningLabel,
  formatParallelOutcome,
} from "../shared/status-format.ts";
import {
  buildLiveStatusLine,
  formatCurrentToolLine,
  formatTokenStat,
  formatToolUseStat,
  liveDetailHintText,
  modelThinkingBadge,
  runningGlyph,
  runningSeed,
  statJoin,
  themeBold,
  truncLine,
  type Theme,
} from "./render-format.ts";

export function widgetRenderKey(job: AsyncJobState): string {
  return JSON.stringify({
    asyncDir: job.asyncDir,
    status: job.status,
    activityState: job.activityState,
    lastActivityAt: job.lastActivityAt,
    currentTool: job.currentTool,
    currentToolStartedAt: job.currentToolStartedAt,
    currentPath: job.currentPath,
    turnCount: job.turnCount,
    toolCount: job.toolCount,
    mode: job.mode,
    agents: job.agents,
    currentStep: job.currentStep,
    chainStepCount: job.chainStepCount,
    parallelGroups: job.parallelGroups,
    steps: job.steps,
    nestedChildren: job.nestedChildren,
    stepsTotal: job.stepsTotal,
    runningSteps: job.runningSteps,
    completedSteps: job.completedSteps,
    activeParallelGroup: job.activeParallelGroup,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    totalTokens: job.totalTokens,
  });
}

export function formatWidgetAgents(agents: string[]): string {
  const distinct = [...new Set(agents)];
  if (distinct.length === 1 && agents.length > 1)
    return `${distinct[0]} ×${agents.length}`;
  if (agents.length > 3)
    return `${agents.slice(0, 2).join(", ")} +${agents.length - 2} more`;
  return agents.join(", ");
}

export function widgetJobName(job: AsyncJobState): string {
  if (job.mode === "parallel") return "parallel";
  if (job.mode === "chain") return "chain";
  if (job.mode === "single" && job.agents?.length === 1) return job.agents[0]!;
  if (job.agents?.length) return formatWidgetAgents(job.agents);
  return job.mode ?? "subagent";
}

export function widgetActivity(job: AsyncJobState): string {
  const facts: string[] = [];
  if (
    job.currentTool &&
    job.currentToolStartedAt !== undefined &&
    job.updatedAt !== undefined
  )
    facts.push(
      `${job.currentTool} ${formatDuration(Math.max(0, job.updatedAt - job.currentToolStartedAt))}`,
    );
  else if (job.currentTool) facts.push(job.currentTool);
  if (job.currentPath) facts.push(shortenPath(job.currentPath));
  if (job.turnCount !== undefined) facts.push(`${job.turnCount} turns`);
  if (job.toolCount !== undefined) facts.push(`${job.toolCount} tools`);
  const activity = buildLiveStatusLine(job, job.updatedAt);
  if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
  if (activity) return activity;
  if (facts.length) return facts.join(" · ");
  if (job.status === "running") return "thinking…";
  if (job.status === "queued") return "queued…";
  if (job.status === "paused") return "Paused";
  if (job.status === "stopped") return "Stopped";
  if (job.status === "failed") return "Failed";
  return "Done";
}

export function widgetStepRunningSeed(
  step: NonNullable<AsyncJobState["steps"]>[number],
  fallbackIndex?: number,
): number | undefined {
  return runningSeed(
    fallbackIndex,
    step.index,
    step.toolCount,
    step.turnCount,
    step.tokens?.total,
    step.lastActivityAt,
    step.currentToolStartedAt,
    step.durationMs,
  );
}

export function widgetStepsRunningSeed(
  steps: Array<NonNullable<AsyncJobState["steps"]>[number]> | undefined,
): number | undefined {
  let seed: number | undefined;
  for (const [index, step] of (steps ?? []).entries())
    seed = runningSeed(seed, widgetStepRunningSeed(step, index));
  return seed;
}

export function widgetJobRunningSeed(job: AsyncJobState): number | undefined {
  return runningSeed(
    job.updatedAt,
    job.lastActivityAt,
    job.toolCount,
    job.turnCount,
    job.totalTokens?.total,
    job.currentStep,
    job.runningSteps,
    job.completedSteps,
    widgetStepsRunningSeed(job.steps),
  );
}

export function widgetJobsRunningSeed(
  jobs: AsyncJobState[],
): number | undefined {
  let seed: number | undefined;
  for (const job of jobs) seed = runningSeed(seed, widgetJobRunningSeed(job));
  return seed;
}

export function widgetStatusGlyph(job: AsyncJobState, theme: Theme): string {
  if (job.status === "running")
    return theme.fg("accent", runningGlyph(widgetJobRunningSeed(job)));
  if (job.status === "queued") return theme.fg("muted", "◦");
  if (job.status === "complete") return theme.fg("success", "✓");
  if (job.status === "paused") return theme.fg("warning", "■");
  if (job.status === "stopped") return theme.fg("warning", "■");
  return theme.fg("error", "✗");
}

export function widgetStepGlyph(
  status: AsyncJobStep["status"],
  theme: Theme,
  seed?: number,
): string {
  if (status === "running") return theme.fg("accent", runningGlyph(seed));
  if (status === "complete" || status === "completed")
    return theme.fg("success", "✓");
  if (status === "failed") return theme.fg("error", "✗");
  if (status === "paused") return theme.fg("warning", "■");
  if (status === "stopped") return theme.fg("warning", "■");
  return theme.fg("muted", "◦");
}

export function widgetStepStatus(
  status: AsyncJobStep["status"],
  theme: Theme,
): string {
  if (status === "running") return theme.fg("accent", "running");
  if (status === "complete" || status === "completed")
    return theme.fg("success", "complete");
  if (status === "failed") return theme.fg("error", "failed");
  if (status === "paused") return theme.fg("warning", "paused");
  if (status === "stopped") return theme.fg("warning", "stopped");
  return theme.fg("dim", status);
}

export function widgetStepActivity(
  step: NonNullable<AsyncJobState["steps"]>[number],
  snapshotNow?: number,
): string {
  const facts: string[] = [];
  if (
    step.currentTool &&
    step.currentToolStartedAt !== undefined &&
    snapshotNow !== undefined
  )
    facts.push(
      `${step.currentTool} ${formatDuration(Math.max(0, snapshotNow - step.currentToolStartedAt))}`,
    );
  else if (step.currentTool) facts.push(step.currentTool);
  if (step.currentPath) facts.push(shortenPath(step.currentPath));
  if (step.turnCount !== undefined) facts.push(`${step.turnCount} turns`);
  if (step.toolCount !== undefined) facts.push(`${step.toolCount} tools`);
  if (step.tokens?.total) facts.push(formatTokenStat(step.tokens.total));
  const activity = buildLiveStatusLine(step, snapshotNow);
  if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
  if (activity) return activity;
  return facts.join(" · ");
}

export function widgetChainDetails(
  job: AsyncJobState,
  theme: Theme,
  expanded = false,
  width = process.stdout.columns || 120,
): string[] {
  if (!job.steps?.length) return [];
  const total = job.chainStepCount ?? job.steps.length;
  const lines: string[] = [];
  for (const span of buildAsyncChainStepSpans(
    total,
    job.steps.length,
    job.parallelGroups,
  )) {
    const steps = job.steps.slice(span.start, span.start + span.count);
    if (span.isParallel) {
      const status = aggregateStepStatus(steps);
      lines.push(
        `  ${widgetStepGlyph(status, theme, widgetStepsRunningSeed(steps))} Step ${span.stepIndex + 1}/${total}: ${themeBold(theme, "parallel group")} ${theme.fg("dim", "·")} ${theme.fg("dim", formatParallelOutcome(steps, span.count))}`,
      );
      continue;
    }
    const step = steps[0];
    if (!step) {
      lines.push(
        `  ${theme.fg("dim", `◦ Step ${span.stepIndex + 1}/${total}: pending`)}`,
      );
      continue;
    }
    lines.push(
      ...foregroundStyleWidgetStepLines(
        job,
        theme,
        step,
        "Step",
        span.stepIndex + 1,
        total,
        expanded,
        width,
      ),
    );
  }
  return lines;
}

export function widgetParallelAgentDetails(
  job: AsyncJobState,
  theme: Theme,
  expanded = false,
  width = process.stdout.columns || 120,
): string[] {
  if (!job.steps?.length) return [];
  if (job.mode !== "parallel" && job.mode !== "chain") return [];
  if (
    job.mode === "chain" &&
    !job.activeParallelGroup &&
    job.parallelGroups?.length
  )
    return widgetChainDetails(job, theme, expanded, width);
  const total = job.stepsTotal ?? job.steps.length;
  const lines: string[] = [];
  for (const [index, step] of job.steps.entries()) {
    const marker = index === job.steps.length - 1 ? "└" : "├";
    const activity = widgetStepActivity(step, job.updatedAt);
    const itemTitle =
      job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
    const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
    lines.push(
      `  ${theme.fg("dim", `${marker} ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index))} ${itemTitle} ${index + 1}/${total}: ${step.agent} · ${widgetStepStatus(step.status, theme)}${modelDisplay}${activity ? ` · ${activity}` : ""}`)}`,
    );
    for (const nestedLine of formatNestedWidgetLines(
      step.children,
      theme,
      width,
      expanded,
      job.updatedAt,
      expanded ? 8 : 1,
    ))
      lines.push(`    ${nestedLine}`);
  }
  return lines;
}

function parseParallelGroupAgentCount(
  label: string | undefined,
): number | undefined {
  if (!label || !label.startsWith("[") || !label.endsWith("]"))
    return undefined;
  const inner = label.slice(1, -1).trim();
  if (!inner) return 0;
  return inner
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean).length;
}

export interface ChainStepSpan {
  stepIndex: number;
  start: number;
  count: number;
  isParallel: boolean;
  status?: WorkflowNodeStatus;
  label?: string;
  error?: string;
}

export function buildChainStepSpans(
  details: Pick<Details, "chainAgents" | "workflowGraph">,
): ChainStepSpan[] {
  if (details.workflowGraph?.nodes?.length) {
    const spans: ChainStepSpan[] = [];
    let flatCursor = 0;
    for (const node of details.workflowGraph.nodes) {
      if (node.stepIndex === undefined) continue;
      if (
        node.kind === "parallel-group" ||
        node.kind === "dynamic-parallel-group"
      ) {
        const childFlatIndexes = (node.children ?? [])
          .map((child) => child.flatIndex)
          .filter((value): value is number => typeof value === "number");
        const start = childFlatIndexes.length
          ? Math.min(...childFlatIndexes)
          : flatCursor;
        const count = node.children?.length ?? 0;
        spans.push({
          stepIndex: node.stepIndex,
          start,
          count,
          isParallel: true,
          status: node.status,
          label: node.label,
          error: node.error,
        });
        flatCursor = Math.max(flatCursor, start + count);
        continue;
      }
      const start = node.flatIndex ?? flatCursor;
      spans.push({
        stepIndex: node.stepIndex,
        start,
        count: 1,
        isParallel: false,
        status: node.status,
        label: node.label,
        error: node.error,
      });
      flatCursor = Math.max(flatCursor, start + 1);
    }
    if (spans.length)
      return spans.sort((left, right) => left.stepIndex - right.stepIndex);
  }

  if (!details.chainAgents?.length) return [];
  const spans: ChainStepSpan[] = [];
  let start = 0;
  for (let stepIndex = 0; stepIndex < details.chainAgents.length; stepIndex++) {
    const label = details.chainAgents[stepIndex]!;
    const parsedCount = parseParallelGroupAgentCount(label);
    const count = parsedCount ?? 1;
    spans.push({
      stepIndex,
      start,
      count,
      isParallel: parsedCount !== undefined,
    });
    start += count;
  }
  return spans;
}

export function isChainParallelGroupActive(
  details: Pick<
    Details,
    "mode" | "chainAgents" | "currentStepIndex" | "workflowGraph"
  >,
): boolean {
  if (details.mode !== "chain") return false;
  if (details.currentStepIndex === undefined) return false;
  return buildChainStepSpans(details).some(
    (span) => span.stepIndex === details.currentStepIndex && span.isParallel,
  );
}

export function buildAsyncChainStepSpans(
  total: number,
  stepCount: number,
  parallelGroups: AsyncParallelGroupStatus[] = [],
): ChainStepSpan[] {
  const spans: ChainStepSpan[] = [];
  let flatIndex = 0;
  for (let stepIndex = 0; stepIndex < total; stepIndex++) {
    const group = parallelGroups.find(
      (candidate) => candidate.stepIndex === stepIndex,
    );
    if (group) {
      spans.push({
        stepIndex,
        start: group.start,
        count: group.count,
        isParallel: true,
      });
      flatIndex = Math.max(flatIndex, group.start + group.count);
      continue;
    }
    spans.push({
      stepIndex,
      start: flatIndex,
      count: flatIndex < stepCount ? 1 : 0,
      isParallel: false,
    });
    flatIndex++;
  }
  return spans;
}

export function isDoneResult(result: Details["results"][number]): boolean {
  const status = result.progress?.status;
  if (status === "completed") return true;
  if (status === "running" || status === "pending") return false;
  if (result.interrupted || result.detached) return false;
  return result.exitCode === 0;
}

export function workflowGraphHasStatus(
  details: Pick<Details, "workflowGraph">,
  statuses: WorkflowNodeStatus[],
): boolean {
  return (
    details.workflowGraph?.nodes.some((node) =>
      statuses.includes(node.status),
    ) ?? false
  );
}

export interface ChainRenderResultEntry {
  kind: "result";
  resultIndex: number;
  rowNumber: number;
  agentName: string;
}

export interface ChainRenderPlaceholderEntry {
  kind: "placeholder";
  rowNumber: number;
  stepLabel: string;
  agentName: string;
  status: WorkflowNodeStatus;
  error?: string;
}

export type ChainRenderEntry =
  ChainRenderResultEntry | ChainRenderPlaceholderEntry;

export function buildChainRenderEntries(
  details: Details,
  label: MultiProgressLabel,
): ChainRenderEntry[] | undefined {
  if (
    details.mode !== "chain" ||
    !label.hasParallelInChain ||
    label.showActiveGroupOnly
  )
    return undefined;
  const entries: ChainRenderEntry[] = [];
  for (const span of buildChainStepSpans(details)) {
    if (span.isParallel && span.count === 0) {
      entries.push({
        kind: "placeholder",
        rowNumber: span.stepIndex + 1,
        stepLabel: `Step ${span.stepIndex + 1}`,
        agentName:
          span.label ??
          details.chainAgents?.[span.stepIndex] ??
          `step-${span.stepIndex + 1}`,
        status: span.status ?? "pending",
        error: span.error,
      });
      continue;
    }
    for (let index = span.start; index < span.start + span.count; index++) {
      entries.push({
        kind: "result",
        resultIndex: index,
        rowNumber: index + 1,
        agentName:
          details.results[index]?.agent ??
          details.chainAgents?.[span.stepIndex] ??
          `step-${span.stepIndex + 1}`,
      });
    }
  }
  return entries;
}

export interface MultiProgressLabel {
  headerLabel: string;
  itemTitle: "Step" | "Agent";
  totalCount: number;
  hasParallelInChain: boolean;
  activeParallelGroup: boolean;
  groupStartIndex: number;
  groupEndIndex: number;
  showActiveGroupOnly: boolean;
}

export function buildMultiProgressLabel(
  details: Pick<
    Details,
    | "mode"
    | "results"
    | "progress"
    | "totalSteps"
    | "currentStepIndex"
    | "chainAgents"
    | "workflowGraph"
  >,
  hasRunning: boolean,
): MultiProgressLabel {
  const stepSpans = buildChainStepSpans(details);
  const hasParallelInChain =
    details.mode === "chain" && stepSpans.some((span) => span.isParallel);
  const activeParallelGroup = isChainParallelGroupActive(details);
  const itemTitle: "Step" | "Agent" =
    details.mode === "parallel" || activeParallelGroup ? "Agent" : "Step";

  if (details.mode === "parallel") {
    const totalCount = details.totalSteps ?? details.results.length;
    const statuses = new Array(totalCount).fill("pending") as Array<
      "pending" | "running" | "completed" | "failed" | "stopped" | "detached"
    >;
    for (const progress of details.progress ?? []) {
      if (progress.index >= 0 && progress.index < totalCount)
        statuses[progress.index] = progress.status;
    }
    for (let i = 0; i < details.results.length; i++) {
      const result = details.results[i]!;
      const progressFromArray =
        details.progress?.find((progress) => progress.index === i) ||
        details.progress?.find(
          (progress) =>
            progress.agent === result.agent && progress.status === "running",
        );
      const index = result.progress?.index ?? progressFromArray?.index ?? i;
      if (index < 0 || index >= totalCount) continue;
      const status =
        result.progress?.status ??
        (result.stopped
          ? "stopped"
          : result.interrupted || result.detached
            ? "detached"
            : result.exitCode === 0
              ? "completed"
              : "failed");
      statuses[index] = status;
    }
    const running = statuses.filter((status) => status === "running").length;
    const done = statuses.filter((status) => status === "completed").length;
    const headerLabel = hasRunning
      ? `${formatAgentRunningLabel(running)} · ${done}/${totalCount} done`
      : `${done}/${totalCount} done`;
    return {
      headerLabel,
      itemTitle,
      totalCount,
      hasParallelInChain,
      activeParallelGroup,
      groupStartIndex: 0,
      groupEndIndex: totalCount,
      showActiveGroupOnly: false,
    };
  }

  if (activeParallelGroup) {
    const currentStepIndex = details.currentStepIndex!;
    const span = stepSpans[currentStepIndex];
    const groupSize = span?.count ?? 1;
    const groupStart = span?.start ?? 0;
    const groupEnd = groupStart + groupSize;
    let running = 0;
    let done = 0;
    for (let index = groupStart; index < groupEnd; index++) {
      const progressEntry = details.progress?.find(
        (progress) => progress.index === index,
      );
      const resultEntry = details.results.find(
        (result) => result.progress?.index === index,
      );
      if (progressEntry?.status === "running") {
        running++;
        continue;
      }
      if (progressEntry?.status === "completed") {
        done++;
        continue;
      }
      if (resultEntry && isDoneResult(resultEntry)) done++;
    }
    const totalSteps = details.totalSteps ?? details.chainAgents?.length ?? 1;
    const headerLabel = hasRunning
      ? `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${formatAgentRunningLabel(running)} · ${done}/${groupSize} done`
      : `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${done}/${groupSize} done`;
    return {
      headerLabel,
      itemTitle,
      totalCount: groupSize,
      hasParallelInChain,
      activeParallelGroup,
      groupStartIndex: groupStart,
      groupEndIndex: groupEnd,
      showActiveGroupOnly: true,
    };
  }

  if (details.mode === "chain" && details.chainAgents?.length) {
    const totalCount = details.totalSteps ?? details.chainAgents.length;
    const doneLogical = stepSpans.filter((span) => {
      if (span.status && span.status !== "completed") return false;
      if (span.count === 0) return span.status === "completed";
      for (let index = span.start; index < span.start + span.count; index++) {
        const progressEntry = details.progress?.find(
          (progress) => progress.index === index,
        );
        const resultEntry =
          details.results.find((result) => result.progress?.index === index) ??
          details.results[index];
        if (
          progressEntry?.status === "running" ||
          progressEntry?.status === "pending" ||
          progressEntry?.status === "failed"
        )
          return false;
        if (!resultEntry || !isDoneResult(resultEntry)) return false;
      }
      return true;
    }).length;
    const currentStep =
      details.currentStepIndex !== undefined
        ? details.currentStepIndex + 1
        : Math.min(totalCount, doneLogical + (hasRunning ? 1 : 0));
    const headerLabel = hasRunning
      ? `step ${currentStep}/${totalCount}`
      : `step ${doneLogical}/${totalCount}`;
    return {
      headerLabel,
      itemTitle,
      totalCount,
      hasParallelInChain,
      activeParallelGroup,
      groupStartIndex: 0,
      groupEndIndex: details.results.length,
      showActiveGroupOnly: false,
    };
  }

  const totalCount = details.totalSteps ?? details.results.length;
  const currentStep =
    details.currentStepIndex !== undefined
      ? details.currentStepIndex + 1
      : Math.min(
          totalCount,
          details.results.filter(isDoneResult).length + (hasRunning ? 1 : 0),
        );
  const done = details.results.filter(isDoneResult).length;
  const headerLabel = hasRunning
    ? `step ${currentStep}/${totalCount}`
    : `step ${done}/${totalCount}`;
  return {
    headerLabel,
    itemTitle,
    totalCount,
    hasParallelInChain,
    activeParallelGroup,
    groupStartIndex: 0,
    groupEndIndex: details.results.length,
    showActiveGroupOnly: false,
  };
}

export function resultRowLabel(
  details: Pick<Details, "mode" | "chainAgents" | "workflowGraph">,
  label: MultiProgressLabel,
  resultIndex: number,
  stepNumber: number,
): string {
  if (details.mode === "chain" && label.hasParallelInChain) {
    const span = buildChainStepSpans(details).find(
      (candidate) =>
        resultIndex >= candidate.start &&
        resultIndex < candidate.start + candidate.count,
    );
    if (span?.isParallel)
      return `Agent ${resultIndex - span.start + 1}/${span.count}`;
    if (span) return `Step ${span.stepIndex + 1}`;
  }
  if (label.itemTitle === "Agent") {
    const localStepNumber = label.activeParallelGroup
      ? Math.max(1, stepNumber - label.groupStartIndex)
      : stepNumber;
    return `Agent ${localStepNumber}/${label.totalCount}`;
  }
  return `Step ${stepNumber}`;
}

export function widgetStats(job: AsyncJobState, theme: Theme): string {
  const parts: string[] = [];
  const stepsTotal = job.stepsTotal ?? job.agents?.length ?? 1;
  if (job.activeParallelGroup) {
    const running = job.runningSteps ?? (job.status === "running" ? 1 : 0);
    const done =
      job.completedSteps ?? (job.status === "complete" ? stepsTotal : 0);
    if (job.mode === "parallel") {
      if (job.status === "running" && running > 0)
        parts.push(formatAgentRunningLabel(running));
      if (stepsTotal > 0) parts.push(`${done}/${stepsTotal} done`);
    } else {
      const activeGroup =
        job.currentStep !== undefined
          ? job.parallelGroups?.find(
              (group) =>
                job.currentStep! >= group.start &&
                job.currentStep! < group.start + group.count,
            )
          : job.parallelGroups?.find((group) => group.start === 0);
      const logicalStep = activeGroup?.stepIndex ?? job.currentStep ?? 0;
      const total = job.chainStepCount ?? stepsTotal;
      const groupParts = [`${done}/${stepsTotal} done`];
      if (job.status === "running" && running > 0)
        groupParts.unshift(formatAgentRunningLabel(running));
      parts.push(
        `step ${logicalStep + 1}/${total} · parallel group: ${groupParts.join(" · ")}`,
      );
    }
  } else if (job.currentStep !== undefined) {
    if (job.mode === "chain" && job.parallelGroups?.length) {
      const total = job.chainStepCount ?? stepsTotal;
      parts.push(
        `step ${flatToLogicalStepIndex(job.currentStep, total, job.parallelGroups) + 1}/${total}`,
      );
    } else {
      parts.push(`step ${job.currentStep + 1}/${stepsTotal}`);
    }
  } else if (stepsTotal > 1) {
    parts.push(`steps ${stepsTotal}`);
  }
  if (job.toolCount !== undefined) parts.push(formatToolUseStat(job.toolCount));
  if (job.totalTokens?.total)
    parts.push(formatTokenStat(job.totalTokens.total));
  if (job.startedAt !== undefined && job.updatedAt !== undefined)
    parts.push(formatDuration(Math.max(0, job.updatedAt - job.startedAt)));
  return statJoin(theme, parts);
}

export function widgetStepStats(
  theme: Theme,
  step: NonNullable<AsyncJobState["steps"]>[number],
): string {
  return statJoin(theme, [
    step.turnCount !== undefined ? `${step.turnCount} turns` : "",
    step.toolCount !== undefined ? formatToolUseStat(step.toolCount) : "",
    step.tokens?.total ? formatTokenStat(step.tokens.total) : "",
    step.durationMs !== undefined ? formatDuration(step.durationMs) : "",
  ]);
}

export function widgetStepActivityLine(
  step: NonNullable<AsyncJobState["steps"]>[number],
  width: number,
  expanded: boolean,
  snapshotNow?: number,
): string {
  const toolLine = formatCurrentToolLine(step, width, expanded, snapshotNow);
  if (toolLine) return toolLine;
  const activity = buildLiveStatusLine(step, snapshotNow);
  if (activity) return activity;
  if (step.status === "running") return "thinking…";
  return "";
}

export function widgetOutputPath(
  job: AsyncJobState,
  step: NonNullable<AsyncJobState["steps"]>[number],
): string | undefined {
  if (typeof step.index !== "number") return undefined;
  return path.join(job.asyncDir, `output-${step.index}.log`);
}

function nestedRunName(run: NestedRunSummary): string {
  if (run.agent) return run.agent;
  if (run.agents?.length) return formatWidgetAgents(run.agents);
  return run.id;
}

function nestedStatusGlyph(
  state: NestedRunSummary["state"] | NestedStepSummary["status"],
  theme: Theme,
  seed?: number,
): string {
  if (state === "running") return theme.fg("accent", runningGlyph(seed));
  if (state === "complete" || state === "completed")
    return theme.fg("success", "✓");
  if (state === "failed") return theme.fg("error", "✗");
  if (state === "paused") return theme.fg("warning", "■");
  if (state === "stopped") return theme.fg("warning", "■");
  return theme.fg("muted", "◦");
}

function nestedRunSeed(run: NestedRunSummary): number | undefined {
  return runningSeed(
    run.lastUpdate,
    run.lastActivityAt,
    run.currentStep,
    run.toolCount,
    run.turnCount,
    run.totalTokens?.total,
    run.currentToolStartedAt,
  );
}

function nestedActivity(
  input: Pick<
    NestedRunSummary | NestedStepSummary,
    | "activityState"
    | "lastActivityAt"
    | "currentTool"
    | "currentToolStartedAt"
    | "currentPath"
    | "turnCount"
    | "toolCount"
  >,
  state: NestedRunSummary["state"] | NestedStepSummary["status"],
  snapshotNow?: number,
): string {
  const facts: string[] = [];
  if (
    input.currentTool &&
    input.currentToolStartedAt !== undefined &&
    snapshotNow !== undefined
  )
    facts.push(
      `${input.currentTool} ${formatDuration(Math.max(0, snapshotNow - input.currentToolStartedAt))}`,
    );
  else if (input.currentTool) facts.push(input.currentTool);
  if (input.currentPath) facts.push(shortenPath(input.currentPath));
  if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
  if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
  const activity = buildLiveStatusLine(input, snapshotNow);
  if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
  if (activity) return activity;
  if (facts.length) return facts.join(" · ");
  if (state === "running") return "thinking…";
  if (state === "queued" || state === "pending") return "queued…";
  if (state === "paused") return "Paused";
  if (state === "stopped") return "Stopped";
  if (state === "failed") return "Failed";
  return "Done";
}

export function formatNestedWidgetLines(
  children: NestedRunSummary[] | undefined,
  theme: Theme,
  width: number,
  expanded: boolean,
  snapshotNow?: number,
  lineBudget = expanded ? 12 : 1,
): string[] {
  if (!children?.length || lineBudget <= 0) return [];
  if (!expanded) {
    const aggregate = formatNestedAggregate(children);
    return aggregate ? [theme.fg("dim", `↳ ${aggregate}`)] : [];
  }
  const lines: string[] = [];
  const maxDepth = 2;
  const append = (
    items: NestedRunSummary[] | undefined,
    depth: number,
    prefix: string,
  ): void => {
    if (!items?.length || lines.length >= lineBudget) return;
    if (depth > maxDepth) {
      const aggregate = formatNestedAggregate(items);
      if (aggregate && lines.length < lineBudget)
        lines.push(theme.fg("dim", `${prefix}↳ ${aggregate}`));
      return;
    }
    for (let index = 0; index < items.length; index++) {
      const child = items[index]!;
      if (lines.length >= lineBudget) {
        const aggregate = formatNestedAggregate(items.slice(index));
        if (aggregate)
          lines[lines.length - 1] = theme.fg("dim", `${prefix}↳ ${aggregate}`);
        return;
      }
      const activity = nestedActivity(
        child,
        child.state,
        snapshotNow ?? child.lastUpdate,
      );
      const error = child.error ? ` · ${child.error}` : "";
      lines.push(
        theme.fg(
          "dim",
          `${prefix}↳ ${nestedStatusGlyph(child.state, theme, nestedRunSeed(child))} ${nestedRunName(child)} · ${child.state} · ${activity}${error}`,
        ),
      );
      if (depth === maxDepth) {
        const aggregate = formatNestedAggregate([
          ...(child.steps?.flatMap((step) => step.children ?? []) ?? []),
          ...(child.children ?? []),
        ]);
        if (aggregate && lines.length < lineBudget)
          lines.push(theme.fg("dim", `${prefix}  ↳ ${aggregate}`));
        continue;
      }
      for (const step of child.steps ?? []) {
        if (lines.length >= lineBudget) return;
        lines.push(
          theme.fg(
            "dim",
            `${prefix}  ↳ ${nestedStatusGlyph(step.status, theme)} ${step.agent} · ${step.status} · ${nestedActivity(step, step.status, snapshotNow ?? child.lastUpdate)}`,
          ),
        );
        append(step.children, depth + 1, `${prefix}    `);
      }
      append(child.children, depth + 1, `${prefix}  `);
    }
  };
  append(children, 0, "");
  return lines.map((line) => truncLine(line, width));
}

export function foregroundStyleWidgetStepLines(
  job: AsyncJobState,
  theme: Theme,
  step: NonNullable<AsyncJobState["steps"]>[number],
  itemTitle: "Agent" | "Step",
  index: number,
  total: number,
  expanded: boolean,
  width: number,
): string[] {
  const status = widgetStepStatus(step.status, theme);
  const stats = widgetStepStats(theme, step);
  const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
  const lines = [
    `  ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index - 1))} ${itemTitle} ${index}/${total}: ${themeBold(theme, step.agent)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
  ];
  const activity = widgetStepActivityLine(step, width, expanded, job.updatedAt);
  if (activity) lines.push(`    ${theme.fg("dim", `⎿  ${activity}`)}`);
  for (const nestedLine of formatNestedWidgetLines(
    step.children,
    theme,
    width,
    expanded,
    job.updatedAt,
  )) {
    lines.push(`    ${nestedLine}`);
  }
  if (step.status === "running") {
    if (!expanded)
      lines.push(`    ${theme.fg("accent", liveDetailHintText())}`);
    const output = widgetOutputPath(job, step);
    if (output)
      lines.push(`    ${theme.fg("dim", `output: ${shortenPath(output)}`)}`);
    if (expanded) {
      const liveStatus = buildLiveStatusLine(step, job.updatedAt);
      if (liveStatus && liveStatus !== activity)
        lines.push(`    ${theme.fg("accent", liveStatus)}`);
      for (const tool of step.recentTools?.slice(-3) ?? []) {
        const maxArgsLen = Math.max(40, width - 30);
        const argsPreview =
          tool.args.length <= maxArgsLen
            ? tool.args
            : `${tool.args.slice(0, maxArgsLen)}...`;
        lines.push(
          `      ${theme.fg("dim", `${tool.tool}${argsPreview ? `: ${argsPreview}` : ""}`)}`,
        );
      }
      for (const line of step.recentOutput?.slice(-5) ?? []) {
        lines.push(`      ${theme.fg("dim", line)}`);
      }
    }
  }
  return lines;
}

export function foregroundStyleWidgetDetails(
  job: AsyncJobState,
  theme: Theme,
  expanded: boolean,
  width: number,
): string[] {
  if (!job.steps?.length)
    return [
      `  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
      ...formatNestedWidgetLines(
        job.nestedChildren,
        theme,
        width,
        expanded,
        job.updatedAt,
      ).map((line) => `  ${line}`),
    ];
  if (
    job.mode === "chain" &&
    !job.activeParallelGroup &&
    job.parallelGroups?.length
  )
    return widgetChainDetails(job, theme, expanded, width);
  const total = job.stepsTotal ?? job.steps.length;
  const itemTitle =
    job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
  const lines: string[] = [];
  for (const [index, step] of job.steps.entries()) {
    lines.push(
      ...foregroundStyleWidgetStepLines(
        job,
        theme,
        step,
        itemTitle,
        index + 1,
        total,
        expanded,
        width,
      ),
    );
  }
  const attached = new Set(
    job.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []),
  );
  const unattached =
    job.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
  for (const nestedLine of formatNestedWidgetLines(
    unattached,
    theme,
    width,
    expanded,
    job.updatedAt,
  )) {
    lines.push(`  ${nestedLine}`);
  }
  return lines;
}

export function buildSingleWidgetLines(
  job: AsyncJobState,
  theme: Theme,
  width: number,
  expanded: boolean,
): string[] {
  const stats = widgetStats(job, theme);
  const count =
    job.mode === "chain"
      ? job.chainStepCount
      : (job.stepsTotal ?? job.agents?.length ?? job.steps?.length);
  const mode = widgetJobName(job);
  const title = `async subagent ${mode}${count && count > 1 ? ` (${count})` : ""}`;
  return [
    `${theme.fg("toolTitle", themeBold(theme, title))} ${theme.fg("dim", "· background")}`,
    `${widgetStatusGlyph(job, theme)} ${themeBold(theme, mode)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
    ...foregroundStyleWidgetDetails(job, theme, expanded, width),
  ].map((line) => truncLine(line, width));
}

export function compactSingleWidgetLines(
  job: AsyncJobState,
  theme: Theme,
  width: number,
): string[] {
  const fullLines = buildSingleWidgetLines(job, theme, width, false);
  if (
    fullLines.length <= 10 ||
    !job.steps?.length ||
    (job.mode !== "parallel" && !job.activeParallelGroup)
  )
    return fullLines;

  const total = job.stepsTotal ?? job.steps.length;
  const itemTitle =
    job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
  const lines = fullLines.slice(0, 2);
  for (const [index, step] of job.steps.entries()) {
    const status = widgetStepStatus(step.status, theme);
    const activity = widgetStepActivityLine(step, width, false, job.updatedAt);
    const stepStats = widgetStepStats(theme, step);
    const activitySuffix = activity
      ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", activity)}`
      : "";
    const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
    lines.push(
      `  ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index))} ${itemTitle} ${index + 1}/${total}: ${themeBold(theme, step.agent)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${activitySuffix}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}`,
    );
    for (const nestedLine of formatNestedWidgetLines(
      step.children,
      theme,
      width,
      false,
      job.updatedAt,
    ))
      lines.push(`    ${nestedLine}`);
  }
  if (job.steps.some((step) => step.status === "running"))
    lines.push(theme.fg("accent", `  ${liveDetailHintText()}`));
  return lines.map((line) => truncLine(line, width));
}

export type { Theme, ExtensionContext };
