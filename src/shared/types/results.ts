/**
 * Result and acceptance types: per-agent run results, acceptance ledger, artifacts.
 */

import type { Message } from "@earendil-works/pi-ai";
import type {
  Usage,
  TurnBudgetState,
  ToolBudgetState,
  OutputMode,
  TruncationResult,
  SubagentRunMode,
  ControlEvent,
  ResolvedTurnBudget,
  ResolvedToolBudget,
  WorkflowGraphSnapshot,
  ChainOutputMap,
  CostSummary,
  SavedOutputReference,
} from "./basic.ts";
import type { NestedRunSummary } from "./async.ts";
import type {
  AgentProgress,
  ProgressSummary,
  ChildWatchdogProgress,
  ToolCallSummary,
} from "./progress.ts";

export interface ArtifactPaths {
  inputPath: string;
  outputPath: string;
  jsonlPath: string;
  transcriptPath: string;
  metadataPath: string;
}

export interface ArtifactConfig {
  enabled: boolean;
  includeInput: boolean;
  includeOutput: boolean;
  includeJsonl: boolean;
  includeTranscript?: boolean;
  includeMetadata: boolean;
  cleanupDays: number;
}

export interface ModelAttempt {
  model: string;
  success: boolean;
  exitCode?: number | null;
  error?: string;
  usage?: Usage;
}

export type AcceptanceLevel =
  "auto" | "none" | "attested" | "checked" | "verified" | "reviewed";

export type AcceptanceEvidenceKind =
  | "changed-files"
  | "tests-added"
  | "commands-run"
  | "validation-output"
  | "residual-risks"
  | "no-staged-files"
  | "diff-summary"
  | "review-findings"
  | "manual-notes";

export interface AcceptanceGate {
  id: string;
  must: string;
  evidence?: AcceptanceEvidenceKind[];
  severity?: "required" | "recommended";
}

export interface AcceptanceVerifyCommand {
  id: string;
  command: string;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  allowFailure?: boolean;
}

export interface AcceptanceReviewGate {
  agent?: string;
  focus?: string;
  required?: boolean;
}

export interface AcceptanceConfig {
  level?: AcceptanceLevel;
  criteria?: Array<string | AcceptanceGate>;
  evidence?: AcceptanceEvidenceKind[];
  verify?: AcceptanceVerifyCommand[];
  review?: AcceptanceReviewGate | false;
  stopRules?: string[];
  reason?: string;
}

export type AcceptanceInput = AcceptanceLevel | false | AcceptanceConfig;

export interface ResolvedAcceptanceGate extends AcceptanceGate {
  id: string;
  must: string;
  evidence: AcceptanceEvidenceKind[];
  severity: "required" | "recommended";
}

export interface ResolvedAcceptanceConfig {
  level: Exclude<AcceptanceLevel, "auto">;
  explicit: boolean;
  inferredReason: string[];
  criteria: ResolvedAcceptanceGate[];
  evidence: AcceptanceEvidenceKind[];
  verify: AcceptanceVerifyCommand[];
  review?: AcceptanceReviewGate | false;
  stopRules: string[];
  reason?: string;
}

export interface AcceptanceReport {
  criteriaSatisfied?: Array<{
    id?: string;
    status: "satisfied" | "not-satisfied" | "not-applicable";
    evidence: string;
  }>;
  changedFiles?: string[];
  testsAddedOrUpdated?: string[];
  commandsRun?: Array<{
    command: string;
    result: "passed" | "failed" | "not-run";
    summary: string;
  }>;
  validationOutput?: string[];
  residualRisks?: string[];
  noStagedFiles?: boolean;
  diffSummary?: string;
  reviewFindings?: string[];
  manualNotes?: string;
  notes?: string;
}

export type AcceptanceRuntimeCheckStatus =
  "passed" | "failed" | "not-applicable";

export interface AcceptanceRuntimeCheck {
  id: string;
  status: AcceptanceRuntimeCheckStatus;
  message: string;
}

export interface AcceptanceVerifyResult {
  id: string;
  command: string;
  cwd?: string;
  exitCode: number | null;
  status: "passed" | "failed" | "timed-out" | "allowed-failure";
  stdout?: string;
  stderr?: string;
  durationMs: number;
}

export interface AcceptanceReviewResult {
  status: "no-blockers" | "blockers" | "needs-parent-decision";
  findings: Array<{
    severity: "blocker" | "non-blocking";
    file?: string;
    issue: string;
    rationale: string;
  }>;
}

export type AcceptanceLedgerStatus =
  | "not-required"
  | "claimed"
  | "attested"
  | "checked"
  | "verified"
  | "reviewed"
  | "accepted"
  | "rejected";

export interface AcceptanceLedger {
  status: AcceptanceLedgerStatus;
  explicit: boolean;
  effectiveAcceptance: ResolvedAcceptanceConfig;
  inferredReason: string[];
  criteria: ResolvedAcceptanceGate[];
  childReport?: AcceptanceReport;
  childReportParseError?: string;
  runtimeChecks: AcceptanceRuntimeCheck[];
  verifyRuns: AcceptanceVerifyResult[];
  reviewResult?: AcceptanceReviewResult;
  parentDecision?: {
    status: "accepted" | "rejected";
    at: string;
    reason?: string;
  };
}

export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  detached?: boolean;
  detachedReason?: string;
  interrupted?: boolean;
  timedOut?: boolean;
  stopped?: boolean;
  turnBudget?: TurnBudgetState;
  turnBudgetExceeded?: boolean;
  wrapUpRequested?: boolean;
  toolBudget?: ToolBudgetState;
  toolBudgetBlocked?: boolean;
  messages?: Message[];
  usage: Usage;
  model?: string;
  attemptedModels?: string[];
  modelAttempts?: ModelAttempt[];
  controlEvents?: ControlEvent[];
  error?: string;
  sessionFile?: string;
  skills?: string[];
  skillsWarning?: string;
  progress?: AgentProgress;
  progressSummary?: ProgressSummary;
  toolCalls?: ToolCallSummary[];
  artifactPaths?: ArtifactPaths;
  truncation?: TruncationResult;
  finalOutput?: string;
  outputMode?: OutputMode;
  savedOutputPath?: string;
  outputReference?: SavedOutputReference;
  outputSaveError?: string;
  structuredOutput?: unknown;
  structuredOutputPath?: string;
  structuredOutputSchemaPath?: string;
  acceptance?: AcceptanceLedger;
  transcriptPath?: string;
  transcriptError?: string;
  children?: NestedRunSummary[];
  watchdog?: ChildWatchdogProgress;
}

export interface Details {
  mode: SubagentRunMode | "management";
  runId?: string;
  context?: "fresh" | "fork";
  results: SingleResult[];
  controlEvents?: ControlEvent[];
  asyncId?: string;
  asyncDir?: string;
  timeoutMs?: number;
  deadlineAt?: number;
  timedOut?: boolean;
  stopped?: boolean;
  turnBudget?: ResolvedTurnBudget;
  toolBudget?: ResolvedToolBudget;
  progress?: AgentProgress[];
  progressSummary?: ProgressSummary;
  artifacts?: {
    dir: string;
    files: ArtifactPaths[];
  };
  truncation?: {
    truncated: boolean;
    originalBytes?: number;
    originalLines?: number;
    artifactPath?: string;
  };
  // Chain metadata for observability
  chainAgents?: string[]; // Agent names in order, e.g., ["scout", "planner"]
  totalSteps?: number; // Total steps in chain
  currentStepIndex?: number; // 0-indexed current step (for running chains)
  workflowGraph?: WorkflowGraphSnapshot;
  outputs?: ChainOutputMap;
  // Aggregated child usage across all agents in the run
  totalChildUsage?: Usage;
  // Aggregated cost across all agents in the run
  totalCost?: CostSummary;
}
