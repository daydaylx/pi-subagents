import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildFleetEntries,
	mapRawStateToFleetState,
	normalizeAsyncJobState,
	normalizeAsyncRunSummary,
	normalizeForegroundActive,
	normalizeForegroundRecent,
	normalizeNestedRun,
	pickActivityDetail,
	resolveAttention,
} from "../../src/runs/shared/fleet-projection.ts";
import type {
	AsyncJobState,
	ForegroundControlState,
	ForegroundResumeChild,
	ForegroundResumeRun,
	NestedRunSummary,
	NestedStepSummary,
	SubagentState,
} from "../../src/shared/types.ts";
import type { AsyncRunSummary } from "../../src/runs/background/async-status.ts";
import type { ChildWatchdogStateSnapshot } from "../../src/watchdog/child-status.ts";

function makeState(overrides: Partial<SubagentState> = {}): SubagentState {
	return {
		baseCwd: "/tmp/project",
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
		...overrides,
	};
}

function makeForegroundControl(overrides: Partial<ForegroundControlState> = {}): ForegroundControlState {
	return {
		runId: "run-1",
		mode: "single",
		startedAt: 1000,
		updatedAt: 1000,
		currentAgent: "worker",
		...overrides,
	};
}

function makeAsyncJobState(overrides: Partial<AsyncJobState> = {}): AsyncJobState {
	return {
		asyncId: "async-1",
		asyncDir: "/tmp/async-1",
		status: "running",
		...overrides,
	};
}

function makeForegroundResumeChild(overrides: Partial<ForegroundResumeChild> = {}): ForegroundResumeChild {
	return {
		agent: "worker",
		index: 0,
		status: "completed",
		...overrides,
	};
}

function makeForegroundResumeRun(overrides: Partial<ForegroundResumeRun> = {}): ForegroundResumeRun {
	return {
		runId: "run-1",
		mode: "single",
		cwd: "/tmp/project",
		updatedAt: 2000,
		children: [makeForegroundResumeChild()],
		...overrides,
	};
}

function makeAsyncRunSummary(overrides: Partial<AsyncRunSummary> = {}): AsyncRunSummary {
	return {
		id: "async-2",
		asyncDir: "/tmp/async-2",
		state: "complete",
		mode: "single",
		startedAt: 500,
		steps: [],
		...overrides,
	};
}

function makeNestedRunSummary(overrides: Partial<NestedRunSummary> = {}): NestedRunSummary {
	return {
		id: "nested-1",
		parentRunId: "run-1",
		depth: 1,
		path: [],
		state: "running",
		...overrides,
	};
}

function makeWatchdogSnapshot(overrides: Partial<ChildWatchdogStateSnapshot> = {}): ChildWatchdogStateSnapshot {
	return {
		phase: "idle",
		seq: 1,
		lastUpdate: 0,
		followUpPending: false,
		...overrides,
	};
}

describe("mapRawStateToFleetState", () => {
	it("collapses queued and pending into running", () => {
		assert.equal(mapRawStateToFleetState("queued"), "running");
		assert.equal(mapRawStateToFleetState("pending"), "running");
	});

	it("maps running to running", () => {
		assert.equal(mapRawStateToFleetState("running"), "running");
	});

	it("maps complete and completed to completed", () => {
		assert.equal(mapRawStateToFleetState("complete"), "completed");
		assert.equal(mapRawStateToFleetState("completed"), "completed");
	});

	it("maps failed to error", () => {
		assert.equal(mapRawStateToFleetState("failed"), "error");
	});

	it("maps paused to paused", () => {
		assert.equal(mapRawStateToFleetState("paused"), "paused");
	});

	it("maps stopped to stopped", () => {
		assert.equal(mapRawStateToFleetState("stopped"), "stopped");
	});

	it("maps detached to running (detached flag is set separately by callers)", () => {
		assert.equal(mapRawStateToFleetState("detached"), "running");
	});

	it("tolerates unknown raw values by falling back to running", () => {
		assert.equal(mapRawStateToFleetState("some-future-state"), "running");
	});
});

describe("resolveAttention", () => {
	it("suppresses attention once the lifecycle is terminal, even with a failing watchdog", () => {
		const result = resolveAttention({
			lifecycleTerminal: true,
			controlActivityState: "needs_attention",
			watchdogSnapshot: makeWatchdogSnapshot({ phase: "failed" }),
			hasPendingSupervisorRequest: true,
		});
		assert.deepEqual(result, { needsAttention: false });
	});

	it("flags control-notice needs_attention", () => {
		const result = resolveAttention({
			lifecycleTerminal: false,
			controlActivityState: "needs_attention",
			hasPendingSupervisorRequest: false,
		});
		assert.equal(result.needsAttention, true);
		assert.equal(result.attentionReason, "control_notice");
		assert.equal(result.stateOverride, undefined);
	});

	it("escalates state to error when the watchdog phase is failed", () => {
		const result = resolveAttention({
			lifecycleTerminal: false,
			watchdogSnapshot: makeWatchdogSnapshot({ phase: "failed" }),
			hasPendingSupervisorRequest: false,
		});
		assert.equal(result.needsAttention, true);
		assert.equal(result.attentionReason, "watchdog_stalled");
		assert.equal(result.stateOverride, "error");
	});

	it("flags watchdog_stalled for a stale phase without a state override", () => {
		const result = resolveAttention({
			lifecycleTerminal: false,
			watchdogSnapshot: makeWatchdogSnapshot({ phase: "stale" }),
			hasPendingSupervisorRequest: false,
		});
		assert.equal(result.attentionReason, "watchdog_stalled");
		assert.equal(result.stateOverride, undefined);
	});

	it("flags watchdog_stalled for a timed-out watchdog", () => {
		const result = resolveAttention({
			lifecycleTerminal: false,
			watchdogSnapshot: makeWatchdogSnapshot({ phase: "idle", timedOut: true }),
			hasPendingSupervisorRequest: false,
		});
		assert.equal(result.attentionReason, "watchdog_stalled");
	});

	it("flags watchdog_reviewing while the watchdog is actively following up", () => {
		const result = resolveAttention({
			lifecycleTerminal: false,
			watchdogSnapshot: makeWatchdogSnapshot({ phase: "reviewing" }),
			hasPendingSupervisorRequest: false,
		});
		assert.equal(result.attentionReason, "watchdog_reviewing");
		assert.equal(result.stateOverride, undefined);
	});

	it("flags supervisor_pending when nothing else applies", () => {
		const result = resolveAttention({
			lifecycleTerminal: false,
			hasPendingSupervisorRequest: true,
		});
		assert.equal(result.attentionReason, "supervisor_pending");
	});

	it("prioritises control_notice over a simultaneously active watchdog", () => {
		const result = resolveAttention({
			lifecycleTerminal: false,
			controlActivityState: "needs_attention",
			watchdogSnapshot: makeWatchdogSnapshot({ phase: "reviewing" }),
			hasPendingSupervisorRequest: true,
		});
		assert.equal(result.attentionReason, "control_notice");
	});

	it("returns no attention when nothing applies", () => {
		const result = resolveAttention({ lifecycleTerminal: false, hasPendingSupervisorRequest: false });
		assert.deepEqual(result, { needsAttention: false });
	});
});

describe("pickActivityDetail", () => {
	it("prioritises the current tool above everything else", () => {
		const detail = pickActivityDetail({
			currentTool: "grep",
			watchdogSnapshot: makeWatchdogSnapshot({ phase: "reviewing" }),
			pendingSupervisorReason: "need_decision",
			needsAttention: true,
			state: "running",
		});
		assert.equal(detail, "tool: grep");
	});

	it("includes a shortened path alongside the current tool", () => {
		const detail = pickActivityDetail({ currentTool: "grep", currentPath: "/tmp/x", needsAttention: false, state: "running" });
		assert.equal(detail, "tool: grep (/tmp/x)");
	});

	it("falls back to the watchdog phase when no tool is active", () => {
		const detail = pickActivityDetail({
			watchdogSnapshot: makeWatchdogSnapshot({ phase: "reviewing" }),
			pendingSupervisorReason: "need_decision",
			needsAttention: true,
			state: "running",
		});
		assert.equal(detail, "watchdog: reviewing");
	});

	it("reports a stalled watchdog distinctly from an active one", () => {
		const detail = pickActivityDetail({
			watchdogSnapshot: makeWatchdogSnapshot({ phase: "stale" }),
			needsAttention: true,
			state: "running",
		});
		assert.equal(detail, "watchdog: stalled");
	});

	it("falls back to the pending supervisor reason when no watchdog is active", () => {
		const detail = pickActivityDetail({
			pendingSupervisorReason: "need_decision",
			needsAttention: true,
			state: "running",
		});
		assert.equal(detail, "waiting: need_decision");
	});

	it("falls back to a generic needs-attention label when only the flag is set", () => {
		const detail = pickActivityDetail({ needsAttention: true, state: "running" });
		assert.equal(detail, "needs attention");
	});

	it("falls back to the generic lifecycle state only as the last resort", () => {
		const detail = pickActivityDetail({ needsAttention: false, state: "paused" });
		assert.equal(detail, "paused");
	});
});

describe("normalizeForegroundActive", () => {
	it("builds a stable key that ignores the volatile currentIndex/currentAgent fields", () => {
		const before = makeForegroundControl({ mode: "parallel", currentAgent: "worker-a", currentIndex: 0 });
		const after = makeForegroundControl({ mode: "parallel", currentAgent: "worker-b", currentIndex: 3 });
		const entryBefore = normalizeForegroundActive(before, { pending: [], now: 1000 });
		const entryAfter = normalizeForegroundActive(after, { pending: [], now: 1000 });
		assert.equal(entryBefore.key, entryAfter.key);
		assert.equal(entryBefore.key, "foreground:active:run-1");
	});

	it("shows the current agent name for single-mode runs", () => {
		const control = makeForegroundControl({ mode: "single", currentAgent: "reviewer" });
		const entry = normalizeForegroundActive(control, { pending: [], now: 1000 });
		assert.equal(entry.agent, "reviewer");
	});

	it("shows the run mode for parallel and chain runs instead of a single agent", () => {
		const control = makeForegroundControl({ mode: "parallel", currentAgent: "worker-a" });
		const entry = normalizeForegroundActive(control, { pending: [], now: 1000 });
		assert.equal(entry.agent, "parallel");
	});

	it("derives canStop from the presence of an interrupt handle", () => {
		const withInterrupt = makeForegroundControl({ interrupt: () => true });
		const withoutInterrupt = makeForegroundControl({ interrupt: undefined });
		assert.equal(normalizeForegroundActive(withInterrupt, { pending: [], now: 1000 }).canStop, true);
		assert.equal(normalizeForegroundActive(withoutInterrupt, { pending: [], now: 1000 }).canStop, false);
	});

	it("flags needsAttention from currentActivityState", () => {
		const control = makeForegroundControl({ currentActivityState: "needs_attention" });
		const entry = normalizeForegroundActive(control, { pending: [], now: 1000 });
		assert.equal(entry.needsAttention, true);
		assert.equal(entry.attentionReason, "control_notice");
	});

	it("produces exactly one row for an active parallel run regardless of which child last reported", () => {
		const state = makeState();
		state.foregroundControls.set("run-1", makeForegroundControl({ mode: "parallel", currentAgent: "worker-c", currentIndex: 7 }));
		const entries = buildFleetEntries(state, { now: () => 1000 });
		const foregroundRows = entries.filter((entry) => entry.source === "foreground");
		assert.equal(foregroundRows.length, 1);
		assert.equal(foregroundRows[0]?.key, "foreground:active:run-1");
	});
});

describe("normalizeForegroundRecent", () => {
	it("skips runs that are still active (no duplicate row)", () => {
		const run = makeForegroundResumeRun({ runId: "run-1" });
		const entries = normalizeForegroundRecent(run, new Set(["run-1"]));
		assert.deepEqual(entries, []);
	});

	it("builds a parent row plus one child row per completed child", () => {
		const run = makeForegroundResumeRun({
			runId: "run-2",
			children: [
				makeForegroundResumeChild({ agent: "worker-a", index: 0, status: "completed" }),
				makeForegroundResumeChild({ agent: "worker-b", index: 1, status: "failed" }),
			],
		});
		const entries = normalizeForegroundRecent(run, new Set());
		assert.equal(entries.length, 3);
		assert.equal(entries[0]?.key, "foreground:recent:run-2");
		assert.equal(entries[1]?.key, "foreground:recent:run-2:0");
		assert.equal(entries[2]?.key, "foreground:recent:run-2:1");
		assert.equal(entries[1]?.parentKey, "foreground:recent:run-2");
	});

	it("aggregates the worst child state onto the parent row", () => {
		const run = makeForegroundResumeRun({
			children: [
				makeForegroundResumeChild({ index: 0, status: "completed" }),
				makeForegroundResumeChild({ index: 1, status: "failed" }),
			],
		});
		const [parent] = normalizeForegroundRecent(run, new Set());
		assert.equal(parent?.state, "error");
	});

	it("marks detached children and preserves their transcript path", () => {
		const run = makeForegroundResumeRun({
			children: [makeForegroundResumeChild({ status: "detached", transcriptPath: "/tmp/t.jsonl" })],
		});
		const [, child] = normalizeForegroundRecent(run, new Set());
		assert.equal(child?.detached, true);
		assert.equal(child?.state, "running");
		assert.equal(child?.transcriptPath, "/tmp/t.jsonl");
	});

	it("falls back to updatedAt for startedAt, since resume runs carry no startedAt field", () => {
		const run = makeForegroundResumeRun({ updatedAt: 4242 });
		const [parent] = normalizeForegroundRecent(run, new Set());
		assert.equal(parent?.startedAt, 4242);
	});
});

describe("normalizeAsyncJobState", () => {
	it("derives kind from the raw status, not from being present in the in-memory map", () => {
		const activeJob = makeAsyncJobState({ status: "running" });
		const justFinishedJob = makeAsyncJobState({ asyncId: "async-3", status: "complete" });
		const [activeEntry] = normalizeAsyncJobState(activeJob, { pending: [], now: 1000 });
		const [finishedEntry] = normalizeAsyncJobState(justFinishedJob, { pending: [], now: 1000 });
		assert.equal(activeEntry.kind, "active");
		assert.equal(finishedEntry.kind, "recent");
	});

	it("marks active jobs as stoppable and recent jobs as not stoppable", () => {
		const [activeEntry] = normalizeAsyncJobState(makeAsyncJobState({ status: "running" }), { pending: [], now: 1000 });
		const [recentEntry] = normalizeAsyncJobState(makeAsyncJobState({ status: "stopped" }), { pending: [], now: 1000 });
		assert.equal(activeEntry.canStop, true);
		assert.equal(recentEntry.canStop, false);
	});

	it("builds one row per step with stable composite keys", () => {
		const job = makeAsyncJobState({
			steps: [
				{ index: 0, agent: "worker-a", status: "completed" },
				{ index: 1, agent: "worker-b", status: "running" },
			],
		});
		const entries = normalizeAsyncJobState(job, { pending: [], now: 1000 });
		assert.equal(entries.length, 3);
		assert.equal(entries[1]?.key, "async:async-1:0");
		assert.equal(entries[2]?.key, "async:async-1:1");
		assert.equal(entries[1]?.parentKey, "async:async-1");
	});

	it("never marks transcriptPathMaybeStale for entries sourced from the live in-memory map", () => {
		const job = makeAsyncJobState({
			status: "complete",
			steps: [{ index: 0, agent: "worker-a", status: "completed" }],
		});
		const entries = normalizeAsyncJobState(job, { pending: [], now: 1000 });
		assert.equal(entries[1]?.transcriptPathMaybeStale, false);
	});

	it("escalates a step to error when its watchdog has failed", () => {
		const job = makeAsyncJobState({
			steps: [{ index: 0, agent: "worker-a", status: "running", watchdog: makeWatchdogSnapshot({ phase: "failed" }) }],
		});
		const entries = normalizeAsyncJobState(job, { pending: [], now: 1000 });
		assert.equal(entries[1]?.state, "error");
		assert.equal(entries[1]?.needsAttention, true);
	});

	it("resolves a pending supervisor request scoped to the job's runId", () => {
		const job = makeAsyncJobState({ asyncId: "async-9", status: "running" });
		const [entry] = normalizeAsyncJobState(job, {
			pending: [{ runId: "async-9", agent: "worker", childIndex: 0, expectsReply: true, reason: "need_decision" }],
			now: 1000,
		});
		assert.equal(entry.needsAttention, true);
		assert.equal(entry.attentionReason, "supervisor_pending");
		assert.equal(entry.activityDetail, "waiting: need_decision");
	});
});

describe("normalizeAsyncRunSummary", () => {
	it("flags transcriptPathMaybeStale for terminal steps, since disk summaries never carry transcriptPath", () => {
		const run = makeAsyncRunSummary({
			state: "complete",
			steps: [{ index: 0, agent: "worker-a", status: "completed" }],
		});
		const entries = normalizeAsyncRunSummary(run, { now: 1000 });
		assert.equal(entries[1]?.transcriptPathMaybeStale, true);
		assert.equal(entries[1]?.transcriptPath, undefined);
	});

	it("derives kind active for a still-running disk summary", () => {
		const run = makeAsyncRunSummary({ state: "running", steps: [{ index: 0, agent: "worker-a", status: "running" }] });
		const [entry] = normalizeAsyncRunSummary(run, { now: 1000 });
		assert.equal(entry.kind, "active");
	});
});

describe("normalizeNestedRun", () => {
	it("produces a flat list containing the run row and its step rows", () => {
		const run = makeNestedRunSummary({
			id: "nested-a",
			state: "running",
			steps: [{ agent: "worker-a", status: "running" }],
		});
		const entries = normalizeNestedRun(run, "foreground:active:run-1", 1, { now: 1000, source: "foreground", rootRunId: "run-1" });
		assert.equal(entries.length, 2);
		assert.equal(entries[0]?.key, "nested:nested-a");
		assert.equal(entries[0]?.runId, "run-1");
		assert.equal(entries[1]?.key, "nested:nested-a:step:0");
	});

	it("keeps the root runId across recursive nested children instead of the intermediate parentRunId", () => {
		const grandchild = makeNestedRunSummary({ id: "nested-grandchild", parentRunId: "nested-child", depth: 2, state: "running" });
		const child = makeNestedRunSummary({ id: "nested-child", parentRunId: "run-1", depth: 1, state: "running", children: [grandchild] });
		const entries = normalizeNestedRun(child, "foreground:active:run-1", 1, { now: 1000, source: "foreground", rootRunId: "run-1" });
		for (const entry of entries) assert.equal(entry.runId, "run-1");
	});

	it("stops recursing beyond the source-enforced max nesting depth", () => {
		const run = makeNestedRunSummary({ id: "too-deep" });
		const entries = normalizeNestedRun(run, "parent", 5, { now: 1000, source: "foreground", rootRunId: "run-1" });
		assert.deepEqual(entries, []);
	});

	it("derives the run-level watchdog signal from the last reported step", () => {
		const run = makeNestedRunSummary({
			state: "running",
			steps: [
				{ agent: "worker-a", status: "completed" },
				{ agent: "worker-b", status: "running", watchdog: makeWatchdogSnapshot({ phase: "stale" }) },
			],
		});
		const [entry] = normalizeNestedRun(run, "parent", 1, { now: 1000, source: "async", rootRunId: "async-1" });
		assert.equal(entry?.attentionReason, "watchdog_stalled");
	});
});

describe("buildFleetEntries", () => {
	it("builds a plausible, uniquely-keyed set of entries from a mixed realistic state", () => {
		const state = makeState();

		state.foregroundControls.set(
			"run-parallel",
			makeForegroundControl({
				runId: "run-parallel",
				mode: "parallel",
				currentAgent: "worker-a",
				currentIndex: 1,
				nestedChildren: [makeNestedRunSummary({ id: "nested-x", parentRunId: "run-parallel", state: "running" })],
			}),
		);

		state.foregroundRuns = new Map([
			["run-detached", makeForegroundResumeRun({ runId: "run-detached", children: [makeForegroundResumeChild({ status: "detached" })] })],
		]);

		state.asyncJobs.set("async-active", makeAsyncJobState({ asyncId: "async-active", status: "running" }));
		state.asyncJobs.set("async-recent", makeAsyncJobState({ asyncId: "async-recent", status: "complete" }));

		const entries = buildFleetEntries(state, { now: () => 5000, asyncDirRoot: "/nonexistent-fleet-projection-test-dir" });

		const keys = entries.map((entry) => entry.key);
		assert.equal(new Set(keys).size, keys.length, "all keys must be unique");

		assert.ok(keys.includes("foreground:active:run-parallel"));
		assert.ok(keys.includes("nested:nested-x"));
		assert.ok(keys.includes("foreground:recent:run-detached"));
		assert.ok(keys.includes("async:async-active"));
		assert.ok(keys.includes("async:async-recent"));

		const nestedEntry = entries.find((entry) => entry.key === "nested:nested-x");
		assert.equal(nestedEntry?.parentKey, "foreground:active:run-parallel");
		assert.equal(nestedEntry?.runId, "run-parallel");

		for (const entry of entries) {
			if (entry.parentKey) assert.ok(keys.includes(entry.parentKey), `parentKey ${entry.parentKey} must reference an existing entry`);
		}
	});

	it("skips disk-scanned recent async runs that are already present in the in-memory map", () => {
		const state = makeState();
		state.asyncJobs.set("async-active", makeAsyncJobState({ asyncId: "async-active", status: "running" }));
		const entries = buildFleetEntries(state, { now: () => 5000, asyncDirRoot: "/nonexistent-fleet-projection-test-dir" });
		const asyncEntries = entries.filter((entry) => entry.source === "async" && entry.depth === 0);
		assert.equal(asyncEntries.length, 1);
	});
});
