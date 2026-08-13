/**
 * Renders a single subagent tool-result (compact and expanded views).
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import type { AsyncJobStep, Details } from "../shared/types.ts";
import {
  formatDuration,
  formatUsage,
  formatTokens,
  shortenPath,
} from "../shared/formatters.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import {
  buildLiveStatusLine,
  compactCurrentActivity,
  extractOutputTarget,
  firstOutputLine,
  formatCurrentToolLine,
  formatProgressStats,
  formatTotalCostStat,
  getToolCallLines,
  hasEmptyTextOutputWithoutOutputTarget,
  liveDetailHintText,
  modelThinkingBadge,
  progressRunningSeed,
  resultGlyph,
  resultStatusLine,
  runningSeed,
  runningGlyph,
  snapshotNowForProgress,
  statJoin,
  themeBold,
  truncLine,
  wrapPlainText,
  getTermWidth,
  type Theme,
} from "./render-format.ts";
import {
  buildChainRenderEntries,
  buildMultiProgressLabel,
  resultRowLabel,
  widgetStepGlyph,
  widgetStepStatus,
  workflowGraphHasStatus,
  type ChainRenderEntry,
} from "./render-widget-core.ts";

function renderSingleCompact(
  d: Details,
  r: Details["results"][number],
  theme: Theme,
  frame?: number,
): Component {
  const output = r.truncation?.text || getSingleResultOutput(r);
  const progress = r.progress || r.progressSummary;
  const isRunning = r.progress?.status === "running";
  const contextBadge =
    d.context === "fork" ? theme.fg("warning", " [fork]") : "";
  const stats = statJoin(theme, [
    r.usage?.turns ? `⟳ ${r.usage.turns}` : "",
    formatProgressStats(theme, progress),
  ]);
  const c = new Container();
  const width = getTermWidth() - 4;
  const modelDisplay = modelThinkingBadge(theme, r.model);
  c.addChild(
    new Text(
      truncLine(
        `${resultGlyph(r, output, theme, isRunning, undefined, frame)} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelDisplay}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
        width,
      ),
      0,
      0,
    ),
  );

  if (isRunning && r.progress) {
    const progressSnapshotNow = snapshotNowForProgress(r.progress);
    const activity = compactCurrentActivity(r.progress);
    c.addChild(
      new Text(truncLine(theme.fg("dim", `  ⎿  ${activity}`), width), 0, 0),
    );
    const liveStatus = buildLiveStatusLine(r.progress, progressSnapshotNow);
    if (liveStatus && liveStatus !== activity)
      c.addChild(
        new Text(truncLine(theme.fg("dim", `     ${liveStatus}`), width), 0, 0),
      );
    c.addChild(
      new Text(
        truncLine(theme.fg("accent", `  ${liveDetailHintText()}`), width),
        0,
        0,
      ),
    );
    if (r.artifactPaths)
      c.addChild(
        new Text(
          truncLine(
            theme.fg(
              "dim",
              `  output: ${shortenPath(r.artifactPaths.outputPath)}`,
            ),
            width,
          ),
          0,
          0,
        ),
      );
    return c;
  }

  c.addChild(
    new Text(
      truncLine(theme.fg("dim", `  ⎿  ${resultStatusLine(r, output)}`), width),
      0,
      0,
    ),
  );
  const preview = firstOutputLine(output);
  if (
    preview &&
    r.exitCode === 0 &&
    !hasEmptyTextOutputWithoutOutputTarget(r.task, output)
  ) {
    c.addChild(
      new Text(truncLine(theme.fg("dim", `     ${preview}`), width), 0, 0),
    );
  }
  if (r.sessionFile)
    c.addChild(
      new Text(
        truncLine(
          theme.fg("dim", `  session: ${shortenPath(r.sessionFile)}`),
          width,
        ),
        0,
        0,
      ),
    );
  if (r.artifactPaths)
    c.addChild(
      new Text(
        truncLine(
          theme.fg(
            "dim",
            `  output: ${shortenPath(r.artifactPaths.outputPath)}`,
          ),
          width,
        ),
        0,
        0,
      ),
    );
  if (r.truncation?.artifactPath)
    c.addChild(
      new Text(
        truncLine(
          theme.fg(
            "dim",
            `  full output: ${shortenPath(r.truncation.artifactPath)}`,
          ),
          width,
        ),
        0,
        0,
      ),
    );
  return c;
}

function renderMultiCompact(
  d: Details,
  theme: Theme,
  frame?: number,
): Component {
  const hasRunning =
    d.progress?.some((p) => p.status === "running") ||
    d.results.some((r) => r.progress?.status === "running") ||
    workflowGraphHasStatus(d, ["running"]);
  const stopped =
    d.results.some((r) => r.stopped && r.progress?.status !== "running") ||
    workflowGraphHasStatus(d, ["stopped"]);
  const failed =
    d.results.some(
      (r) => !r.stopped && r.exitCode !== 0 && r.progress?.status !== "running",
    ) || workflowGraphHasStatus(d, ["failed"]);
  const paused =
    d.results.some(
      (r) => (r.interrupted || r.detached) && r.progress?.status !== "running",
    ) || workflowGraphHasStatus(d, ["paused", "detached"]);
  let totalSummary = d.progressSummary;
  if (!totalSummary) {
    let sawProgress = false;
    const summary = { toolCount: 0, tokens: 0, durationMs: 0 };
    for (const r of d.results) {
      const prog = r.progress || r.progressSummary;
      if (!prog) continue;
      sawProgress = true;
      summary.toolCount += prog.toolCount;
      summary.tokens += prog.tokens;
      summary.durationMs =
        d.mode === "chain"
          ? summary.durationMs + prog.durationMs
          : Math.max(summary.durationMs, prog.durationMs);
    }
    if (sawProgress) totalSummary = summary;
  }
  const multiLabel = buildMultiProgressLabel(d, hasRunning);
  const itemTitle = multiLabel.itemTitle;
  const stats = statJoin(theme, [
    multiLabel.headerLabel,
    formatProgressStats(theme, totalSummary),
    formatTotalCostStat(d.totalCost),
  ]);
  const glyph = hasRunning
    ? theme.fg(
        "accent",
        runningGlyph(
          frame !== undefined
            ? (runningSeed(
                progressRunningSeed(totalSummary),
                d.currentStepIndex,
              ) ?? 0) + frame
            : runningSeed(
                progressRunningSeed(totalSummary),
                d.currentStepIndex,
              ),
        ),
      )
    : stopped
      ? theme.fg("warning", "■")
      : failed
        ? theme.fg("error", "✗")
        : paused
          ? theme.fg("warning", "■")
          : theme.fg("success", "✓");
  const contextBadge =
    d.context === "fork" ? theme.fg("warning", " [fork]") : "";
  const c = new Container();
  const width = getTermWidth() - 4;
  c.addChild(
    new Text(
      truncLine(
        `${glyph} ${theme.fg("toolTitle", theme.bold(d.mode))}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
        width,
      ),
      0,
      0,
    ),
  );

  const useResultsDirectly =
    multiLabel.hasParallelInChain || !d.chainAgents?.length;
  const displayStart = multiLabel.showActiveGroupOnly
    ? multiLabel.groupStartIndex
    : 0;
  const displayEnd = multiLabel.showActiveGroupOnly
    ? multiLabel.groupEndIndex
    : useResultsDirectly
      ? d.results.length
      : d.chainAgents!.length;
  const chainEntries = buildChainRenderEntries(d, multiLabel);
  const renderEntries =
    chainEntries ??
    Array.from(
      { length: displayEnd - displayStart },
      (_, offset): ChainRenderEntry => {
        const i = displayStart + offset;
        const r = d.results[i];
        const fallbackLabel = itemTitle.toLowerCase();
        const rowNumber = multiLabel.showActiveGroupOnly
          ? i - multiLabel.groupStartIndex + 1
          : i + 1;
        return {
          kind: "result",
          resultIndex: i,
          rowNumber,
          agentName: useResultsDirectly
            ? r?.agent || `${fallbackLabel}-${rowNumber}`
            : d.chainAgents![i] || r?.agent || `${fallbackLabel}-${rowNumber}`,
        };
      },
    );
  for (const entry of renderEntries) {
    if (entry.kind === "placeholder") {
      const glyph = widgetStepGlyph(
        entry.status as AsyncJobStep["status"],
        theme,
      );
      const statusLabel = widgetStepStatus(
        entry.status as AsyncJobStep["status"],
        theme,
      );
      c.addChild(
        new Text(
          truncLine(
            `  ${glyph} ${entry.stepLabel}: ${themeBold(theme, entry.agentName)} ${theme.fg("dim", "·")} ${statusLabel}`,
            width,
          ),
          0,
          0,
        ),
      );
      if (entry.error)
        c.addChild(
          new Text(
            truncLine(theme.fg("error", `    ⎿  Error: ${entry.error}`), width),
            0,
            0,
          ),
        );
      continue;
    }
    const i = entry.resultIndex;
    const r = d.results[i];
    const rowNumber = entry.rowNumber;
    const agentName = entry.agentName;
    if (!r) {
      const pendingLabel = chainEntries
        ? resultRowLabel(d, multiLabel, i, rowNumber)
        : `${itemTitle} ${rowNumber}`;
      c.addChild(
        new Text(
          truncLine(
            theme.fg("dim", `  ◦ ${pendingLabel}: ${agentName} · pending`),
            width,
          ),
          0,
          0,
        ),
      );
      continue;
    }
    const output = getSingleResultOutput(r);
    const progressFromArray =
      d.progress?.find((p) => p.index === i) ||
      d.progress?.find((p) => p.agent === r.agent && p.status === "running");
    const rProg = r.progress || progressFromArray || r.progressSummary;
    const rRunning = rProg && "status" in rProg && rProg.status === "running";
    const rPending = rProg && "status" in rProg && rProg.status === "pending";
    const stepNumber =
      r.progress?.index !== undefined
        ? r.progress.index + 1
        : progressFromArray?.index !== undefined
          ? progressFromArray.index + 1
          : i + 1;
    const stepStats = formatProgressStats(theme, rProg);
    const glyph = rPending
      ? theme.fg("dim", "◦")
      : resultGlyph(
          r,
          output,
          theme,
          rRunning,
          progressRunningSeed(rProg),
          frame,
        );
    const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
    const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
    const line = `${glyph} ${stepLabel}: ${theme.bold(agentName)}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}${pendingLabel}`;
    c.addChild(new Text(truncLine(`  ${line}`, width), 0, 0));
    if (rRunning && rProg && "status" in rProg) {
      const activity = compactCurrentActivity(rProg);
      c.addChild(
        new Text(truncLine(theme.fg("dim", `    ⎿  ${activity}`), width), 0, 0),
      );
      c.addChild(
        new Text(
          truncLine(theme.fg("accent", `    ${liveDetailHintText()}`), width),
          0,
          0,
        ),
      );
    } else if (
      !rPending &&
      (r.exitCode !== 0 ||
        r.interrupted ||
        r.detached ||
        hasEmptyTextOutputWithoutOutputTarget(r.task, output))
    ) {
      c.addChild(
        new Text(
          truncLine(
            theme.fg(
              r.exitCode !== 0 ? "error" : "dim",
              `    ⎿  ${resultStatusLine(r, output)}`,
            ),
            width,
          ),
          0,
          0,
        ),
      );
    }
    const outputTarget = extractOutputTarget(r.task);
    if (outputTarget)
      c.addChild(
        new Text(
          truncLine(theme.fg("dim", `    output: ${outputTarget}`), width),
          0,
          0,
        ),
      );
    if (r.artifactPaths)
      c.addChild(
        new Text(
          truncLine(
            theme.fg(
              "dim",
              `    output: ${shortenPath(r.artifactPaths.outputPath)}`,
            ),
            width,
          ),
          0,
          0,
        ),
      );
  }
  if (d.artifacts)
    c.addChild(
      new Text(
        truncLine(
          theme.fg("dim", `  artifacts: ${shortenPath(d.artifacts.dir)}`),
          width,
        ),
        0,
        0,
      ),
    );
  return c;
}

/**
 * Render a subagent result
 */
export function renderSubagentResult(
  result: AgentToolResult<Details>,
  options: { expanded: boolean },
  theme: Theme,
  frame?: number,
): Component {
  const d = result.details;
  if (!d || !d.results.length) {
    const t = result.content[0];
    const text = t?.type === "text" ? t.text : "(no output)";
    const contextPrefix =
      d?.context === "fork" ? `${theme.fg("warning", "[fork]")} ` : "";
    const width = getTermWidth() - 4;
    if (!text.includes("\n"))
      return new Text(truncLine(`${contextPrefix}${text}`, width), 0, 0);
    const c = new Container();
    const wrapped = wrapPlainText(`${contextPrefix}${text}`, width);
    for (const line of wrapped) c.addChild(new Text(line, 0, 0));
    return c;
  }

  const expanded = options.expanded;
  const mdTheme = getMarkdownTheme();

  if (d.mode === "single" && d.results.length === 1) {
    const r = d.results[0];
    if (!expanded) return renderSingleCompact(d, r, theme, frame);
    const isRunning = r.progress?.status === "running";
    const icon = isRunning
      ? theme.fg("warning", "running")
      : r.detached
        ? theme.fg("warning", "detached")
        : r.exitCode === 0
          ? theme.fg("success", "ok")
          : theme.fg("error", "failed");
    const contextBadge =
      d.context === "fork" ? theme.fg("warning", " [fork]") : "";
    const output = r.truncation?.text || getSingleResultOutput(r);

    const progressInfo =
      isRunning && r.progress
        ? ` | ${r.progress.toolCount} tools, ${formatTokens(r.progress.tokens)} tok, ${formatDuration(r.progress.durationMs)}`
        : r.progressSummary
          ? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
          : "";

    const w = getTermWidth() - 4;
    const fit = (text: string) => (expanded ? text : truncLine(text, w));
    const toolCallLines = getToolCallLines(r, expanded);
    const c = new Container();
    c.addChild(
      new Text(
        fit(
          `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${progressInfo}`,
        ),
        0,
        0,
      ),
    );
    c.addChild(new Spacer(1));
    const taskMaxLen = Math.max(20, w - 8);
    const taskPreview =
      expanded || r.task.length <= taskMaxLen
        ? r.task
        : `${r.task.slice(0, taskMaxLen)}...`;
    c.addChild(new Text(fit(theme.fg("dim", `Task: ${taskPreview}`)), 0, 0));
    c.addChild(new Spacer(1));

    if (isRunning && r.progress) {
      const progressSnapshotNow = snapshotNowForProgress(r.progress);
      const toolLine = formatCurrentToolLine(
        r.progress,
        w,
        expanded,
        progressSnapshotNow,
      );
      if (toolLine) {
        c.addChild(new Text(fit(theme.fg("warning", `> ${toolLine}`)), 0, 0));
      }
      const liveStatusLine = buildLiveStatusLine(
        r.progress,
        progressSnapshotNow,
      );
      if (liveStatusLine) {
        c.addChild(new Text(fit(theme.fg("accent", liveStatusLine)), 0, 0));
      }
      c.addChild(new Text(fit(theme.fg("accent", liveDetailHintText())), 0, 0));
      if (r.artifactPaths) {
        c.addChild(
          new Text(
            fit(
              theme.fg(
                "dim",
                `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`,
              ),
            ),
            0,
            0,
          ),
        );
      }
      if (r.progress.recentTools?.length) {
        for (const t of r.progress.recentTools.slice(-3)) {
          const maxArgsLen = Math.max(40, w - 24);
          const argsPreview =
            expanded || t.args.length <= maxArgsLen
              ? t.args
              : `${t.args.slice(0, maxArgsLen)}...`;
          c.addChild(
            new Text(fit(theme.fg("dim", `${t.tool}: ${argsPreview}`)), 0, 0),
          );
        }
      }
      for (const line of (r.progress.recentOutput ?? []).slice(-5)) {
        c.addChild(new Text(fit(theme.fg("dim", `  ${line}`)), 0, 0));
      }
      if (
        toolLine ||
        liveStatusLine ||
        r.progress.recentTools?.length ||
        r.progress.recentOutput?.length ||
        r.artifactPaths
      ) {
        c.addChild(new Spacer(1));
      }
    }

    if (expanded) {
      for (const line of toolCallLines) {
        c.addChild(new Text(fit(theme.fg("muted", line)), 0, 0));
      }
      if (toolCallLines.length) c.addChild(new Spacer(1));
    }

    if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
    c.addChild(new Spacer(1));
    if (r.skills?.length) {
      c.addChild(
        new Text(fit(theme.fg("dim", `Skills: ${r.skills.join(", ")}`)), 0, 0),
      );
    }
    if (r.skillsWarning) {
      c.addChild(
        new Text(fit(theme.fg("warning", `Warning: ${r.skillsWarning}`)), 0, 0),
      );
    }
    if (r.attemptedModels && r.attemptedModels.length > 1) {
      c.addChild(
        new Text(
          fit(theme.fg("dim", `Fallbacks: ${r.attemptedModels.join(" → ")}`)),
          0,
          0,
        ),
      );
    }
    c.addChild(
      new Text(fit(theme.fg("dim", formatUsage(r.usage, r.model))), 0, 0),
    );
    if (r.sessionFile) {
      c.addChild(
        new Text(
          fit(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`)),
          0,
          0,
        ),
      );
    }

    if (!isRunning && r.artifactPaths) {
      c.addChild(new Spacer(1));
      c.addChild(
        new Text(
          fit(
            theme.fg(
              "dim",
              `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`,
            ),
          ),
          0,
          0,
        ),
      );
    }
    return c;
  }

  if (!expanded) return renderMultiCompact(d, theme, frame);

  const hasRunning =
    d.progress?.some((p) => p.status === "running") ||
    d.results.some((r) => r.progress?.status === "running") ||
    workflowGraphHasStatus(d, ["running"]);
  const ok = d.results.filter(
    (r) =>
      r.progress?.status === "completed" ||
      (r.exitCode === 0 && r.progress?.status !== "running"),
  ).length;
  const hasEmptyWithoutTarget = d.results.some(
    (r) =>
      r.exitCode === 0 &&
      r.progress?.status !== "running" &&
      hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
  );
  const hasWorkflowFailure = workflowGraphHasStatus(d, ["failed"]);
  const hasWorkflowStop =
    d.results.some((r) => r.stopped && r.progress?.status !== "running") ||
    workflowGraphHasStatus(d, ["stopped"]);
  const hasWorkflowPause = workflowGraphHasStatus(d, ["paused", "detached"]);
  const icon = hasRunning
    ? theme.fg("warning", "running")
    : hasEmptyWithoutTarget
      ? theme.fg("warning", "warning")
      : hasWorkflowFailure
        ? theme.fg("error", "failed")
        : hasWorkflowStop
          ? theme.fg("warning", "stopped")
          : hasWorkflowPause
            ? theme.fg("warning", "paused")
            : ok === d.results.length
              ? theme.fg("success", "ok")
              : theme.fg("error", "failed");

  const totalSummary =
    d.progressSummary ||
    d.results.reduce(
      (acc, r) => {
        const prog = r.progress || r.progressSummary;
        if (prog) {
          acc.toolCount += prog.toolCount;
          acc.tokens += prog.tokens;
          acc.durationMs =
            d.mode === "chain"
              ? acc.durationMs + prog.durationMs
              : Math.max(acc.durationMs, prog.durationMs);
        }
        return acc;
      },
      { toolCount: 0, tokens: 0, durationMs: 0 },
    );

  const summaryParts = [
    totalSummary.toolCount || totalSummary.tokens
      ? `${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tok, ${formatDuration(totalSummary.durationMs)}`
      : "",
    formatTotalCostStat(d.totalCost),
  ].filter(Boolean);
  const summaryStr = summaryParts.length ? ` | ${summaryParts.join(", ")}` : "";

  const modeLabel = d.mode;
  const contextBadge =
    d.context === "fork" ? theme.fg("warning", " [fork]") : "";
  const multiLabel = buildMultiProgressLabel(d, hasRunning);
  const itemTitle = multiLabel.itemTitle;

  const chainVis =
    d.chainAgents?.length && !multiLabel.hasParallelInChain
      ? d.chainAgents
          .map((agent, i) => {
            const result = d.results[i];
            const isFailed =
              result &&
              result.exitCode !== 0 &&
              result.progress?.status !== "running";
            const isComplete =
              result &&
              result.exitCode === 0 &&
              result.progress?.status !== "running";
            const isEmptyWithoutTarget =
              Boolean(result) &&
              Boolean(isComplete) &&
              hasEmptyTextOutputWithoutOutputTarget(
                result.task,
                getSingleResultOutput(result),
              );
            const isCurrent = i === (d.currentStepIndex ?? d.results.length);
            const stepIcon = isFailed
              ? theme.fg("error", "failed")
              : isEmptyWithoutTarget
                ? theme.fg("warning", "warning")
                : isComplete
                  ? theme.fg("success", "done")
                  : isCurrent && hasRunning
                    ? theme.fg("warning", "running")
                    : theme.fg("dim", "pending");
            return `${stepIcon} ${agent}`;
          })
          .join(theme.fg("dim", " → "))
      : null;

  const w = getTermWidth() - 4;
  const fit = (text: string) => (expanded ? text : truncLine(text, w));
  const c = new Container();
  c.addChild(
    new Text(
      fit(
        `${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${contextBadge} · ${multiLabel.headerLabel}${summaryStr}`,
      ),
      0,
      0,
    ),
  );
  if (chainVis) {
    c.addChild(new Text(fit(`  ${chainVis}`), 0, 0));
  }

  const useResultsDirectly =
    multiLabel.hasParallelInChain || !d.chainAgents?.length;
  const displayStart = multiLabel.showActiveGroupOnly
    ? multiLabel.groupStartIndex
    : 0;
  const displayEnd = multiLabel.showActiveGroupOnly
    ? multiLabel.groupEndIndex
    : useResultsDirectly
      ? d.results.length
      : d.chainAgents!.length;
  const chainEntries = buildChainRenderEntries(d, multiLabel);
  const renderEntries =
    chainEntries ??
    Array.from(
      { length: displayEnd - displayStart },
      (_, offset): ChainRenderEntry => {
        const i = displayStart + offset;
        const r = d.results[i];
        const rowNumber = multiLabel.showActiveGroupOnly
          ? i - multiLabel.groupStartIndex + 1
          : i + 1;
        return {
          kind: "result",
          resultIndex: i,
          rowNumber,
          agentName: useResultsDirectly
            ? r?.agent || `step-${rowNumber}`
            : d.chainAgents![i] || r?.agent || `step-${rowNumber}`,
        };
      },
    );

  c.addChild(new Spacer(1));

  for (const entry of renderEntries) {
    if (entry.kind === "placeholder") {
      const statusLabel = widgetStepStatus(
        entry.status as AsyncJobStep["status"],
        theme,
      );
      c.addChild(
        new Text(
          fit(
            `  ${statusLabel} ${entry.stepLabel}: ${theme.bold(entry.agentName)}`,
          ),
          0,
          0,
        ),
      );
      c.addChild(
        new Text(
          theme.fg(
            entry.status === "failed" ? "error" : "dim",
            `    status: ${entry.status}`,
          ),
          0,
          0,
        ),
      );
      if (entry.error)
        c.addChild(
          new Text(theme.fg("error", `    error: ${entry.error}`), 0, 0),
        );
      c.addChild(new Spacer(1));
      continue;
    }
    const i = entry.resultIndex;
    const r = d.results[i];
    const rowNumber = entry.rowNumber;
    const agentName = entry.agentName;

    if (!r) {
      const pendingLabel = chainEntries
        ? resultRowLabel(d, multiLabel, i, rowNumber)
        : `${itemTitle} ${rowNumber}`;
      c.addChild(
        new Text(fit(theme.fg("dim", `  ${pendingLabel}: ${agentName}`)), 0, 0),
      );
      c.addChild(new Text(theme.fg("dim", `    status: pending`), 0, 0));
      c.addChild(new Spacer(1));
      continue;
    }

    const progressFromArray =
      d.progress?.find((p) => p.index === i) ||
      d.progress?.find((p) => p.agent === r.agent && p.status === "running");
    const rProg = r.progress || progressFromArray || r.progressSummary;
    const rRunning = rProg?.status === "running";
    const stepNumber =
      typeof rProg?.index === "number" ? rProg.index + 1 : i + 1;

    const resultOutput = getSingleResultOutput(r);
    const statusIcon = rRunning
      ? theme.fg("warning", "running")
      : r.exitCode !== 0
        ? theme.fg("error", "failed")
        : hasEmptyTextOutputWithoutOutputTarget(r.task, resultOutput)
          ? theme.fg("warning", "warning")
          : theme.fg("success", "done");
    const stats = rProg
      ? ` | ${rProg.toolCount} tools, ${formatDuration(rProg.durationMs)}`
      : "";
    const modelDisplay = modelThinkingBadge(theme, r.model);
    const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
    const stepHeader = rRunning
      ? `${statusIcon} ${stepLabel}: ${theme.bold(theme.fg("warning", r.agent))}${modelDisplay}${stats}`
      : `${statusIcon} ${stepLabel}: ${theme.bold(r.agent)}${modelDisplay}${stats}`;
    const toolCallLines = getToolCallLines(r, expanded);
    c.addChild(new Text(fit(stepHeader), 0, 0));

    const taskMaxLen = Math.max(20, w - 12);
    const taskPreview =
      expanded || r.task.length <= taskMaxLen
        ? r.task
        : `${r.task.slice(0, taskMaxLen)}...`;
    c.addChild(
      new Text(fit(theme.fg("dim", `    task: ${taskPreview}`)), 0, 0),
    );

    const outputTarget = extractOutputTarget(r.task);
    if (outputTarget) {
      c.addChild(
        new Text(fit(theme.fg("dim", `    output: ${outputTarget}`)), 0, 0),
      );
    }

    if (r.skills?.length) {
      c.addChild(
        new Text(
          fit(theme.fg("dim", `    skills: ${r.skills.join(", ")}`)),
          0,
          0,
        ),
      );
    }
    if (r.skillsWarning) {
      c.addChild(
        new Text(
          fit(theme.fg("warning", `    Warning: ${r.skillsWarning}`)),
          0,
          0,
        ),
      );
    }
    if (r.attemptedModels && r.attemptedModels.length > 1) {
      c.addChild(
        new Text(
          fit(
            theme.fg("dim", `    fallbacks: ${r.attemptedModels.join(" → ")}`),
          ),
          0,
          0,
        ),
      );
    }

    if (rRunning && rProg) {
      if (rProg.skills?.length) {
        c.addChild(
          new Text(
            fit(theme.fg("accent", `    skills: ${rProg.skills.join(", ")}`)),
            0,
            0,
          ),
        );
      }
      const progressSnapshotNow = snapshotNowForProgress(rProg);
      const toolLine = formatCurrentToolLine(
        rProg,
        w,
        expanded,
        progressSnapshotNow,
      );
      if (toolLine) {
        c.addChild(
          new Text(fit(theme.fg("warning", `    > ${toolLine}`)), 0, 0),
        );
      }
      const liveStatusLine = buildLiveStatusLine(rProg, progressSnapshotNow);
      if (liveStatusLine) {
        c.addChild(
          new Text(fit(theme.fg("accent", `    ${liveStatusLine}`)), 0, 0),
        );
      }
      c.addChild(
        new Text(fit(theme.fg("accent", `    ${liveDetailHintText()}`)), 0, 0),
      );
      if (r.artifactPaths) {
        c.addChild(
          new Text(
            fit(
              theme.fg(
                "dim",
                `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`,
              ),
            ),
            0,
            0,
          ),
        );
      }
      if (rProg.recentTools?.length) {
        for (const t of rProg.recentTools.slice(-3)) {
          const maxArgsLen = Math.max(40, w - 30);
          const argsPreview =
            expanded || t.args.length <= maxArgsLen
              ? t.args
              : `${t.args.slice(0, maxArgsLen)}...`;
          c.addChild(
            new Text(
              fit(theme.fg("dim", `      ${t.tool}: ${argsPreview}`)),
              0,
              0,
            ),
          );
        }
      }
      const recentLines = (rProg.recentOutput ?? []).slice(-5);
      for (const line of recentLines) {
        c.addChild(new Text(fit(theme.fg("dim", `      ${line}`)), 0, 0));
      }
    }

    if (!rRunning && r.artifactPaths) {
      c.addChild(
        new Text(
          fit(
            theme.fg(
              "dim",
              `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`,
            ),
          ),
          0,
          0,
        ),
      );
    }

    if (expanded && !rRunning) {
      for (const line of toolCallLines) {
        c.addChild(new Text(fit(theme.fg("muted", `      ${line}`)), 0, 0));
      }
      if (toolCallLines.length) c.addChild(new Spacer(1));
    }

    c.addChild(new Spacer(1));
  }

  if (d.artifacts) {
    c.addChild(new Spacer(1));
    c.addChild(
      new Text(
        fit(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`)),
        0,
        0,
      ),
    );
  }
  return c;
}
