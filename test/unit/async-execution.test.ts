import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ASYNC_DIR, DEFAULT_ARTIFACT_CONFIG } from "../../src/shared/types.ts";
import { buildAsyncRunnerSteps, executeAsyncSingle, resolveAsyncRunnerLogPaths } from "../../src/runs/background/async-execution.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

const agent = (name: string, toolBudget?: AgentConfig["toolBudget"]): AgentConfig => ({
	name,
	description: `${name} agent`,
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "You are a test agent.",
	source: "project",
	filePath: `${name}.md`,
	...(toolBudget ? { toolBudget } : {}),
});

const ctx = {
	cwd: process.cwd(),
	currentSessionId: "session-1",
	currentModel: undefined,
	currentModelProvider: undefined,
	modelScope: undefined,
};

describe("async runner execution", () => {
	it("rejects an explicitly requested model outside an enforced scope in the async single path", () => {
		const requestedAgent = agent("worker");
		const id = `scope-${Date.now()}`;
		try {
			assert.throws(() => executeAsyncSingle(id, {
				agent: "worker",
				task: "scope test",
				agentConfig: requestedAgent,
				ctx: {
					pi: {} as never,
					cwd: process.cwd(),
					currentSessionId: "session-1",
					modelScope: { enforce: true, allow: ["openai/*"] },
				},
				availableModels: [{ provider: "anthropic", id: "claude-test", fullId: "anthropic/claude-test" }],
				modelOverride: "anthropic/claude-test",
				artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: false },
				shareEnabled: false,
				maxSubagentDepth: 2,
			}), /outside the configured subagent model scope/i);
		} finally {
			fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
		}
	});

	it("accepts an allowed model and leaves a non-enforcing scope advisory in the async single path", () => {
		for (const [id, scope] of [
			[`allowed-${Date.now()}`, { enforce: true, allow: ["openai/*"] }],
			[`advisory-${Date.now()}`, { enforce: false, allow: ["openai/*"] }],
		] as const) {
			try {
				const result = executeAsyncSingle(id, {
					agent: "worker",
					task: "scope test",
					agentConfig: agent("worker"),
					ctx: {
						pi: {} as never,
						cwd: path.join(process.cwd(), "missing-async-scope-test-cwd"),
						currentSessionId: "session-1",
						modelScope: scope,
					},
					availableModels: [{ provider: "openai", id: "gpt-test", fullId: "openai/gpt-test" }],
					modelOverride: "openai/gpt-test",
					artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: false },
					shareEnabled: false,
					maxSubagentDepth: 2,
				});
				assert.equal(result.isError, true, "invalid cwd should stop before spawning a runner");
				assert.doesNotMatch(result.content[0]?.text ?? "", /outside the configured subagent model scope/i);
			} finally {
				fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
			}
		}
	});

	it("places detached runner stdio logs in the async run directory", () => {
		const asyncDir = path.join("tmp", "async-run");
		assert.deepEqual(resolveAsyncRunnerLogPaths({ asyncDir }), {
			stdoutPath: path.join(asyncDir, "runner.stdout.log"),
			stderrPath: path.join(asyncDir, "runner.stderr.log"),
		});
	});

	it("omits runner log paths when asyncDir is unavailable", () => {
		assert.equal(resolveAsyncRunnerLogPaths({}), undefined);
	});

	it("resolves async step tool budgets with step over run over agent over config precedence", () => {
		const result = buildAsyncRunnerSteps("run-1", {
			chain: [
				{ agent: "worker", task: "agent beats config" },
				{ agent: "worker", task: "step beats run", toolBudget: { hard: 2, block: ["grep"] } },
			],
			agents: [agent("worker", { hard: 4, block: ["read"] })],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			toolBudget: { hard: 3, block: ["find"] },
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 3, block: ["find"] });
		assert.deepEqual(result.steps[1]?.toolBudget, { hard: 2, block: ["grep"] });
	});

	it("uses agent tool budget before config default when no run override exists", () => {
		const result = buildAsyncRunnerSteps("run-2", {
			chain: [{ agent: "worker", task: "agent beats config" }],
			agents: [agent("worker", { hard: 4, block: ["read"] })],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 4, block: ["read"] });
	});

	it("uses config default when no step, run, or agent budget exists", () => {
		const result = buildAsyncRunnerSteps("run-3", {
			chain: [{ agent: "worker", task: "config default" }],
			agents: [agent("worker")],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 5, block: ["ls"] });
	});
});
