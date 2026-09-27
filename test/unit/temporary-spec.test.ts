import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildTemporaryAgentConfig,
	checkEvidenceFormat,
	evidenceNote,
	renderTemporaryTask,
	resolveTemporaryLimits,
	resolveTemporaryModel,
	TEMPORARY_AGENT_FILE_PATH,
	TEMPORARY_AGENT_TOOLS,
	temporaryAgentStatus,
	validateTemporarySpec,
} from "../../src/agents/temporary-spec.ts";

const base = { objective: "Find why read is blocked", delegationReason: "independent analysis" };

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
	it("rejects missing delegationReason and unknown fields", () => {
		assert.equal(validateTemporarySpec({ ...base, delegationReason: "" }).ok, false);
		assert.equal(validateTemporarySpec({ ...base, tools: ["write"] }).ok, false);
		assert.equal(validateTemporarySpec("nope").ok, false);
	});
	it("rejects a role, capability request or verify sentinel — none of these fields exist in the contract", () => {
		assert.equal(validateTemporarySpec({ ...base, profile: "analyse" }).ok, false);
		assert.equal(validateTemporarySpec({ ...base, kind: "verify" }).ok, false);
		assert.equal(validateTemporarySpec({ ...base, requestedCapabilities: ["read"] }).ok, false);
	});
	it("rejects oversized lists", () => {
		assert.equal(validateTemporarySpec({ ...base, context: Array(21).fill("x") }).ok, false);
	});
	it("renames scope to focusPaths and rejects unknown focusPaths fields", () => {
		assert.equal(validateTemporarySpec({ ...base, scope: { include: ["src/"] } }).ok, false);
		const result = validateTemporarySpec({ ...base, focusPaths: { include: ["src/"], exclude: ["dist/"] } });
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.spec.focusPaths, { include: ["src/"], exclude: ["dist/"] });
		assert.equal(validateTemporarySpec({ ...base, focusPaths: { bogus: ["x"] } }).ok, false);
	});
});

describe("temporary agent tool set", () => {
	it("is fixed and read-only for every spec, with nothing to request or deny", () => {
		assert.deepEqual(TEMPORARY_AGENT_TOOLS, ["read", "grep", "find", "ls"]);
	});
});

describe("temporary agent config", () => {
	it("is in-memory, depth-0 and limited to the fixed tool set", () => {
		const spec = valid({ modelPreference: "provider/model" });
		const config = buildTemporaryAgentConfig("temp-1", spec, "provider/model");
		assert.equal(config.maxSubagentDepth, 0);
		assert.equal(config.filePath, "<temporary>");
		assert.equal(config.model, "provider/model");
		assert.equal(buildTemporaryAgentConfig("temp-2", spec).model, undefined);
		assert.deepEqual(config.tools, [...TEMPORARY_AGENT_TOOLS]);
		assert.match(renderTemporaryTask(spec), /Do not create subagents/);
	});
});

describe("stateless and minimal context (rules 1, 2)", () => {
	it("has no memory, no persistence and no inherited project context", () => {
		const spec = valid();
		const config = buildTemporaryAgentConfig("temp-1", spec);
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
		const config = buildTemporaryAgentConfig("temp-1", spec);
		assert.equal(config.maxSubagentDepth, 0);
		for (const tool of ["subagent", "intercom", "contact_supervisor", "write", "edit"]) {
			assert.ok(!config.tools?.includes(tool), tool);
		}
	});
});

describe("model preference (rule 3)", () => {
	it("accepts provider/model ids only — no model classes", () => {
		assert.equal(validateTemporarySpec({ ...base, modelPreference: "openai/gpt-5.6" }).ok, true);
		for (const bad of ["fast", "cheap", "strong", "independent", "gpt", "", "a b/c", 5]) {
			assert.equal(validateTemporarySpec({ ...base, modelPreference: bad }).ok, false, String(bad));
		}
	});
	it("passes a concrete model through and falls back to the default otherwise", () => {
		assert.deepEqual(resolveTemporaryModel("a/b"), { model: "a/b", source: "explicit" });
		assert.deepEqual(resolveTemporaryModel(undefined), { source: "default" });
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
		const text = renderTemporaryTask(spec);
		assert.match(text, /no confidence percentages/);
		assert.match(text, /observation \| conclusion \| assumption/);
		assert.match(text, /open assumptions/);
		assert.match(text, /remaining uncertainty/);
		assert.match(text, /Cite the source/);
	});
});

describe("evidence format check (rules 6, 7)", () => {
	const good = [
		"### summary\n`math.ts` exports `add`.",
		"### findings\n- **observation** — `math.ts:1` declares add.\n- **conclusion** — one named export.",
		"### open assumptions\nnone",
		"### remaining uncertainty\nnone",
	].join("\n\n");

	it("accepts the four-section result format", () => {
		const check = checkEvidenceFormat(good);
		assert.deepEqual(check, { complete: true, missingSections: [], confidencePercentages: false });
		assert.equal(evidenceNote(check), undefined);
	});
	it("accepts bold headings", () => {
		assert.equal(checkEvidenceFormat(good.replaceAll("### ", "**").replace(/\*\*(summary|findings|open assumptions|remaining uncertainty)/g, "**$1**")).complete, true);
	});
	it("reports missing sections", () => {
		const check = checkEvidenceFormat("### summary\nx\n### findings\n- y");
		assert.equal(check.complete, false);
		assert.deepEqual(check.missingSections, ["open assumptions", "remaining uncertainty"]);
		assert.match(evidenceNote(check) ?? "", /fehlende Abschnitte: open assumptions, remaining uncertainty/);
	});
	it("flags confidence percentages, not other percentages", () => {
		for (const text of ["Confidence: 92%", "confidence 92 %", "92% confident", "Konfidenz: 80%", "Sicherheit ca. 90%"]) {
			assert.equal(checkEvidenceFormat(`${good}\n${text}`).confidencePercentages, true, text);
		}
		for (const text of ["coverage is 92%", "CPU 40% busy", "the confidence interval"]) {
			assert.equal(checkEvidenceFormat(`${good}\n${text}`).confidencePercentages, false, text);
		}
		const flagged = checkEvidenceFormat(`${good}\nconfidence: 92%`);
		assert.equal(flagged.complete, false);
		assert.match(evidenceNote(flagged) ?? "", /Confidence-Prozentwerte/);
	});
	it("treats an empty or free-form answer as incomplete", () => {
		assert.equal(checkEvidenceFormat("").complete, false);
		assert.equal(checkEvidenceFormat("Looks fine to me.").missingSections.length, 4);
	});
});
