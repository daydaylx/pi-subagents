/**
 * Reading, cloning, and persisting builtin/custom agent overrides in settings.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelScopeConfig } from "../runs/shared/model-scope.ts";
import { parseModelScopeConfig } from "../runs/shared/model-scope.ts";
import type { ToolBudgetConfig } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import type {
  AgentConfig,
  AgentDefaultContext,
  AgentModelSourceInfo,
  SystemPromptMode,
} from "./agent-types.ts";

export interface BuiltinAgentOverrideConfig {
  model?: string | false;
  fallbackModels?: string[] | false;
  thinking?: string | false;
  systemPromptMode?: SystemPromptMode;
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  defaultContext?: AgentDefaultContext | false;
  disabled?: boolean;
  systemPrompt?: string;
  skills?: string[] | false;
  tools?: string[] | false;
  subagentOnlyExtensions?: string[] | false;
  completionGuard?: boolean;
  toolBudget?: ToolBudgetConfig | false;
}

export interface SubagentSettings {
  overrides: Record<string, BuiltinAgentOverrideConfig>;
  defaultModel?: string;
  disableBuiltins?: boolean;
  disableThinking?: boolean;
  modelScope?: ModelScopeConfig;
}

export const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };
export const agentFrontmatterFields = new WeakMap<AgentConfig, Set<string>>();

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function findNearestProjectRoot(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    if (
      isDirectory(getProjectConfigDir(currentDir)) ||
      isDirectory(path.join(currentDir, ".agents"))
    ) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function getUserAgentSettingsPath(): string {
  return path.join(getAgentDir(), "settings.json");
}

export function getProjectAgentSettingsPath(cwd: string): string | null {
  const projectRoot = findNearestProjectRoot(cwd);
  return projectRoot
    ? path.join(getProjectConfigDir(projectRoot), "settings.json")
    : null;
}

function readSettingsFileStrict(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read settings file '${filePath}': ${message}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse settings file '${filePath}': ${message}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function writeSettingsFile(
  filePath: string,
  settings: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function parseOverrideStringArrayOrFalse(
  value: unknown,
  meta: { filePath: string; name: string; field: string },
): string[] | false | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (!Array.isArray(value)) {
    throw new Error(
      `Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`,
    );
  }

  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(
        `Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`,
      );
    }
    const trimmed = item.trim();
    if (trimmed) items.push(trimmed);
  }
  return items;
}

function parseBuiltinOverrideEntry(
  name: string,
  value: unknown,
  filePath: string,
): BuiltinAgentOverrideConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Builtin override '${name}' in '${filePath}' must be an object.`,
    );
  }

  const input = value as Record<string, unknown>;
  const override: BuiltinAgentOverrideConfig = {};

  if ("model" in input) {
    if (typeof input.model === "string" || input.model === false)
      override.model = input.model;
    else
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'model'; expected a string or false.`,
      );
  }

  if ("thinking" in input) {
    if (typeof input.thinking === "string" || input.thinking === false)
      override.thinking = input.thinking;
    else
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'thinking'; expected a string or false.`,
      );
  }

  if ("systemPromptMode" in input) {
    if (
      input.systemPromptMode === "append" ||
      input.systemPromptMode === "replace"
    ) {
      override.systemPromptMode = input.systemPromptMode;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'systemPromptMode'; expected 'append' or 'replace'.`,
      );
    }
  }

  if ("inheritProjectContext" in input) {
    if (typeof input.inheritProjectContext === "boolean") {
      override.inheritProjectContext = input.inheritProjectContext;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'inheritProjectContext'; expected a boolean.`,
      );
    }
  }

  if ("inheritSkills" in input) {
    if (typeof input.inheritSkills === "boolean") {
      override.inheritSkills = input.inheritSkills;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'inheritSkills'; expected a boolean.`,
      );
    }
  }

  if ("defaultContext" in input) {
    if (
      input.defaultContext === "fresh" ||
      input.defaultContext === "fork" ||
      input.defaultContext === false
    ) {
      override.defaultContext = input.defaultContext;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'defaultContext'; expected 'fresh', 'fork', or false.`,
      );
    }
  }

  if ("disabled" in input) {
    if (typeof input.disabled === "boolean") {
      override.disabled = input.disabled;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'disabled'; expected a boolean.`,
      );
    }
  }

  if ("completionGuard" in input) {
    if (typeof input.completionGuard === "boolean") {
      override.completionGuard = input.completionGuard;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'completionGuard'; expected a boolean.`,
      );
    }
  }

  if ("toolBudget" in input) {
    if (input.toolBudget === false) {
      override.toolBudget = false;
    } else if (
      input.toolBudget &&
      typeof input.toolBudget === "object" &&
      !Array.isArray(input.toolBudget)
    ) {
      override.toolBudget = input.toolBudget as ToolBudgetConfig;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'toolBudget'; expected an object or false.`,
      );
    }
  }

  if ("systemPrompt" in input) {
    if (typeof input.systemPrompt === "string")
      override.systemPrompt = input.systemPrompt;
    else
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'systemPrompt'; expected a string.`,
      );
  }

  const fallbackModels = parseOverrideStringArrayOrFalse(input.fallbackModels, {
    filePath,
    name,
    field: "fallbackModels",
  });
  if (fallbackModels !== undefined) override.fallbackModels = fallbackModels;

  const skills = parseOverrideStringArrayOrFalse(input.skills, {
    filePath,
    name,
    field: "skills",
  });
  if (skills !== undefined) override.skills = skills;

  const tools = parseOverrideStringArrayOrFalse(input.tools, {
    filePath,
    name,
    field: "tools",
  });
  if (tools !== undefined) override.tools = tools;

  const subagentOnlyExtensions = parseOverrideStringArrayOrFalse(
    input.subagentOnlyExtensions,
    { filePath, name, field: "subagentOnlyExtensions" },
  );
  if (subagentOnlyExtensions !== undefined)
    override.subagentOnlyExtensions = subagentOnlyExtensions;

  return Object.keys(override).length > 0 ? override : undefined;
}

export function readSubagentSettings(
  filePath: string | null,
): SubagentSettings {
  if (!filePath) return EMPTY_SUBAGENT_SETTINGS;
  const settings = readSettingsFileStrict(filePath);
  const subagents = settings.subagents;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
    return EMPTY_SUBAGENT_SETTINGS;

  const subagentsObject = subagents as Record<string, unknown>;
  let disableBuiltins: boolean | undefined;
  if ("disableBuiltins" in subagentsObject) {
    if (typeof subagentsObject.disableBuiltins === "boolean") {
      disableBuiltins = subagentsObject.disableBuiltins;
    } else {
      throw new Error(
        `Subagent settings in '${filePath}' have invalid 'disableBuiltins'; expected a boolean.`,
      );
    }
  }
  let disableThinking: boolean | undefined;
  if ("disableThinking" in subagentsObject) {
    if (typeof subagentsObject.disableThinking === "boolean") {
      disableThinking = subagentsObject.disableThinking;
    } else {
      throw new Error(
        `Subagent settings in '${filePath}' have invalid 'disableThinking'; expected a boolean.`,
      );
    }
  }
  let defaultModel: string | undefined;
  if ("defaultModel" in subagentsObject) {
    if (
      typeof subagentsObject.defaultModel === "string" &&
      subagentsObject.defaultModel.trim()
    ) {
      defaultModel = subagentsObject.defaultModel.trim();
    } else {
      throw new Error(
        `Subagent settings in '${filePath}' have invalid 'defaultModel'; expected a non-empty string.`,
      );
    }
  }
  const modelScope = parseModelScopeConfig(subagentsObject.modelScope, {
    filePath,
  });

  const parsed: Record<string, BuiltinAgentOverrideConfig> = {};
  const agentOverrides = subagentsObject.agentOverrides;
  if (
    !agentOverrides ||
    typeof agentOverrides !== "object" ||
    Array.isArray(agentOverrides)
  ) {
    return {
      overrides: parsed,
      defaultModel,
      disableBuiltins,
      disableThinking,
      modelScope,
    };
  }
  for (const [name, value] of Object.entries(agentOverrides)) {
    const override = parseBuiltinOverrideEntry(name, value, filePath);
    if (override) parsed[name] = override;
  }
  return {
    overrides: parsed,
    defaultModel,
    disableBuiltins,
    disableThinking,
    modelScope,
  };
}

export function resolveSubagentDefaultModel(
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
  userSettingsPath: string,
  projectSettingsPath: string | null,
): AgentModelSourceInfo | undefined {
  if (projectSettingsPath && projectSettings.defaultModel !== undefined) {
    return {
      type: "subagents.defaultModel",
      scope: "project",
      path: projectSettingsPath,
      model: projectSettings.defaultModel,
    };
  }
  return userSettings.defaultModel !== undefined
    ? {
        type: "subagents.defaultModel",
        scope: "user",
        path: userSettingsPath,
        model: userSettings.defaultModel,
      }
    : undefined;
}

export function applySubagentDefaultModel(
  agents: AgentConfig[],
  defaultModel: AgentModelSourceInfo | undefined,
): AgentConfig[] {
  if (!defaultModel) return agents;
  return agents.map((agent) => {
    if (agent.model !== undefined) return agent;
    const next = {
      ...agent,
      model: defaultModel.model,
      modelSource: defaultModel,
    };
    const frontmatterFields = agentFrontmatterFields.get(agent);
    if (frontmatterFields) agentFrontmatterFields.set(next, frontmatterFields);
    return next;
  });
}

function cloneOverrideBase(
  agent: AgentConfig,
): import("./agent-types.ts").BuiltinAgentOverrideBase {
  return {
    model: agent.model,
    fallbackModels: agent.fallbackModels
      ? [...agent.fallbackModels]
      : undefined,
    thinking: agent.thinking,
    systemPromptMode: agent.systemPromptMode,
    inheritProjectContext: agent.inheritProjectContext,
    inheritSkills: agent.inheritSkills,
    defaultContext: agent.defaultContext,
    disabled: agent.disabled,
    systemPrompt: agent.systemPrompt,
    skills: agent.skills ? [...agent.skills] : undefined,
    tools: agent.tools ? [...agent.tools] : undefined,
    mcpDirectTools: agent.mcpDirectTools
      ? [...agent.mcpDirectTools]
      : undefined,
    subagentOnlyExtensions: agent.subagentOnlyExtensions
      ? [...agent.subagentOnlyExtensions]
      : undefined,
    completionGuard: agent.completionGuard,
    toolBudget: agent.toolBudget,
  };
}

function cloneOverrideValue(
  override: BuiltinAgentOverrideConfig,
): BuiltinAgentOverrideConfig {
  return {
    ...(override.model !== undefined ? { model: override.model } : {}),
    ...(override.fallbackModels !== undefined
      ? {
          fallbackModels:
            override.fallbackModels === false
              ? false
              : [...override.fallbackModels],
        }
      : {}),
    ...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
    ...(override.systemPromptMode !== undefined
      ? { systemPromptMode: override.systemPromptMode }
      : {}),
    ...(override.inheritProjectContext !== undefined
      ? { inheritProjectContext: override.inheritProjectContext }
      : {}),
    ...(override.inheritSkills !== undefined
      ? { inheritSkills: override.inheritSkills }
      : {}),
    ...(override.defaultContext !== undefined
      ? { defaultContext: override.defaultContext }
      : {}),
    ...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
    ...(override.systemPrompt !== undefined
      ? { systemPrompt: override.systemPrompt }
      : {}),
    ...(override.skills !== undefined
      ? { skills: override.skills === false ? false : [...override.skills] }
      : {}),
    ...(override.tools !== undefined
      ? { tools: override.tools === false ? false : [...override.tools] }
      : {}),
    ...(override.subagentOnlyExtensions !== undefined
      ? {
          subagentOnlyExtensions:
            override.subagentOnlyExtensions === false
              ? false
              : [...override.subagentOnlyExtensions],
        }
      : {}),
    ...(override.completionGuard !== undefined
      ? { completionGuard: override.completionGuard }
      : {}),
    ...(override.toolBudget !== undefined
      ? {
          toolBudget:
            override.toolBudget === false
              ? false
              : {
                  ...override.toolBudget,
                  ...(Array.isArray(override.toolBudget.block)
                    ? { block: [...override.toolBudget.block] }
                    : {}),
                },
        }
      : {}),
  };
}

function splitToolList(rawTools: string[] | undefined): {
  tools?: string[];
  mcpDirectTools?: string[];
} {
  const mcpDirectTools: string[] = [];
  const tools: string[] = [];
  for (const tool of rawTools ?? []) {
    if (tool.startsWith("mcp:")) {
      mcpDirectTools.push(tool.slice(4));
    } else {
      tools.push(tool);
    }
  }
  return {
    ...(tools.length > 0 ? { tools } : {}),
    ...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
  };
}

function joinToolList(
  config: Pick<AgentConfig, "tools" | "mcpDirectTools">,
): string[] | undefined {
  const joined = [
    ...(config.tools ?? []),
    ...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
  ];
  return joined.length > 0 ? joined : undefined;
}

function arraysEqual(
  a: string[] | undefined,
  b: string[] | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function applyBuiltinOverride(
  agent: AgentConfig,
  override: BuiltinAgentOverrideConfig,
  meta: { scope: "user" | "project"; path: string },
): AgentConfig {
  const next: AgentConfig = {
    ...agent,
    override: { ...meta, base: cloneOverrideBase(agent) },
  };

  if (override.model !== undefined)
    next.model = override.model === false ? undefined : override.model;
  if (override.fallbackModels !== undefined) {
    next.fallbackModels =
      override.fallbackModels === false
        ? undefined
        : [...override.fallbackModels];
  }
  if (override.thinking !== undefined)
    next.thinking = override.thinking === false ? undefined : override.thinking;
  if (override.systemPromptMode !== undefined)
    next.systemPromptMode = override.systemPromptMode;
  if (override.inheritProjectContext !== undefined)
    next.inheritProjectContext = override.inheritProjectContext;
  if (override.inheritSkills !== undefined)
    next.inheritSkills = override.inheritSkills;
  if (override.defaultContext !== undefined)
    next.defaultContext =
      override.defaultContext === false ? undefined : override.defaultContext;
  if (override.disabled !== undefined) next.disabled = override.disabled;
  if (override.systemPrompt !== undefined)
    next.systemPrompt = override.systemPrompt;
  if (override.skills !== undefined)
    next.skills = override.skills === false ? undefined : [...override.skills];
  if (override.tools !== undefined) {
    const { tools, mcpDirectTools } = splitToolList(
      override.tools === false ? [] : override.tools,
    );
    next.tools = tools;
    next.mcpDirectTools = mcpDirectTools;
  }
  if (override.subagentOnlyExtensions !== undefined) {
    next.subagentOnlyExtensions =
      override.subagentOnlyExtensions === false
        ? undefined
        : [...override.subagentOnlyExtensions];
  }
  if (override.completionGuard !== undefined)
    next.completionGuard = override.completionGuard;
  if (override.toolBudget !== undefined)
    next.toolBudget =
      override.toolBudget === false ? undefined : override.toolBudget;

  return next;
}

function clearBuiltinThinking(
  agent: AgentConfig,
  meta: { scope: "user" | "project"; path: string },
): AgentConfig {
  if (agent.thinking === undefined) return agent;
  return {
    ...agent,
    thinking: undefined,
    override: agent.override ?? { ...meta, base: cloneOverrideBase(agent) },
  };
}

export function applyBuiltinOverrides(
  builtinAgents: AgentConfig[],
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
  userSettingsPath: string,
  projectSettingsPath: string | null,
): AgentConfig[] {
  const projectBulkDisabled =
    projectSettings.disableBuiltins === true && projectSettingsPath !== null;
  const userBulkDisabled =
    projectSettings.disableBuiltins === undefined &&
    userSettings.disableBuiltins === true;
  const projectThinkingConfigured =
    projectSettings.disableThinking !== undefined &&
    projectSettingsPath !== null;
  const disableThinking = projectThinkingConfigured
    ? projectSettings.disableThinking === true
    : userSettings.disableThinking === true;
  const disableThinkingMeta = projectThinkingConfigured
    ? { scope: "project" as const, path: projectSettingsPath! }
    : { scope: "user" as const, path: userSettingsPath };

  const applyGlobalThinking = (
    agent: AgentConfig,
    hasExplicitThinkingOverride: boolean,
  ): AgentConfig => {
    if (!disableThinking || hasExplicitThinkingOverride) return agent;
    return clearBuiltinThinking(agent, disableThinkingMeta);
  };

  return builtinAgents.map((agent) => {
    const projectOverride = projectSettings.overrides[agent.name];
    if (projectOverride && projectSettingsPath) {
      return applyGlobalThinking(
        applyBuiltinOverride(agent, projectOverride, {
          scope: "project",
          path: projectSettingsPath,
        }),
        projectOverride.thinking !== undefined,
      );
    }

    if (projectBulkDisabled && projectSettingsPath) {
      return applyGlobalThinking(
        applyBuiltinOverride(
          agent,
          { disabled: true },
          { scope: "project", path: projectSettingsPath },
        ),
        false,
      );
    }

    const userOverride = userSettings.overrides[agent.name];
    if (userOverride) {
      return applyGlobalThinking(
        applyBuiltinOverride(agent, userOverride, {
          scope: "user",
          path: userSettingsPath,
        }),
        !projectThinkingConfigured && userOverride.thinking !== undefined,
      );
    }

    if (userBulkDisabled) {
      return applyGlobalThinking(
        applyBuiltinOverride(
          agent,
          { disabled: true },
          { scope: "user", path: userSettingsPath },
        ),
        false,
      );
    }

    return applyGlobalThinking(agent, false);
  });
}

function customAgentHasFrontmatterField(
  agent: AgentConfig,
  ...fields: string[]
): boolean {
  const frontmatterFields = agentFrontmatterFields.get(agent);
  return frontmatterFields
    ? fields.some((field) => frontmatterFields.has(field))
    : false;
}

function applyCustomAgentOverride(
  agent: AgentConfig,
  override: BuiltinAgentOverrideConfig,
  meta: { scope: "user" | "project"; path: string },
): AgentConfig {
  let next: AgentConfig | undefined;
  let anyFilled = false;

  const mutable = (): AgentConfig => {
    next ??= { ...agent };
    return next;
  };

  const fill = <K extends keyof AgentConfig>(
    field: K,
    frontmatterFields: string[],
    value: AgentConfig[K],
  ): void => {
    if (customAgentHasFrontmatterField(agent, ...frontmatterFields)) return;
    mutable()[field] = value;
    anyFilled = true;
  };

  if (override.model !== undefined) {
    fill(
      "model",
      ["model"],
      override.model === false ? undefined : override.model,
    );
  }
  if (override.fallbackModels !== undefined) {
    fill(
      "fallbackModels",
      ["fallbackModels"],
      override.fallbackModels === false
        ? undefined
        : [...override.fallbackModels],
    );
  }
  if (override.thinking !== undefined) {
    fill(
      "thinking",
      ["thinking"],
      override.thinking === false ? undefined : override.thinking,
    );
  }
  if (override.systemPromptMode !== undefined) {
    fill("systemPromptMode", ["systemPromptMode"], override.systemPromptMode);
  }
  if (override.inheritProjectContext !== undefined) {
    fill(
      "inheritProjectContext",
      ["inheritProjectContext"],
      override.inheritProjectContext,
    );
  }
  if (override.inheritSkills !== undefined) {
    fill("inheritSkills", ["inheritSkills"], override.inheritSkills);
  }
  if (override.defaultContext !== undefined) {
    fill(
      "defaultContext",
      ["defaultContext"],
      override.defaultContext === false ? undefined : override.defaultContext,
    );
  }
  if (override.disabled !== undefined && agent.disabled === undefined) {
    mutable().disabled = override.disabled;
    anyFilled = true;
  }
  if (override.skills !== undefined) {
    fill(
      "skills",
      ["skill", "skills"],
      override.skills === false ? undefined : [...override.skills],
    );
  }
  if (
    override.tools !== undefined &&
    !customAgentHasFrontmatterField(agent, "tools")
  ) {
    const { tools, mcpDirectTools } = splitToolList(
      override.tools === false ? [] : override.tools,
    );
    const target = mutable();
    target.tools = tools;
    target.mcpDirectTools = mcpDirectTools;
    anyFilled = true;
  }
  if (override.subagentOnlyExtensions !== undefined) {
    fill(
      "subagentOnlyExtensions",
      ["subagentOnlyExtensions"],
      override.subagentOnlyExtensions === false
        ? undefined
        : [...override.subagentOnlyExtensions],
    );
  }
  if (override.completionGuard !== undefined) {
    fill("completionGuard", ["completionGuard"], override.completionGuard);
  }
  if (override.toolBudget !== undefined) {
    fill(
      "toolBudget",
      ["toolBudget"],
      override.toolBudget === false ? undefined : override.toolBudget,
    );
  }

  if (!anyFilled || !next) return agent;
  next.override = { ...meta, base: cloneOverrideBase(agent) };
  return next;
}

export function applyCustomAgentOverrides(
  agents: AgentConfig[],
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
  userSettingsPath: string,
  projectSettingsPath: string | null,
): AgentConfig[] {
  return agents.map((agent) => {
    const projectOverride = projectSettings.overrides[agent.name];
    if (projectOverride && projectSettingsPath) {
      return applyCustomAgentOverride(agent, projectOverride, {
        scope: "project",
        path: projectSettingsPath,
      });
    }

    const userOverride = userSettings.overrides[agent.name];
    if (userOverride) {
      return applyCustomAgentOverride(agent, userOverride, {
        scope: "user",
        path: userSettingsPath,
      });
    }

    return agent;
  });
}

export function buildBuiltinOverrideConfig(
  base: import("./agent-types.ts").BuiltinAgentOverrideBase,
  draft: Pick<
    AgentConfig,
    | "model"
    | "fallbackModels"
    | "thinking"
    | "systemPromptMode"
    | "inheritProjectContext"
    | "inheritSkills"
    | "defaultContext"
    | "disabled"
    | "systemPrompt"
    | "skills"
    | "tools"
    | "mcpDirectTools"
    | "subagentOnlyExtensions"
    | "completionGuard"
    | "toolBudget"
  >,
): BuiltinAgentOverrideConfig | undefined {
  const override: BuiltinAgentOverrideConfig = {};

  if (draft.model !== base.model) override.model = draft.model ?? false;
  if (!arraysEqual(draft.fallbackModels, base.fallbackModels))
    override.fallbackModels = draft.fallbackModels
      ? [...draft.fallbackModels]
      : false;
  if (draft.thinking !== base.thinking)
    override.thinking = draft.thinking ?? false;
  if (draft.systemPromptMode !== base.systemPromptMode)
    override.systemPromptMode = draft.systemPromptMode;
  if (draft.inheritProjectContext !== base.inheritProjectContext)
    override.inheritProjectContext = draft.inheritProjectContext;
  if (draft.inheritSkills !== base.inheritSkills)
    override.inheritSkills = draft.inheritSkills;
  if (draft.defaultContext !== base.defaultContext)
    override.defaultContext = draft.defaultContext ?? false;
  if (draft.disabled !== base.disabled)
    override.disabled = draft.disabled ?? false;
  if (draft.systemPrompt !== base.systemPrompt)
    override.systemPrompt = draft.systemPrompt;
  if (!arraysEqual(draft.skills, base.skills))
    override.skills = draft.skills ? [...draft.skills] : false;

  const baseTools = joinToolList(base);
  const draftTools = joinToolList(draft);
  if (!arraysEqual(draftTools, baseTools))
    override.tools = draftTools ? [...draftTools] : false;
  if (!arraysEqual(draft.subagentOnlyExtensions, base.subagentOnlyExtensions)) {
    override.subagentOnlyExtensions = draft.subagentOnlyExtensions
      ? [...draft.subagentOnlyExtensions]
      : false;
  }
  if ((draft.completionGuard !== false) !== (base.completionGuard !== false)) {
    override.completionGuard = draft.completionGuard !== false;
  }
  if (JSON.stringify(draft.toolBudget) !== JSON.stringify(base.toolBudget))
    override.toolBudget = draft.toolBudget ?? false;

  return Object.keys(override).length > 0 ? override : undefined;
}

export function saveBuiltinAgentOverride(
  cwd: string,
  name: string,
  scope: "user" | "project",
  override: BuiltinAgentOverrideConfig,
): string {
  const filePath =
    scope === "project"
      ? getProjectAgentSettingsPath(cwd)
      : getUserAgentSettingsPath();
  if (!filePath)
    throw new Error(
      "Project override is not available here. No project config root was found.",
    );

  const settings = readSettingsFileStrict(filePath);
  const subagents =
    settings.subagents &&
    typeof settings.subagents === "object" &&
    !Array.isArray(settings.subagents)
      ? { ...(settings.subagents as Record<string, unknown>) }
      : {};
  const agentOverrides =
    subagents.agentOverrides &&
    typeof subagents.agentOverrides === "object" &&
    !Array.isArray(subagents.agentOverrides)
      ? { ...(subagents.agentOverrides as Record<string, unknown>) }
      : {};

  agentOverrides[name] = cloneOverrideValue(override);
  subagents.agentOverrides = agentOverrides;
  settings.subagents = subagents;
  writeSettingsFile(filePath, settings);
  return filePath;
}

export function removeBuiltinAgentOverride(
  cwd: string,
  name: string,
  scope: "user" | "project",
): { path: string; removed: boolean } {
  const filePath =
    scope === "project"
      ? getProjectAgentSettingsPath(cwd)
      : getUserAgentSettingsPath();
  if (!filePath)
    throw new Error(
      "Project override is not available here. No project config root was found.",
    );
  if (!fs.existsSync(filePath)) return { path: filePath, removed: false };

  const settings = readSettingsFileStrict(filePath);
  const subagents = settings.subagents;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
    return { path: filePath, removed: false };
  const nextSubagents = { ...(subagents as Record<string, unknown>) };
  const agentOverrides = nextSubagents.agentOverrides;
  if (
    !agentOverrides ||
    typeof agentOverrides !== "object" ||
    Array.isArray(agentOverrides)
  )
    return { path: filePath, removed: false };

  const nextOverrides = { ...(agentOverrides as Record<string, unknown>) };
  if (!Object.prototype.hasOwnProperty.call(nextOverrides, name))
    return { path: filePath, removed: false };
  delete nextOverrides[name];
  if (Object.keys(nextOverrides).length > 0)
    nextSubagents.agentOverrides = nextOverrides;
  else delete nextSubagents.agentOverrides;

  if (Object.keys(nextSubagents).length > 0) settings.subagents = nextSubagents;
  else delete settings.subagents;

  writeSettingsFile(filePath, settings);
  return { path: filePath, removed: true };
}

export function mergeBuiltinAgentOverride(
  cwd: string,
  name: string,
  scope: "user" | "project",
  fields: BuiltinAgentOverrideConfig,
): string {
  const filePath =
    scope === "project"
      ? getProjectAgentSettingsPath(cwd)
      : getUserAgentSettingsPath();
  if (!filePath)
    throw new Error(
      "Project override is not available here. No project config root was found.",
    );

  const settings = readSettingsFileStrict(filePath);
  const subagents =
    settings.subagents &&
    typeof settings.subagents === "object" &&
    !Array.isArray(settings.subagents)
      ? { ...(settings.subagents as Record<string, unknown>) }
      : {};
  const agentOverrides =
    subagents.agentOverrides &&
    typeof subagents.agentOverrides === "object" &&
    !Array.isArray(subagents.agentOverrides)
      ? { ...(subagents.agentOverrides as Record<string, unknown>) }
      : {};

  const existing = agentOverrides[name];
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  agentOverrides[name] = { ...base, ...cloneOverrideValue(fields) };
  subagents.agentOverrides = agentOverrides;
  settings.subagents = subagents;
  writeSettingsFile(filePath, settings);
  return filePath;
}

export function removeBuiltinAgentOverrideFields(
  cwd: string,
  name: string,
  scope: "user" | "project",
  fields: string[],
): { path: string; removed: boolean } {
  const filePath =
    scope === "project"
      ? getProjectAgentSettingsPath(cwd)
      : getUserAgentSettingsPath();
  if (!filePath)
    throw new Error(
      "Project override is not available here. No project config root was found.",
    );
  if (!fs.existsSync(filePath)) return { path: filePath, removed: false };

  const settings = readSettingsFileStrict(filePath);
  const subagents = settings.subagents;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
    return { path: filePath, removed: false };
  const agentOverrides = (subagents as Record<string, unknown>).agentOverrides;
  if (
    !agentOverrides ||
    typeof agentOverrides !== "object" ||
    Array.isArray(agentOverrides)
  )
    return { path: filePath, removed: false };

  const entry = (agentOverrides as Record<string, unknown>)[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    return { path: filePath, removed: false };

  const nextEntry: Record<string, unknown> = {
    ...(entry as Record<string, unknown>),
  };
  let removed = false;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(nextEntry, field)) {
      delete nextEntry[field];
      removed = true;
    }
  }
  if (!removed) return { path: filePath, removed: false };

  const nextSubagents = { ...(subagents as Record<string, unknown>) };
  if (Object.keys(nextEntry).length > 0) {
    (nextSubagents.agentOverrides as Record<string, unknown>)[name] = nextEntry;
  } else {
    const nextOverrides = { ...(agentOverrides as Record<string, unknown>) };
    delete nextOverrides[name];
    if (Object.keys(nextOverrides).length > 0)
      nextSubagents.agentOverrides = nextOverrides;
    else delete nextSubagents.agentOverrides;
  }
  if (Object.keys(nextSubagents).length > 0) settings.subagents = nextSubagents;
  else delete settings.subagents;
  writeSettingsFile(filePath, settings);
  return { path: filePath, removed: true };
}
