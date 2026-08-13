/**
 * Core agent/chain configuration types shared across agent discovery and management.
 */

import type {
  AcceptanceInput,
  OutputMode,
  ToolBudgetConfig,
  TurnBudgetConfig,
} from "../shared/types.ts";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "builtin" | "package" | "user" | "project";
export type SystemPromptMode = "append" | "replace";
export type AgentDefaultContext = "fresh" | "fork";

export type AgentMemoryScope = "project" | "user";

export interface AgentMemoryConfig {
  scope: AgentMemoryScope;
  path: string;
}

export const BUILTIN_AGENT_NAMES = [
  "context-builder",
  "delegate",
  "oracle",
  "planner",
  "researcher",
  "reviewer",
  "scout",
  "worker",
] as const;

export function defaultSystemPromptMode(name: string): SystemPromptMode {
  return name === "delegate" ? "append" : "replace";
}

export function defaultInheritProjectContext(name: string): boolean {
  return name === "delegate";
}

export function defaultInheritSkills(): boolean {
  return false;
}

export interface BuiltinAgentOverrideBase {
  model?: string;
  fallbackModels?: string[];
  thinking?: string | false;
  systemPromptMode: SystemPromptMode;
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  defaultContext?: AgentDefaultContext;
  disabled?: boolean;
  systemPrompt: string;
  skills?: string[];
  tools?: string[];
  mcpDirectTools?: string[];
  subagentOnlyExtensions?: string[];
  completionGuard?: boolean;
  toolBudget?: ToolBudgetConfig;
}

interface BuiltinAgentOverrideInfo {
  scope: "user" | "project";
  path: string;
  base: BuiltinAgentOverrideBase;
}

export interface AgentModelSourceInfo {
  type: "subagents.defaultModel";
  scope: "user" | "project";
  path: string;
  model: string;
}

export interface AgentConfig {
  name: string;
  localName?: string;
  packageName?: string;
  description: string;
  tools?: string[];
  mcpDirectTools?: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: string | false;
  systemPromptMode: SystemPromptMode;
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  defaultContext?: AgentDefaultContext;
  defaultAsync?: boolean;
  defaultTimeoutMs?: number;
  defaultTurnBudget?: TurnBudgetConfig;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
  skills?: string[];
  extensions?: string[];
  subagentOnlyExtensions?: string[];
  output?: string;
  defaultReads?: string[];
  defaultProgress?: boolean;
  interactive?: boolean;
  maxSubagentDepth?: number;
  completionGuard?: boolean;
  toolBudget?: ToolBudgetConfig;
  memory?: AgentMemoryConfig;
  disabled?: boolean;
  extraFields?: Record<string, string>;
  override?: BuiltinAgentOverrideInfo;
  modelSource?: AgentModelSourceInfo;
}

export interface ChainStepConfig {
  agent?: string;
  task?: string;
  phase?: string;
  label?: string;
  as?: string;
  outputSchema?: string | Record<string, unknown>;
  output?: string | false;
  outputMode?: OutputMode;
  reads?: string[] | false;
  model?: string;
  skills?: string[] | false;
  progress?: boolean;
  parallel?: unknown;
  expand?: unknown;
  collect?: unknown;
  concurrency?: number;
  failFast?: boolean;
  worktree?: boolean;
  acceptance?: AcceptanceInput;
  toolBudget?: ToolBudgetConfig;
}

export interface ChainConfig {
  name: string;
  localName?: string;
  packageName?: string;
  description: string;
  source: AgentSource;
  filePath: string;
  steps: ChainStepConfig[];
  extraFields?: Record<string, string>;
}

export interface ChainDiscoveryDiagnostic {
  source: AgentSource;
  filePath: string;
  error: string;
}
