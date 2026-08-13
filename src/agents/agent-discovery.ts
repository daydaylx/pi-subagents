/**
 * Filesystem discovery of agent and chain definitions across builtin/package/user/project sources.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelScopeConfig } from "../runs/shared/model-scope.ts";
import { resolveTurnBudgetConfig } from "../runs/shared/turn-budget.ts";
import type { ToolBudgetConfig, TurnBudgetConfig } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import { parseMemoryFrontmatter } from "./agent-memory.ts";
import {
  agentFrontmatterFields,
  applyBuiltinOverrides,
  applyCustomAgentOverrides,
  applySubagentDefaultModel,
  EMPTY_SUBAGENT_SETTINGS,
  findNearestProjectRoot,
  getProjectAgentSettingsPath,
  getUserAgentSettingsPath,
  isDirectory,
  readSubagentSettings,
  resolveSubagentDefaultModel,
} from "./agent-override-store.ts";
import { collectPackageSubagentPaths } from "./agent-package-paths.ts";
import { mergeAgentsForScope } from "./agent-selection.ts";
import {
  defaultInheritProjectContext,
  defaultInheritSkills,
  defaultSystemPromptMode,
  type AgentConfig,
  type AgentScope,
  type AgentSource,
  type ChainConfig,
  type ChainDiscoveryDiagnostic,
} from "./agent-types.ts";
import { parseChain, parseJsonChain } from "./chain-serializer.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { buildRuntimeName, parsePackageName } from "./identity.ts";
import { KNOWN_FIELDS } from "./agent-serializer.ts";

interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  modelScope?: ModelScopeConfig;
}

function getUserChainDir(): string {
  return path.join(getAgentDir(), "chains");
}

function listFilesRecursive(
  dir: string,
  predicate: (fileName: string) => boolean,
): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  let entries: fs.Dirent[];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return files;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(filePath, predicate));
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!predicate(entry.name)) continue;
    files.push(filePath);
  }
  return files;
}

function isLegacyAgentSkillPath(rootDir: string, filePath: string): boolean {
  const relative = path.relative(rootDir, filePath);
  const parts = relative.split(path.sep).map((part) => part.toLowerCase());
  if (path.basename(rootDir).toLowerCase() === ".agents") {
    parts.unshift(".agents");
  }
  return parts.some(
    (part, index) => part === ".agents" && parts[index + 1] === "skills",
  );
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];

  for (const filePath of listFilesRecursive(
    dir,
    (fileName) => fileName.endsWith(".md") && !fileName.endsWith(".chain.md"),
  )) {
    if (isLegacyAgentSkillPath(dir, filePath)) {
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const localName = frontmatter.name;
    const parsedPackage = parsePackageName(
      frontmatter.package,
      `Agent '${localName}' package`,
    );
    if (parsedPackage.error) continue;
    const packageName = parsedPackage.packageName;
    const runtimeName = buildRuntimeName(localName, packageName);

    const rawTools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const mcpDirectTools: string[] = [];
    const tools: string[] = [];
    if (rawTools) {
      for (const tool of rawTools) {
        if (tool.startsWith("mcp:")) {
          mcpDirectTools.push(tool.slice(4));
        } else {
          tools.push(tool);
        }
      }
    }

    const defaultReads = frontmatter.defaultReads
      ?.split(",")
      .map((f) => f.trim())
      .filter(Boolean);

    const skillStr = frontmatter.skill || frontmatter.skills;
    const skills = skillStr
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const fallbackModels = frontmatter.fallbackModels
      ?.split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    const systemPromptMode =
      frontmatter.systemPromptMode === "replace"
        ? "replace"
        : frontmatter.systemPromptMode === "append"
          ? "append"
          : defaultSystemPromptMode(localName);
    const inheritProjectContext =
      frontmatter.inheritProjectContext === "true"
        ? true
        : frontmatter.inheritProjectContext === "false"
          ? false
          : defaultInheritProjectContext(localName);
    const inheritSkills =
      frontmatter.inheritSkills === "true"
        ? true
        : frontmatter.inheritSkills === "false"
          ? false
          : defaultInheritSkills();
    const defaultContext =
      frontmatter.defaultContext === "fork"
        ? ("fork" as const)
        : frontmatter.defaultContext === "fresh"
          ? ("fresh" as const)
          : undefined;
    let defaultAsync: boolean | undefined;
    if (frontmatter.async !== undefined) {
      if (frontmatter.async === "true") defaultAsync = true;
      else if (frontmatter.async === "false") defaultAsync = false;
      else
        throw new Error(
          `Agent '${localName}' has invalid async frontmatter; expected true or false.`,
        );
    }
    let defaultTimeoutMs: number | undefined;
    if (frontmatter.timeoutMs !== undefined) {
      const parsed = Number(frontmatter.timeoutMs);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
          `Agent '${localName}' has invalid timeoutMs frontmatter; expected a positive integer.`,
        );
      }
      defaultTimeoutMs = parsed;
    }
    let defaultTurnBudget: TurnBudgetConfig | undefined;
    if (frontmatter.turnBudget !== undefined && frontmatter.turnBudget.trim()) {
      const parsed = JSON.parse(frontmatter.turnBudget) as unknown;
      const resolved = resolveTurnBudgetConfig(
        parsed,
        `Agent '${localName}' turnBudget frontmatter`,
      );
      if (resolved.error) throw new Error(resolved.error);
      defaultTurnBudget = resolved.turnBudget;
    }

    let extensions: string[] | undefined;
    if (frontmatter.extensions !== undefined) {
      extensions = frontmatter.extensions
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
    }
    let subagentOnlyExtensions: string[] | undefined;
    if (frontmatter.subagentOnlyExtensions !== undefined) {
      subagentOnlyExtensions = frontmatter.subagentOnlyExtensions
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
    }

    const extraFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(frontmatter)) {
      if (!KNOWN_FIELDS.has(key)) extraFields[key] = value;
    }

    const parsedMaxSubagentDepth = Number(frontmatter.maxSubagentDepth);
    let toolBudget: ToolBudgetConfig | undefined;
    if (frontmatter.toolBudget !== undefined && frontmatter.toolBudget.trim()) {
      const parsed = JSON.parse(frontmatter.toolBudget) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          `Agent '${localName}' has invalid toolBudget frontmatter; expected a JSON object.`,
        );
      }
      toolBudget = parsed as ToolBudgetConfig;
    }
    const completionGuard =
      frontmatter.completionGuard === "false"
        ? false
        : frontmatter.completionGuard === "true"
          ? true
          : undefined;

    const agent: AgentConfig = {
      name: runtimeName,
      localName,
      packageName,
      description: frontmatter.description,
      tools: tools.length > 0 ? tools : undefined,
      mcpDirectTools: mcpDirectTools.length > 0 ? mcpDirectTools : undefined,
      model: frontmatter.model,
      fallbackModels:
        fallbackModels && fallbackModels.length > 0
          ? fallbackModels
          : undefined,
      thinking: frontmatter.thinking === "false" ? false : frontmatter.thinking,
      systemPromptMode,
      inheritProjectContext,
      inheritSkills,
      defaultContext,
      defaultAsync,
      defaultTimeoutMs,
      defaultTurnBudget,
      systemPrompt: body,
      source,
      filePath,
      skills: skills && skills.length > 0 ? skills : undefined,
      extensions,
      subagentOnlyExtensions,
      output: frontmatter.output,
      defaultReads:
        defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
      defaultProgress: frontmatter.defaultProgress === "true",
      interactive: frontmatter.interactive === "true",
      maxSubagentDepth:
        Number.isInteger(parsedMaxSubagentDepth) && parsedMaxSubagentDepth >= 0
          ? parsedMaxSubagentDepth
          : undefined,
      completionGuard,
      toolBudget,
      memory: parseMemoryFrontmatter(frontmatter.memory),
      extraFields:
        Object.keys(extraFields).length > 0 ? extraFields : undefined,
    };
    agentFrontmatterFields.set(agent, new Set(Object.keys(frontmatter)));
    agents.push(agent);
  }

  return agents;
}

function loadChainsFromDir(
  dir: string,
  source: AgentSource,
): { chains: ChainConfig[]; diagnostics: ChainDiscoveryDiagnostic[] } {
  const chains = new Map<string, ChainConfig>();
  const diagnostics: ChainDiscoveryDiagnostic[] = [];

  for (const filePath of listFilesRecursive(
    dir,
    (fileName) =>
      fileName.endsWith(".chain.md") || fileName.endsWith(".chain.json"),
  )) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    try {
      const chain = filePath.endsWith(".chain.json")
        ? parseJsonChain(content, source, filePath)
        : parseChain(content, source, filePath);
      const existing = chains.get(chain.name);
      if (
        existing &&
        existing.filePath.endsWith(".chain.json") &&
        filePath.endsWith(".chain.md")
      )
        continue;
      chains.set(chain.name, chain);
    } catch (error) {
      diagnostics.push({
        source,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
  }

  return { chains: Array.from(chains.values()), diagnostics };
}

function resolveNearestProjectAgentDirs(cwd: string): {
  readDirs: string[];
  preferredDir: string | null;
} {
  const projectRoot = findNearestProjectRoot(cwd);
  if (!projectRoot) return { readDirs: [], preferredDir: null };

  const legacyDir = path.join(projectRoot, ".agents");
  const preferredDir = path.join(getProjectConfigDir(projectRoot), "agents");
  const readDirs: string[] = [];
  if (isDirectory(legacyDir)) readDirs.push(legacyDir);
  if (isDirectory(preferredDir)) readDirs.push(preferredDir);

  return {
    readDirs,
    preferredDir,
  };
}

function resolveNearestProjectChainDirs(cwd: string): {
  readDirs: string[];
  preferredDir: string | null;
} {
  const projectRoot = findNearestProjectRoot(cwd);
  if (!projectRoot) return { readDirs: [], preferredDir: null };

  const preferredDir = path.join(getProjectConfigDir(projectRoot), "chains");
  return {
    readDirs: isDirectory(preferredDir) ? [preferredDir] : [],
    preferredDir,
  };
}
const BUILTIN_AGENTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "agents",
);

export const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

// Additional read-only directories to scan for agent definitions, supplied by the
// launcher via PI_SUBAGENT_EXTRA_AGENT_DIRS (PATH-style, split on os/path delimiter).
// Lets a hermetic wrapper (e.g. a Nix-store install) expose bundled agents without
// copying or symlinking them into the writable agent dir. Loaded as "user" source,
// at lower precedence than agents the user placed in their own agent dir.
function extraUserAgentDirs(): string[] {
  const raw = process.env[EXTRA_AGENT_DIRS_ENV];
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
}

export function discoverAgents(
  cwd: string,
  scope: AgentScope,
): AgentDiscoveryResult {
  const userDirOld = path.join(getAgentDir(), "agents");
  const userDirNew = path.join(os.homedir(), ".agents");
  const { readDirs: projectAgentDirs, preferredDir: projectAgentsDir } =
    resolveNearestProjectAgentDirs(cwd);
  const userSettingsPath = getUserAgentSettingsPath();
  const projectSettingsPath = getProjectAgentSettingsPath(cwd);
  const userSettings =
    scope === "project"
      ? EMPTY_SUBAGENT_SETTINGS
      : readSubagentSettings(userSettingsPath);
  const projectSettings =
    scope === "user"
      ? EMPTY_SUBAGENT_SETTINGS
      : readSubagentSettings(projectSettingsPath);
  const defaultModel = resolveSubagentDefaultModel(
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const modelScope = projectSettings.modelScope ?? userSettings.modelScope;
  const packageSubagentPaths = collectPackageSubagentPaths(cwd, {
    includeUser: scope !== "project",
    includeProject: scope !== "user",
  });

  const builtinAgents = applyBuiltinOverrides(
    applySubagentDefaultModel(
      loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"),
      defaultModel,
    ),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );

  const userAgentsExtra =
    scope === "project"
      ? []
      : extraUserAgentDirs().flatMap((dir) => loadAgentsFromDir(dir, "user"));
  const userAgentsOld =
    scope === "project" ? [] : loadAgentsFromDir(userDirOld, "user");
  const userAgentsNew =
    scope === "project" ? [] : loadAgentsFromDir(userDirNew, "user");
  const userAgents = applyCustomAgentOverrides(
    applySubagentDefaultModel(
      [...userAgentsExtra, ...userAgentsOld, ...userAgentsNew],
      defaultModel,
    ),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );

  const projectAgents = applyCustomAgentOverrides(
    applySubagentDefaultModel(
      scope === "user"
        ? []
        : projectAgentDirs.flatMap((dir) => loadAgentsFromDir(dir, "project")),
      defaultModel,
    ),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const packageAgents = applyCustomAgentOverrides(
    applySubagentDefaultModel(
      packageSubagentPaths.agents.flatMap((dir) =>
        loadAgentsFromDir(dir, "package"),
      ),
      defaultModel,
    ),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const agents = mergeAgentsForScope(
    scope,
    userAgents,
    projectAgents,
    builtinAgents,
    packageAgents,
  ).filter((agent) => agent.disabled !== true);

  return { agents, projectAgentsDir, modelScope };
}

export function discoverAgentsAll(cwd: string): {
  builtin: AgentConfig[];
  package: AgentConfig[];
  user: AgentConfig[];
  project: AgentConfig[];
  chains: ChainConfig[];
  chainDiagnostics: ChainDiscoveryDiagnostic[];
  userDir: string;
  projectDir: string | null;
  userChainDir: string;
  projectChainDir: string | null;
  userSettingsPath: string;
  projectSettingsPath: string | null;
} {
  const userDirOld = path.join(getAgentDir(), "agents");
  const userDirNew = path.join(os.homedir(), ".agents");
  const userChainDir = getUserChainDir();
  const { readDirs: projectDirs, preferredDir: projectDir } =
    resolveNearestProjectAgentDirs(cwd);
  const { readDirs: projectChainDirs, preferredDir: projectChainDir } =
    resolveNearestProjectChainDirs(cwd);
  const userSettingsPath = getUserAgentSettingsPath();
  const projectSettingsPath = getProjectAgentSettingsPath(cwd);
  const userSettings = readSubagentSettings(userSettingsPath);
  const projectSettings = readSubagentSettings(projectSettingsPath);
  const defaultModel = resolveSubagentDefaultModel(
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const packageSubagentPaths = collectPackageSubagentPaths(cwd);

  const builtin = applyBuiltinOverrides(
    applySubagentDefaultModel(
      loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"),
      defaultModel,
    ),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const user = applyCustomAgentOverrides(
    applySubagentDefaultModel(
      [
        ...extraUserAgentDirs().flatMap((dir) =>
          loadAgentsFromDir(dir, "user"),
        ),
        ...loadAgentsFromDir(userDirOld, "user"),
        ...loadAgentsFromDir(userDirNew, "user"),
      ],
      defaultModel,
    ),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const packageMap = new Map<string, AgentConfig>();
  for (const dir of packageSubagentPaths.agents) {
    for (const agent of loadAgentsFromDir(dir, "package")) {
      if (!packageMap.has(agent.name)) packageMap.set(agent.name, agent);
    }
  }
  const packageAgents = applyCustomAgentOverrides(
    applySubagentDefaultModel(Array.from(packageMap.values()), defaultModel),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const projectMap = new Map<string, AgentConfig>();
  for (const dir of projectDirs) {
    for (const agent of loadAgentsFromDir(dir, "project")) {
      projectMap.set(agent.name, agent);
    }
  }
  const project = applyCustomAgentOverrides(
    applySubagentDefaultModel(Array.from(projectMap.values()), defaultModel),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );

  const chainMap = new Map<string, ChainConfig>();
  const packageChainDiagnostics: ChainDiscoveryDiagnostic[] = [];
  const packageChainMap = new Map<string, ChainConfig>();
  for (const dir of packageSubagentPaths.chains) {
    const loaded = loadChainsFromDir(dir, "package");
    packageChainDiagnostics.push(...loaded.diagnostics);
    for (const chain of loaded.chains) {
      if (!packageChainMap.has(chain.name))
        packageChainMap.set(chain.name, chain);
    }
  }
  const projectChainDiagnostics: ChainDiscoveryDiagnostic[] = [];
  for (const dir of projectChainDirs) {
    const loaded = loadChainsFromDir(dir, "project");
    projectChainDiagnostics.push(...loaded.diagnostics);
    for (const chain of loaded.chains) {
      chainMap.set(chain.name, chain);
    }
  }
  const userChains = loadChainsFromDir(userChainDir, "user");
  const chains = [
    ...Array.from(packageChainMap.values()),
    ...userChains.chains,
    ...Array.from(chainMap.values()),
  ];
  const chainDiagnostics = [
    ...packageChainDiagnostics,
    ...userChains.diagnostics,
    ...projectChainDiagnostics,
  ];

  const userDir = process.env.PI_CODING_AGENT_DIR
    ? userDirOld
    : fs.existsSync(userDirNew)
      ? userDirNew
      : userDirOld;

  return {
    builtin,
    package: packageAgents,
    user,
    project,
    chains,
    chainDiagnostics,
    userDir,
    projectDir,
    userChainDir,
    projectChainDir,
    userSettingsPath,
    projectSettingsPath,
  };
}
