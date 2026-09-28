import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadRunsForAgent, recordRun } from "../../src/runs/shared/run-history.ts";

let tempDir = "";
let agentDir = "";
let oldAgentDir: string | undefined;

describe("run-history model/internalToolCalls extras", () => {
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

	it("persists model and internalToolCalls when both are given", () => {
		recordRun("verifier", "Check the diff", 0, 1234, {
			cwd: "/workspace",
			tokens: { input: 10, output: 5 },
			cost: 0.01,
			model: "provider/model-a",
			internalToolCalls: 7,
		});
		const [entry] = loadRunsForAgent("verifier");
		assert.ok(entry);
		assert.equal(entry.model, "provider/model-a");
		assert.equal(entry.internalToolCalls, 7);
	});

	it("omits model and internalToolCalls when the caller does not supply them", () => {
		recordRun("investigator", "Look around", 0, 10);
		const [entry] = loadRunsForAgent("investigator");
		assert.ok(entry);
		assert.equal("model" in entry, false, "no fabricated model field");
		assert.equal("internalToolCalls" in entry, false, "no fabricated tool-call count");
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
});
