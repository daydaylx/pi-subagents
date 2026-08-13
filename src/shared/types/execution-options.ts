/**
 * Display items, error-handling types, and the runSync execution-options surface.
 */

import type { WidgetPlacement } from "@earendil-works/pi-coding-agent";
import type { ModelScopeConfig } from "../../runs/shared/model-scope.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import type {
  MaxOutputConfig,
  ResolvedTurnBudget,
  ResolvedToolBudget,
  OutputMode,
  SubagentRunMode,
  JsonSchemaObject,
  ControlEvent,
  ControlConfig,
  ResolvedControlConfig,
  CompletionBatchConfig,
  TurnBudgetConfig,
  ToolBudgetConfig,
  WaitToolConfig,
} from "./basic.ts";
import type { NestedRouteInfo } from "./async.ts";
import type {
  Details,
  SingleResult,
  ArtifactConfig,
  AcceptanceInput,
} from "./results.ts";

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown> };

export interface ErrorInfo {
  hasError: boolean;
  exitCode?: number;
  errorType?: string;
  details?: string;
}

export interface IntercomEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT =
  "subagent:result-intercom-delivery";

export interface RunSyncOptions {
  /** Session id of the direct parent session for permission-system ask forwarding. */
  parentSessionId?: string;
  cwd?: string;
  signal?: AbortSignal;
  interruptSignal?: AbortSignal;
  timeoutMs?: number;
  deadlineAt?: number;
  turnBudget?: ResolvedTurnBudget;
  toolBudget?: ResolvedToolBudget;
  allowIntercomDetach?: boolean;
  intercomEvents?: IntercomEventBus;
  onUpdate?: (
    r: import("@earendil-works/pi-agent-core").AgentToolResult<Details>,
  ) => void;
  onControlEvent?: (event: ControlEvent) => void;
  onDetachedExit?: (result: SingleResult) => void;
  controlConfig?: ResolvedControlConfig;
  intercomSessionName?: string;
  orchestratorIntercomTarget?: string;
  maxOutput?: MaxOutputConfig;
  artifactsDir?: string;
  artifactConfig?: ArtifactConfig;
  runId: string;
  index?: number;
  sessionDir?: string;
  sessionFile?: string;
  share?: boolean;
  outputPath?: string;
  outputMode?: OutputMode;
  maxSubagentDepth?: number;
  nestedRoute?: NestedRouteInfo;
  /** Override the agent's default model (format: "provider/id" or just "id") */
  modelOverride?: string;
  /** Override the agent's default thinking level for this run */
  thinkingOverride?: AgentConfig["thinking"];
  /** Registry models available for heuristic bare-model resolution */
  availableModels?: Array<{ provider: string; id: string; fullId: string }>;
  /** Current parent-session provider to prefer for ambiguous bare model ids */
  preferredModelProvider?: string;
  /** Optional subagent model-scope enforcement for fallback candidates */
  modelScope?: ModelScopeConfig;
  /** Skills to make available (overrides agent default if provided) */
  skills?: string[];
  structuredOutput?: {
    schema: JsonSchemaObject;
    schemaPath: string;
    outputPath: string;
  };
  acceptance?: AcceptanceInput;
  acceptanceContext?: {
    mode?: SubagentRunMode;
    async?: boolean;
    dynamic?: boolean;
    dynamicGroup?: boolean;
  };
}

export type IntercomBridgeMode = "off" | "fork-only" | "always";

export interface IntercomBridgeConfig {
  mode?: IntercomBridgeMode;
  instructionFile?: string;
}

interface TopLevelParallelConfig {
  maxTasks?: number;
  concurrency?: number;
}

interface ExtensionChainConfig {
  dynamicFanout?: {
    maxItems?: number;
  };
}

export interface ProactiveSkillSubagentsConfig {
  enabled?: boolean;
  minReferences?: number;
  maxRecommendations?: number;
  preferredAgent?: string;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

/**
 * Parameter surface registered for the parent-facing `subagent` tool.
 *
 * "full" is the complete schema. "harness" is the reduced surface a host needs
 * that only runs single subagents: SINGLE execution plus the four management
 * actions `list`, `status`, `stop` and `interrupt`. It is deliberately its own
 * setting — the visible tool *description* is chosen by `toolDescriptionMode`
 * and says nothing about which parameters are accepted.
 */
export type ToolSchemaMode = "full" | "harness";

export interface ScheduledRunsConfig {
  enabled?: boolean;
  maxLatenessMs?: number;
  maxPending?: number;
}

/** Presentation controls for the parent session. */
export interface SubagentUiConfig {
  /**
   * Show the asynchronous-job widget above the editor. Defaults to true for
   * backwards compatibility; hosts that render a compact tool timeline can
   * turn it off to keep each tool to one visible history trace.
   */
  showAsyncWidget?: boolean;
  /** Enable the read-only Fleet Status Dock. Defaults to false. */
  fleetView?: boolean;
  /** Placement of the Fleet Status Dock widget. Defaults to "belowEditor". */
  fleetViewPlacement?: WidgetPlacement;
}

export interface ExtensionConfig {
  asyncByDefault?: boolean;
  /** Tool description variant registered for the parent-facing subagent tool. Defaults to full. */
  toolDescriptionMode?: ToolDescriptionMode;
  /** Parameter surface registered for the parent-facing subagent tool. Defaults to full. */
  toolSchemaMode?: ToolSchemaMode;
  forceTopLevelAsync?: boolean;
  waitTool?: WaitToolConfig;
  defaultSessionDir?: string;
  singleRunOutputBaseDir?: string;
  maxSubagentDepth?: number;
  maxSubagentSpawnsPerSession?: number;
  /** Global cap on simultaneously-running subagent tasks within a single run. Defaults to 20. */
  globalConcurrencyLimit?: number;
  control?: ControlConfig;
  completionBatch?: CompletionBatchConfig;
  turnBudget?: TurnBudgetConfig;
  toolBudget?: ToolBudgetConfig;
  parallel?: TopLevelParallelConfig;
  chain?: ExtensionChainConfig;
  worktreeSetupHook?: string;
  worktreeSetupHookTimeoutMs?: number;
  worktreeBaseDir?: string;
  intercomBridge?: IntercomBridgeConfig;
  proactiveSkillSubagents?: ProactiveSkillSubagentsConfig | false;
  scheduledRuns?: ScheduledRunsConfig;
  ui?: SubagentUiConfig;
}
