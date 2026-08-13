/**
 * Basic types shared across the subagent extension.
 */

import type {
  NestedRunAddress,
  NestedStepSummary,
  NestedRunSummary,
} from "./async.ts";
import type { AcceptanceLedgerStatus } from "./results.ts";

export interface MaxOutputConfig {
  bytes?: number;
  lines?: number;
}

export type OutputMode = "inline" | "file-only";

export type JsonSchemaObject = Record<string, unknown>;

export interface ChainOutputMapEntry {
  text: string;
  structured?: unknown;
  agent: string;
  stepIndex: number;
}

export type ChainOutputMap = Record<string, ChainOutputMapEntry>;

export type WorkflowNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "stopped"
  | "detached";

export interface WorkflowGraphNode {
  id: string;
  kind: "step" | "parallel-group" | "dynamic-parallel-group" | "agent";
  agent?: string;
  phase?: string;
  label: string;
  status: WorkflowNodeStatus;
  flatIndex?: number;
  stepIndex?: number;
  children?: WorkflowGraphNode[];
  dynamic?: {
    sourceOutput: string;
    sourcePath: string;
    itemName: string;
    maxItems?: number;
    collectAs?: string;
  };
  itemKey?: string;
  outputName?: string;
  structured?: boolean;
  acceptanceStatus?: AcceptanceLedgerStatus;
  error?: string;
}

export interface WorkflowGraphSnapshot {
  runId: string;
  mode: "chain" | "parallel" | "single";
  phases: Array<{ title: string; nodeIds: string[] }>;
  nodes: WorkflowGraphNode[];
  currentNodeId?: string;
}

export interface SavedOutputReference {
  path: string;
  bytes: number;
  lines: number;
  message: string;
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
  originalBytes?: number;
  originalLines?: number;
  artifactPath?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface TurnBudgetConfig {
  maxTurns: number;
  graceTurns?: number;
}

export interface ResolvedTurnBudget {
  maxTurns: number;
  graceTurns: number;
}

export interface ToolBudgetConfig {
  soft?: number;
  hard: number;
  block?: string[] | "*";
}

export interface ResolvedToolBudget {
  soft?: number;
  hard: number;
  block: string[] | "*";
}

export type ToolBudgetOutcome =
  "within-budget" | "soft-reached" | "hard-blocked";

export interface ToolBudgetState extends ResolvedToolBudget {
  outcome: ToolBudgetOutcome;
  toolCount: number;
  softReachedAt?: number;
  hardReachedAt?: number;
  blockedTool?: string;
}

export type TurnBudgetOutcome =
  "within-budget" | "wrap-up-requested" | "exceeded";

export interface TurnBudgetState extends ResolvedTurnBudget {
  outcome: TurnBudgetOutcome;
  turnCount: number;
  wrapUpRequestedAtTurn?: number;
  exceededAtTurn?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export type ActivityState = "active_long_running" | "needs_attention";
export type ControlEventType = "active_long_running" | "needs_attention";
export type ControlNotificationChannel = "event" | "async" | "intercom";

export interface ControlConfig {
  enabled?: boolean;
  needsAttentionAfterMs?: number;
  activeNoticeAfterMs?: number;
  activeNoticeAfterTurns?: number;
  activeNoticeAfterTokens?: number;
  failedToolAttemptsBeforeAttention?: number;
  notifyOn?: ControlEventType[];
  notifyChannels?: ControlNotificationChannel[];
}

export interface ResolvedControlConfig {
  enabled: boolean;
  needsAttentionAfterMs: number;
  activeNoticeAfterMs: number;
  activeNoticeAfterTurns?: number;
  activeNoticeAfterTokens?: number;
  failedToolAttemptsBeforeAttention: number;
  notifyOn: ControlEventType[];
  notifyChannels: ControlNotificationChannel[];
}

/**
 * Smart completion batching for async-completion notifications. Successful
 * sibling completions are held briefly so they arrive as one grouped message;
 * failure and attention signals bypass grouping and always fire immediately.
 */
export interface CompletionBatchConfig {
  enabled?: boolean;
  /** Idle window after each arrival; resets on every new item. */
  debounceMs?: number;
  /** Hard cap measured from the first item in a group. */
  maxWaitMs?: number;
  /** Shorter idle window for straggler groups. */
  stragglerDebounceMs?: number;
  /** Shorter hard cap for straggler groups. */
  stragglerMaxWaitMs?: number;
  /** Arrivals within this window after an emit join a straggler group. */
  stragglerWindowMs?: number;
}

export interface WaitToolConfigObject {
  enabled?: boolean;
}

export type WaitToolConfig = boolean | WaitToolConfigObject;

export interface ControlEvent {
  type: ControlEventType;
  from?: ActivityState;
  to: ActivityState;
  ts: number;
  agent: string;
  index?: number;
  runId: string;
  nestedRunId?: string;
  nestingPath?: NestedRunAddress["path"];
  message: string;
  reason?:
    | "idle"
    | "completion_guard"
    | "active_long_running"
    | "tool_failures"
    | "time_threshold"
    | "turn_threshold"
    | "token_threshold";
  turns?: number;
  tokens?: number;
  toolCount?: number;
  currentTool?: string;
  currentToolDurationMs?: number;
  currentPath?: string;
  elapsedMs?: number;
  recentFailureSummary?: string;
}

export type SubagentResultStatus =
  "completed" | "failed" | "paused" | "stopped" | "detached";
export type SubagentRunMode = "single" | "parallel" | "chain";
export const SUBAGENT_LIFECYCLE_ARTIFACT_VERSION = 1;
export type SubagentLifecycleArtifactVersion =
  typeof SUBAGENT_LIFECYCLE_ARTIFACT_VERSION;

export type PublicNestedStepSummary = Pick<
  NestedStepSummary,
  | "agent"
  | "status"
  | "sessionFile"
  | "transcriptPath"
  | "transcriptError"
  | "activityState"
  | "lastActivityAt"
  | "currentTool"
  | "currentToolStartedAt"
  | "currentPath"
  | "turnCount"
  | "toolCount"
  | "toolBudget"
  | "toolBudgetBlocked"
  | "startedAt"
  | "endedAt"
  | "error"
  | "timedOut"
  | "stopped"
> & {
  children?: PublicNestedRunSummary[];
};

export type CostSummary = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type PublicNestedRunSummary = Pick<
  NestedRunSummary,
  | "id"
  | "parentRunId"
  | "parentStepIndex"
  | "parentAgent"
  | "depth"
  | "path"
  | "asyncDir"
  | "sessionId"
  | "sessionFile"
  | "intercomTarget"
  | "ownerIntercomTarget"
  | "leafIntercomTarget"
  | "ownerState"
  | "mode"
  | "state"
  | "agent"
  | "agents"
  | "currentStep"
  | "chainStepCount"
  | "parallelGroups"
  | "activityState"
  | "lastActivityAt"
  | "currentTool"
  | "currentToolStartedAt"
  | "currentPath"
  | "turnCount"
  | "toolCount"
  | "toolBudget"
  | "toolBudgetBlocked"
  | "totalTokens"
  | "totalCost"
  | "startedAt"
  | "endedAt"
  | "lastUpdate"
  | "error"
  | "timeoutMs"
  | "deadlineAt"
  | "timedOut"
  | "stopped"
  | "turnBudget"
  | "turnBudgetExceeded"
  | "wrapUpRequested"
> & {
  steps?: PublicNestedStepSummary[];
  children?: PublicNestedRunSummary[];
};

export interface SubagentResultIntercomChild {
  agent: string;
  status: SubagentResultStatus;
  summary: string;
  index?: number;
  artifactPath?: string;
  sessionPath?: string;
  intercomTarget?: string;
  children?: PublicNestedRunSummary[];
}

export interface SubagentResultIntercomPayload {
  to: string;
  message: string;
  requestId?: string;
  runId: string;
  mode: SubagentRunMode;
  status: SubagentResultStatus;
  summary: string;
  source: "foreground" | "async";
  children: SubagentResultIntercomChild[];
  asyncId?: string;
  asyncDir?: string;
  chainSteps?: number;
  agent?: string;
  index?: number;
  artifactPath?: string;
  sessionPath?: string;
}
