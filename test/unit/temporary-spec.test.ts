import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildTemporaryAgentConfig,
	renderTemporaryTask,
	resolveEffectivePolicy,
	resolveTemporaryLimits,
	resolveTemporaryModel,
	TEMPORARY_AGENT_FILE_PATH,
	temporaryAgentStatus,
	validateTemporarySpec,
} from "../../src/agents/temporary-spec.ts";

const base = { objective: "Find why read is blocked", profile: "analyse", delegationReason: "independent analysis" };

function valid(overrides: Record<string, unknown> = {}) {
	const result = validateTemporarySpec({ ...base, ...overrides });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("unreachable");
	return result.spec;
}

describe("temporary agent spec validation", () => {
	it("rejects a missing objective", () => {
		const result = validateTemporarySpec({ ...base, objective: " " });
		assert.equal(result.ok, false);
	});
	it("rejects missing delegationReason, unknown profile and unknown fields", () => {
		assert.equal(validateTemporarySpec({ ...base, delegationReason: "" }).ok, false);
		assert.equal(validateTemporarySpec({ ...base, profile: "security" }).ok, false);
		assert.equal(validateTemporarySpec({ ...base, tools: ["write"] }).ok, false);
		assert.equal(validateTemporarySpec("nope").ok, false);
	});
	it("rejects unknown capabilities and oversized lists", () => {
		assert.equal(validateTemporarySpec({ ...base, requestedCapabilities: ["root"] }).ok, false);
		assert.equal(validateTemporarySpec({ ...base, context: Array(21).fill("x") }).ok, false);
	});
});

describe("temporary agent effective policy", () => {
	it("defaults to read/search without write", () => {
		const policy = resolveEffectivePolicy(valid());
		assert.deepEqual(policy.tools, ["read", "grep", "find", "ls"]);
		assert.equal(policy.write, false);
	});
	it("denies write, network, spawn and shell for analyse", () => {
		const policy = resolveEffectivePolicy(valid({ requestedCapabilities: ["read", "write", "network", "spawn", "readonly_shell"] }));
		assert.deepEqual(policy.effective, ["read"]);
		assert.deepEqual(policy.denied, ["write", "network", "spawn", "readonly_shell"]);
		assert.deepEqual(policy.tools, ["read"]);
	});
	it("allows readonly shell only for verify", () => {
		const policy = resolveEffectivePolicy(valid({ profile: "verify" }));
		assert.ok(policy.tools.includes("bash"));
		assert.ok(!policy.tools.includes("write") && !policy.tools.includes("edit"));
	});
	it("grants no tools for implement", () => {
		assert.deepEqual(resolveEffectivePolicy(valid({ profile: "implement", requestedCapabilities: ["write"] })).tools, []);
	});
});

describe("temporary agent config", () => {
	it("is in-memory, depth-0 and limited to effective tools", () => {
		const spec = valid({ modelPreference: "provider/model" });
		const policy = resolveEffectivePolicy(spec);
		const config = buildTemporaryAgentConfig("temp-1", spec, policy, "provider/model");
		assert.equal(config.maxSubagentDepth, 0);
		assert.equal(config.filePath, "<temporary>");
		assert.equal(config.model, "provider/model");
		assert.equal(buildTemporaryAgentConfig("temp-2", spec, policy).model, undefined);
		assert.deepEqual(config.tools, policy.tools);
		assert.match(renderTemporaryTask(spec, policy), /Do not create subagents/);
	});
});

describe("stateless and minimal context (rules 1, 2)", () => {
	it("has no memory, no persistence and no inherited project context", () => {
		const spec = valid();
		const config = buildTemporaryAgentConfig("temp-1", spec, resolveEffectivePolicy(spec));
		assert.equal(config.memory, undefined);
		assert.equal(config.inheritProjectContext, false);
		assert.equal(config.inheritSkills, false);
		assert.equal(config.defaultContext, "fresh");
		assert.equal(config.filePath, TEMPORARY_AGENT_FILE_PATH);
		assert.equal(config.skills, undefined);
		assert.equal(config.extensions, undefined);
	});
	it("cannot delegate further (rule 9: no agent-to-agent channel)", () => {
		const spec = valid();
		const config = buildTemporaryAgentConfig("temp-1", spec, resolveEffectivePolicy(spec));
		assert.equal(config.maxSubagentDepth, 0);
		for (const tool of ["subagent", "intercom", "contact_supervisor", "write", "edit"]) {
			assert.ok(!config.tools?.includes(tool), tool);
		}
	});
});

describe("model preference (rule 3)", () => {
	it("accepts classes and provider/model ids only", () => {
		for (const ok of ["fast", "cheap", "strong", "independent", "openai/gpt-5.6"]) {
			assert.equal(validateTemporarySpec({ ...base, modelPreference: ok }).ok, true, ok);
		}
		for (const bad of ["gpt", "", "a b/c", 5]) {
			assert.equal(validateTemporarySpec({ ...base, modelPreference: bad }).ok, false, String(bad));
		}
	});
	it("maps a class through runtime config and falls back to the default", () => {
		const cfg = { modelClasses: { cheap: "prov/small" } };
		assert.deepEqual(resolveTemporaryModel("cheap", cfg), { model: "prov/small", source: "class" });
		assert.deepEqual(resolveTemporaryModel("strong", cfg), { source: "default" });
		assert.deepEqual(resolveTemporaryModel(undefined, cfg), { source: "default" });
		assert.deepEqual(resolveTemporaryModel("a/b", cfg), { model: "a/b", source: "explicit" });
	});
});

describe("budgets (rule 4)", () => {
	it("has configurable defaults and ignores invalid values", () => {
		const d = resolveTemporaryLimits();
		assert.equal(d.maxPerRun, 5);
		assert.ok(d.perAgentRuntimeMs > 0 && d.perAgentToolCalls > 0 && d.totalRuntimeMs >= d.perAgentRuntimeMs);
		const c = resolveTemporaryLimits({ maxPerRun: 3, perAgentToolCalls: -1, perAgentRuntimeMs: 1000 });
		assert.equal(c.maxPerRun, 3);
		assert.equal(c.perAgentToolCalls, d.perAgentToolCalls);
		assert.equal(c.perAgentRuntimeMs, 1000);
	});
});

describe("status vocabulary (rule 5)", () => {
	it("never reports aborted or timed out runs as completed", () => {
		assert.equal(temporaryAgentStatus({ running: true }), "running");
		assert.equal(temporaryAgentStatus({ stopped: true }), "aborted");
		assert.equal(temporaryAgentStatus({ timedOut: true }), "timed_out");
		assert.equal(temporaryAgentStatus({ timedOut: true, stopped: true }), "timed_out");
		assert.equal(temporaryAgentStatus({ failed: true }), "failed");
		assert.equal(temporaryAgentStatus({}), "completed");
	});
});

describe("evidence-based result contract (rules 6, 7)", () => {
	it("asks for evidence and forbids confidence percentages", () => {
		const spec = valid();
		const text = renderTemporaryTask(spec, resolveEffectivePolicy(spec));
		assert.match(text, /no confidence percentages/);
		assert.match(text, /observation \| conclusion \| assumption/);
		assert.match(text, /open assumptions/);
		assert.match(text, /remaining uncertainty/);
		assert.match(text, /Cite the source/);
	});
});
