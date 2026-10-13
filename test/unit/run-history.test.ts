import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadRunsForAgent, recordRun } from "../../src/runs/shared/run-history.ts";

let tempDir = "";
let agentDir = "";
let oldAgentDir: string | undefined;

describe("run-history model/internalToolCalls/reasoningTokens extras", () => {
	beforeEach(() => {
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-history-"));
		agentDir = path.join(tempDir, "agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists model, internalToolCalls, reasoningTokens, verifierDecision, and verifierTrigger when all are given", () => {
		recordRun("verifier", "Check the diff", 0, 1234, {
			cwd: "/workspace",
			tokens: { input: 10, output: 5 },
			cost: 0.01,
			model: "provider/model-a",
			internalToolCalls: 7,
			reasoningTokens: 42,
			verifierDecision: "justified",
			verifierTrigger: "uncovered_behavior",
		});
		const [entry] = loadRunsForAgent("verifier");
		assert.ok(entry);
		assert.equal(entry.model, "provider/model-a");
		assert.equal(entry.internalToolCalls, 7);
		assert.equal(entry.reasoningTokens, 42);
		assert.equal(entry.verifierDecision, "justified");
		assert.equal(entry.verifierTrigger, "uncovered_behavior");
	});

	it("omits model, internalToolCalls, reasoningTokens, verifierDecision, and verifierTrigger when the caller does not supply them", () => {
		recordRun("investigator", "Look around", 0, 10);
		const [entry] = loadRunsForAgent("investigator");
		assert.ok(entry);
		assert.equal("model" in entry, false, "no fabricated model field");
		assert.equal("internalToolCalls" in entry, false, "no fabricated tool-call count");
		assert.equal("reasoningTokens" in entry, false, "no fabricated reasoning-token count");
		assert.equal("verifierDecision" in entry, false, "no fabricated verifier decision");
		assert.equal("verifierTrigger" in entry, false, "no fabricated verifier trigger");
	});

	it("treats a zero reasoning-token count as a real measurement, not an absent one", () => {
		recordRun("worker", "Reported zero reasoning", 0, 5, { reasoningTokens: 0 });
		const [entry] = loadRunsForAgent("worker");
		assert.ok(entry);
		assert.equal(entry.reasoningTokens, 0);
	});

	it("treats a zero tool-call count as a real measurement, not an absent one", () => {
		recordRun("worker", "No tools needed", 0, 5, { internalToolCalls: 0 });
		const [entry] = loadRunsForAgent("worker");
		assert.ok(entry);
		assert.equal(entry.internalToolCalls, 0);
	});

	it("does not confuse the unrelated toolCalls budget field with internalToolCalls", () => {
		// Regression guard: this package also has an unrelated `toolCalls`
		// budget field elsewhere (subagent-executor.ts's `budgets` object).
		// recordRun's own entry must never pick that name up by accident.
		recordRun("worker", "Budget unrelated", 0, 5, { internalToolCalls: 3 });
		const [entry] = loadRunsForAgent("worker");
		assert.ok(entry);
		assert.equal((entry as unknown as Record<string, unknown>).toolCalls, undefined);
		assert.equal(entry.internalToolCalls, 3);
	});

	it("rotates oversized history on write and keeps the newest entries", () => {
		const historyPath = path.join(agentDir, "run-history.jsonl");
		fs.mkdirSync(agentDir, { recursive: true });
		const oldEntries = Array.from({ length: 1400 }, (_, index) => JSON.stringify({ agent: "worker", task: `old-${index}-${"x".repeat(300)}`, ts: index, status: "ok", duration: 1 }));
		fs.writeFileSync(historyPath, `${oldEntries.join("\n")}\n`);
		recordRun("worker", "newest", 0, 2);
		const lines = fs.readFileSync(historyPath, "utf-8").trimEnd().split("\n");
		assert.ok(lines.length <= 1000);
		assert.equal(JSON.parse(lines.at(-1)!).task, "newest");
	});

	it("leaves a small history intact and tolerates malformed lines and a missing file", () => {
		const historyPath = path.join(agentDir, "run-history.jsonl");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(historyPath, "not-json\n");
		recordRun("worker", "small", 0, 2);
		assert.match(fs.readFileSync(historyPath, "utf-8"), /^not-json\n/);
		assert.doesNotThrow(() => loadRunsForAgent("worker"));
		fs.rmSync(historyPath);
		assert.doesNotThrow(() => recordRun("worker", "recreated", 0, 3));
	});
});
