/**
 * Temporary agent contract: a task-scoped agent without a role file.
 *
 * The caller (main agent) only *requests* capabilities. The runtime decides
 * what is effective: effective = requested ∩ profile allowance. Anything the
 * profile does not grant is reported as denied, never silently added.
 */

import type { AgentConfig } from "./agent-types.ts";

/** Marker path of the synthetic, never-persisted temporary agent. */
export const TEMPORARY_AGENT_FILE_PATH = "<temporary>";

export const TEMPORARY_AGENT_PROFILES = [
  "analyse",
  "research",
  "verify",
  "implement",
] as const;
export type TemporaryAgentProfile = (typeof TEMPORARY_AGENT_PROFILES)[number];

export const TEMPORARY_AGENT_CAPABILITIES = [
  "read",
  "search",
  "readonly_shell",
  "write",
  "network",
  "spawn",
] as const;
export type TemporaryAgentCapability =
  (typeof TEMPORARY_AGENT_CAPABILITIES)[number];

/** Hard limits for one temporary agent contract. */
export const TEMPORARY_SPEC_LIMITS = {
  objective: 2000,
  listItem: 500,
  listItems: 20,
  delegationReason: 500,
  maxTemporaryAgentsPerRun: 5,
} as const;

export const MODEL_CLASSES = ["fast", "cheap", "strong", "independent"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

/** Runtime-owned budgets and model mapping. All values are configurable via config.temporaryAgents. */
export interface TemporaryAgentsConfig {
  maxPerRun?: number;
  perAgentRuntimeMs?: number;
  perAgentToolCalls?: number;
  perAgentTurns?: number;
  /** Cumulative assistant input + output tokens; enforced in the child (all tools blocked once reached). */
  perAgentTokenBudget?: number;
  totalRuntimeMs?: number;
  modelClasses?: Partial<Record<ModelClass, string>>;
}

export const TEMPORARY_AGENT_DEFAULTS = {
  maxPerRun: 5,
  perAgentRuntimeMs: 600_000,
  perAgentToolCalls: 60,
  perAgentTurns: 30,
  perAgentTokenBudget: 500_000,
  totalRuntimeMs: 1_800_000,
} as const;

export interface TemporaryAgentLimits {
  maxPerRun: number;
  perAgentRuntimeMs: number;
  perAgentToolCalls: number;
  perAgentTurns: number;
  perAgentTokenBudget: number;
  totalRuntimeMs: number;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export function resolveTemporaryLimits(
  config?: TemporaryAgentsConfig,
): TemporaryAgentLimits {
  const d = TEMPORARY_AGENT_DEFAULTS;
  return {
    maxPerRun: positiveInt(config?.maxPerRun, d.maxPerRun),
    perAgentRuntimeMs: positiveInt(config?.perAgentRuntimeMs, d.perAgentRuntimeMs),
    perAgentToolCalls: positiveInt(config?.perAgentToolCalls, d.perAgentToolCalls),
    perAgentTurns: positiveInt(config?.perAgentTurns, d.perAgentTurns),
    perAgentTokenBudget: positiveInt(config?.perAgentTokenBudget, d.perAgentTokenBudget),
    totalRuntimeMs: positiveInt(config?.totalRuntimeMs, d.totalRuntimeMs),
  };
}

const CONCRETE_MODEL = /^[\w.-]+\/[\w.:@-]+$/;

/**
 * The main agent may state a class or a concrete model; the runtime decides.
 * A class maps to a configured model or falls back to the runtime default.
 * A concrete model is passed on and still has to pass the model scope allow-list.
 */
export function resolveTemporaryModel(
  preference: string | undefined,
  config?: TemporaryAgentsConfig,
): { model?: string; source: "default" | "class" | "explicit" } {
  if (!preference) return { source: "default" };
  if ((MODEL_CLASSES as readonly string[]).includes(preference)) {
    const mapped = config?.modelClasses?.[preference as ModelClass];
    return mapped ? { model: mapped, source: "class" } : { source: "default" };
  }
  return { model: preference, source: "explicit" };
}

/** Evidence-based result contract. No confidence percentages. */
export interface TemporaryAgentFinding {
  finding: string;
  kind: "observation" | "conclusion" | "assumption";
  evidence: Array<{ file?: string; location?: string; command?: string; reason: string }>;
}
export interface TemporaryAgentResult {
  summary: string;
  findings: TemporaryAgentFinding[];
  openAssumptions: string[];
  remainingUncertainty: string[];
  recommendation?: string;
}

/**
 * Deterministic check of the evidence format (rules 6/7): the child must
 * separate observations, conclusions, assumptions and uncertainty, and must not
 * present confidence percentages. It reports; it never rewrites or fails a run.
 */
export interface EvidenceCheck {
  complete: boolean;
  missingSections: string[];
  confidencePercentages: boolean;
}

const EVIDENCE_SECTIONS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "summary", pattern: /^\s{0,3}(?:#{1,6}\s*|\*\*)summary\b/im },
  { name: "findings", pattern: /^\s{0,3}(?:#{1,6}\s*|\*\*)findings\b/im },
  { name: "open assumptions", pattern: /^\s{0,3}(?:#{1,6}\s*|\*\*)open assumptions\b/im },
  { name: "remaining uncertainty", pattern: /^\s{0,3}(?:#{1,6}\s*|\*\*)remaining uncertainty\b/im },
];
const CONFIDENCE_PERCENT =
  /\b(?:confidence|konfidenz|sicherheit)\b[^\n%]{0,20}\d{1,3}\s?%|\b\d{1,3}\s?%\s*(?:confidence|confident|konfidenz|sicher)/i;

export function checkEvidenceFormat(text: string): EvidenceCheck {
  const missingSections = EVIDENCE_SECTIONS.filter((section) => !section.pattern.test(text)).map((section) => section.name);
  const confidencePercentages = CONFIDENCE_PERCENT.test(text);
  return { complete: missingSections.length === 0 && !confidencePercentages, missingSections, confidencePercentages };
}

/** One-line note appended to an incomplete result so the main agent weighs it accordingly. */
export function evidenceNote(check: EvidenceCheck): string | undefined {
  if (check.complete) return undefined;
  const parts: string[] = [];
  if (check.missingSections.length > 0) parts.push(`fehlende Abschnitte: ${check.missingSections.join(", ")}`);
  if (check.confidencePercentages) parts.push("enthält Confidence-Prozentwerte, die nicht als Beleg zählen");
  return `[Evidenzformat unvollständig (${parts.join("; ")}). Befunde ohne Quelle nicht ungeprüft übernehmen.]`;
}

/** Run status vocabulary shown to the main agent and in telemetry. */
export type TemporaryAgentStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "timed_out"
  | "policy_blocked";

export function temporaryAgentStatus(input: {
  running?: boolean;
  stopped?: boolean;
  timedOut?: boolean;
  failed?: boolean;
}): TemporaryAgentStatus {
  if (input.running) return "running";
  if (input.timedOut) return "timed_out";
  if (input.stopped) return "aborted";
  if (input.failed) return "failed";
  return "completed";
}

/** Visible-delegation record: why, what, where, which model, write access, status. */
export interface TemporaryAgentMeta {
  name: string;
  objective: string;
  delegationReason: string;
  profile: TemporaryAgentProfile;
  scope?: TemporaryAgentSpec["scope"];
  model: string | undefined;
  modelSource: "default" | "class" | "explicit";
  write: false;
  effective: TemporaryAgentCapability[];
  denied: TemporaryAgentCapability[];
  budgets: {
    runtimeMs: number;
    toolCalls: number;
    turns: number;
    tokenBudget: number;
    tokenBudgetEnforced: true;
  };
  status: TemporaryAgentStatus;
  /** Set for completed foreground runs only; async results are not available at return time. */
  evidence?: EvidenceCheck;
}

export interface TemporaryAgentSpec {
  objective: string;
  profile: TemporaryAgentProfile;
  context?: string[];
  scope?: { include?: string[]; exclude?: string[] };
  expectedOutput?: string[];
  requestedCapabilities?: TemporaryAgentCapability[];
  delegationReason: string;
  modelPreference?: string;
  constraints?: string[];
}

export interface EffectivePolicy {
  profile: TemporaryAgentProfile;
  requested: TemporaryAgentCapability[];
  effective: TemporaryAgentCapability[];
  denied: TemporaryAgentCapability[];
  tools: string[];
  write: false;
}

/** Capabilities each profile may ever grant. Write/network/spawn are never granted at this stage. */
const PROFILE_ALLOWANCE: Record<
  TemporaryAgentProfile,
  readonly TemporaryAgentCapability[]
> = {
  analyse: ["read", "search"],
  research: ["read", "search"],
  verify: ["read", "search", "readonly_shell"],
  implement: [],
};

const CAPABILITY_TOOLS: Record<TemporaryAgentCapability, readonly string[]> = {
  read: ["read"],
  search: ["grep", "find", "ls"],
  readonly_shell: ["bash"],
  write: [],
  network: [],
  spawn: [],
};

const DEFAULT_REQUEST: Record<
  TemporaryAgentProfile,
  readonly TemporaryAgentCapability[]
> = {
  analyse: ["read", "search"],
  research: ["read", "search"],
  verify: ["read", "search", "readonly_shell"],
  implement: [],
};

export type SpecValidation =
  { ok: true; spec: TemporaryAgentSpec } | { ok: false; errors: string[] };

function stringList(
  value: unknown,
  field: string,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings.`);
    return undefined;
  }
  if (value.length > TEMPORARY_SPEC_LIMITS.listItems) {
    errors.push(
      `${field} allows at most ${TEMPORARY_SPEC_LIMITS.listItems} entries.`,
    );
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.trim() === "" ||
      item.length > TEMPORARY_SPEC_LIMITS.listItem
    ) {
      errors.push(
        `${field} entries must be non-empty strings up to ${TEMPORARY_SPEC_LIMITS.listItem} characters.`,
      );
      return undefined;
    }
    out.push(item.trim());
  }
  return out;
}

export function validateTemporarySpec(input: unknown): SpecValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["spec must be an object."] };
  }
  const raw = input as Record<string, unknown>;
  const known = new Set([
    "objective",
    "profile",
    "context",
    "scope",
    "expectedOutput",
    "requestedCapabilities",
    "delegationReason",
    "modelPreference",
    "constraints",
  ]);
  for (const key of Object.keys(raw))
    if (!known.has(key)) errors.push(`Unknown spec field: ${key}.`);

  const objective =
    typeof raw.objective === "string" ? raw.objective.trim() : "";
  if (!objective) errors.push("spec.objective is required.");
  else if (objective.length > TEMPORARY_SPEC_LIMITS.objective)
    errors.push(
      `spec.objective allows at most ${TEMPORARY_SPEC_LIMITS.objective} characters.`,
    );

  const profile = raw.profile;
  if (
    typeof profile !== "string" ||
    !(TEMPORARY_AGENT_PROFILES as readonly string[]).includes(profile)
  ) {
    errors.push(
      `spec.profile must be one of: ${TEMPORARY_AGENT_PROFILES.join(", ")}.`,
    );
  }

  const reason =
    typeof raw.delegationReason === "string" ? raw.delegationReason.trim() : "";
  if (!reason) errors.push("spec.delegationReason is required.");
  else if (reason.length > TEMPORARY_SPEC_LIMITS.delegationReason)
    errors.push(
      `spec.delegationReason allows at most ${TEMPORARY_SPEC_LIMITS.delegationReason} characters.`,
    );

  const context = stringList(raw.context, "spec.context", errors);
  const expectedOutput = stringList(
    raw.expectedOutput,
    "spec.expectedOutput",
    errors,
  );
  const constraints = stringList(raw.constraints, "spec.constraints", errors);

  let scope: TemporaryAgentSpec["scope"];
  if (raw.scope !== undefined) {
    if (!raw.scope || typeof raw.scope !== "object" || Array.isArray(raw.scope))
      errors.push("spec.scope must be an object.");
    else {
      const s = raw.scope as Record<string, unknown>;
      for (const key of Object.keys(s))
        if (key !== "include" && key !== "exclude")
          errors.push(`Unknown spec.scope field: ${key}.`);
      scope = {
        include: stringList(s.include, "spec.scope.include", errors),
        exclude: stringList(s.exclude, "spec.scope.exclude", errors),
      };
    }
  }

  let requestedCapabilities: TemporaryAgentCapability[] | undefined;
  if (raw.requestedCapabilities !== undefined) {
    const list = stringList(
      raw.requestedCapabilities,
      "spec.requestedCapabilities",
      errors,
    );
    if (list) {
      const bad = list.filter(
        (c) => !(TEMPORARY_AGENT_CAPABILITIES as readonly string[]).includes(c),
      );
      if (bad.length > 0)
        errors.push(`Unknown capabilities: ${bad.join(", ")}.`);
      else
        requestedCapabilities = [
          ...new Set(list),
        ] as TemporaryAgentCapability[];
    }
  }

  if (raw.modelPreference !== undefined) {
    const pref =
      typeof raw.modelPreference === "string" ? raw.modelPreference.trim() : "";
    if (
      !pref ||
      !(
        (MODEL_CLASSES as readonly string[]).includes(pref) ||
        CONCRETE_MODEL.test(pref)
      )
    ) {
      errors.push(
        `spec.modelPreference must be one of ${MODEL_CLASSES.join(", ")} or a provider/model id.`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    spec: {
      objective,
      profile: profile as TemporaryAgentProfile,
      delegationReason: reason,
      ...(context ? { context } : {}),
      ...(scope ? { scope } : {}),
      ...(expectedOutput ? { expectedOutput } : {}),
      ...(requestedCapabilities ? { requestedCapabilities } : {}),
      ...(typeof raw.modelPreference === "string"
        ? { modelPreference: raw.modelPreference.trim() }
        : {}),
      ...(constraints ? { constraints } : {}),
    },
  };
}

/** effective = requested ∩ profile allowance. The caller cannot widen it. */
export function resolveEffectivePolicy(
  spec: TemporaryAgentSpec,
): EffectivePolicy {
  const requested = spec.requestedCapabilities ?? [
    ...DEFAULT_REQUEST[spec.profile],
  ];
  const allowed = new Set(PROFILE_ALLOWANCE[spec.profile]);
  const effective = requested.filter((c) => allowed.has(c));
  const denied = requested.filter((c) => !allowed.has(c));
  const tools = [...new Set(effective.flatMap((c) => CAPABILITY_TOOLS[c]))];
  return {
    profile: spec.profile,
    requested,
    effective,
    denied,
    tools,
    write: false,
  };
}

function section(title: string, items: string[] | undefined): string {
  return items && items.length > 0
    ? `\n${title}:\n${items.map((i) => `- ${i}`).join("\n")}\n`
    : "";
}

/** Task text handed to the child; states the limits so the child does not have to guess. */
export function renderTemporaryTask(
  spec: TemporaryAgentSpec,
  policy: EffectivePolicy,
): string {
  return [
    `Objective: ${spec.objective}`,
    section("Context", spec.context),
    section("Scope (include)", spec.scope?.include),
    section("Scope (exclude)", spec.scope?.exclude),
    section("Expected output", spec.expectedOutput),
    section("Constraints", [
      "Do not create subagents.",
      "Do not modify files; you are read-only.",
      ...(spec.constraints ?? []),
    ]),
    `\nEffective tools: ${policy.tools.join(", ") || "none"}.`,
    policy.denied.length > 0
      ? `Denied capabilities (not available): ${policy.denied.join(", ")}.`
      : "",
    "\nResult format (no confidence percentages):",
    "- summary",
    "- findings: each with kind (observation | conclusion | assumption) and evidence (file + location, or command, plus reason)",
    "- open assumptions",
    "- remaining uncertainty",
    "- recommendation (optional)",
    "Separate what you observed from what you concluded. Cite the source of every finding.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function temporaryAgentName(index: number): string {
  return `temp-${index}`;
}

/** Synthetic in-memory agent; never written to disk. */
export function buildTemporaryAgentConfig(
  name: string,
  spec: TemporaryAgentSpec,
  policy: EffectivePolicy,
  model?: string,
): AgentConfig {
  return {
    name,
    description: spec.objective.slice(0, 120),
    tools: policy.tools,
    ...(model ? { model } : {}),
    systemPromptMode: "append",
    inheritProjectContext: false,
    inheritSkills: false,
    defaultContext: "fresh",
    maxSubagentDepth: 0,
    systemPrompt:
      "You are a temporary, read-only task agent. Work only on the given objective and return a concise, evidence-based result.",
    source: "project",
    filePath: TEMPORARY_AGENT_FILE_PATH,
  };
}
