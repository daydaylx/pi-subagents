import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createEventBus, createTempDir, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";

const originalHome = process.env.HOME;
const importHome = createTempDir("pi-temp-spec-import-home-");
process.env.HOME = importHome;
let executorMod: any;
try {
	executorMod = await tryImport<any>("./src/runs/foreground/subagent-executor.ts");
} finally {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	removeTempDir(importHome);
}
const createSubagentExecutor = executorMod?.createSubagentExecutor;

const spec = { objective: "Find the cause", profile: "analyse", delegationReason: "independent analysis" };

function makeState(cwd: string, extra: Record<string, unknown> = {}) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
		...extra,
	};
}

describe("temporary agent spec executor policy", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, () => {
	let dir = "";
	beforeEach(() => {
		dir = createTempDir("pi-temp-spec-");
	});
	afterEach(() => removeTempDir(dir));

	function run(params: Record<string, unknown>, stateExtra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
		const state = makeState(dir, stateExtra);
		const executor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config,
			asyncByDefault: false,
			tempArtifactsDir: dir,
			getSubagentSessionRoot: () => dir,
			expandTilde: (v: string) => v,
			discoverAgents: () => ({ agents: [] }),
		});
		return executor.execute("call-1", params, new AbortController().signal, undefined, makeMinimalCtx(dir));
	}

	it("rejects an invalid spec without spawning", async () => {
		const result = await run({ spec: { ...spec, objective: "" } });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /objective is required/);
	});

	it("rejects spec combined with agent/task", async () => {
		const result = await run({ spec, agent: "x", task: "y" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /cannot be combined/);
	});

	it("rejects forked context (stateless agents)", async () => {
		const result = await run({ spec, context: "fork" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /fresh context/);
	});

	it("blocks write-only profiles as policy_blocked with visible metadata", async () => {
		const result = await run({ spec: { ...spec, profile: "implement", requestedCapabilities: ["write"] } });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Policy blocked/);
		const meta = result.details.temporaryAgent;
		assert.equal(meta.status, "policy_blocked");
		assert.equal(meta.write, false);
		assert.equal(meta.objective, "Find the cause");
		assert.equal(meta.delegationReason, "independent analysis");
	});

	it("rejects the agent beyond the per-run limit with no side effect", async () => {
		const state = { temporaryAgentCount: { count: 5, reservedRuntimeMs: 0 } };
		const result = await run({ spec }, state);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /limit reached \(5\/5\)/);
		assert.equal(result.details.temporaryAgent.status, "policy_blocked");
		assert.deepEqual(state.temporaryAgentCount, { count: 5, reservedRuntimeMs: 0 });
	});

	it("honours a configured lower limit", async () => {
		const result = await run({ spec }, { temporaryAgentCount: { count: 2, reservedRuntimeMs: 0 } }, { temporaryAgents: { maxPerRun: 2 } });
		assert.match(result.content[0].text, /limit reached \(2\/2\)/);
	});

	it("blocks when the total runtime budget is exhausted", async () => {
		const result = await run(
			{ spec },
			{ temporaryAgentCount: { count: 1, reservedRuntimeMs: 1_700_000 } },
			{ temporaryAgents: { totalRuntimeMs: 1_800_000, perAgentRuntimeMs: 600_000 } },
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /runtime budget exhausted/);
		assert.equal(result.details.temporaryAgent.status, "policy_blocked");
	});
});
