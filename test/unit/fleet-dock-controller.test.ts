import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ForegroundControlState, SubagentState } from "../../src/shared/types.ts";
import { createFleetDockController, DEFAULT_REFRESH_INTERVAL_MS } from "../../src/runs/background/fleet-dock-controller.ts";

// buildFleetEntries() falls back to a real disk scan (listAsyncRuns) for
// "recent" async runs unless asyncDirRoot is overridden. Other test files in
// the shared node:test process may leave real async run artifacts behind in
// the default ASYNC_DIR, which would otherwise leak into these entry counts.
// Point at a nonexistent directory so the scan reliably returns [].
const NO_ASYNC_DEPS = { deps: { asyncDirRoot: "/nonexistent-fleet-dock-controller-test-dir" } };

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
	} as SubagentState;
}

function makeForegroundControl(overrides: Partial<ForegroundControlState> = {}): ForegroundControlState {
	return {
		runId: "run-1",
		mode: "single",
		startedAt: 1000,
		updatedAt: 1000,
		currentAgent: "worker",
		...overrides,
	} as ForegroundControlState;
}

function makeClock(start: number) {
	let current = start;
	return {
		now: () => current,
		advance: (deltaMs: number) => {
			current += deltaMs;
		},
	};
}

function emptyEditor() {
	return { getEditorText: () => "" };
}

function filledEditor() {
	return { getEditorText: () => "some text" };
}

describe("FleetDockController selection", () => {
	it("keeps the selection on the same key across refreshes while it still exists", () => {
		const state = makeState({
			foregroundControls: new Map([
				["run-1", makeForegroundControl({ runId: "run-1" })],
				["run-2", makeForegroundControl({ runId: "run-2", currentAgent: "helper" })],
			]),
		});
		const clock = makeClock(0);
		const controller = createFleetDockController(state, { now: clock.now, ...NO_ASYNC_DEPS });
		const entries = controller.getEntries();
		const secondKey = entries[1]!.key;
		controller.activate();
		controller.moveSelection(1);
		assert.equal(controller.getSelectedKey(), secondKey);

		clock.advance(DEFAULT_REFRESH_INTERVAL_MS + 1);
		controller.getEntries();
		assert.equal(controller.getSelectedKey(), secondKey);
	});

	it("falls back to the nearest remaining index when the selected entry disappears", () => {
		const controls = new Map([
			["run-1", makeForegroundControl({ runId: "run-1" })],
			["run-2", makeForegroundControl({ runId: "run-2", currentAgent: "helper" })],
			["run-3", makeForegroundControl({ runId: "run-3", currentAgent: "third" })],
		]);
		const state = makeState({ foregroundControls: controls });
		const clock = makeClock(0);
		const controller = createFleetDockController(state, { now: clock.now, ...NO_ASYNC_DEPS });
		const entries = controller.getEntries();
		const middleKey = entries[1]!.key;
		controller.activate();
		controller.moveSelection(1);
		assert.equal(controller.getSelectedKey(), middleKey);

		controls.delete("run-2");
		clock.advance(DEFAULT_REFRESH_INTERVAL_MS + 1);
		const nextEntries = controller.getEntries();
		assert.equal(nextEntries.length, 2);
		assert.ok(nextEntries.some((entry) => entry.key === controller.getSelectedKey()));
	});

	it("clears the selection once no entries remain", () => {
		const controls = new Map([["run-1", makeForegroundControl()]]);
		const state = makeState({ foregroundControls: controls });
		const clock = makeClock(0);
		const controller = createFleetDockController(state, { now: clock.now, ...NO_ASYNC_DEPS });
		controller.activate();
		assert.notEqual(controller.getSelectedKey(), undefined);

		controls.delete("run-1");
		clock.advance(DEFAULT_REFRESH_INTERVAL_MS + 1);
		controller.getEntries();
		assert.equal(controller.getSelectedKey(), undefined);
	});
});

describe("FleetDockController throttling", () => {
	it("does not pick up state changes within the refresh window", () => {
		const controls = new Map([["run-1", makeForegroundControl()]]);
		const state = makeState({ foregroundControls: controls });
		const clock = makeClock(0);
		const controller = createFleetDockController(state, { now: clock.now, ...NO_ASYNC_DEPS });
		assert.equal(controller.getEntries().length, 1);

		controls.set("run-2", makeForegroundControl({ runId: "run-2", currentAgent: "helper" }));
		clock.advance(DEFAULT_REFRESH_INTERVAL_MS - 1);
		assert.equal(controller.getEntries().length, 1);
	});

	it("picks up state changes once the refresh window elapses", () => {
		const controls = new Map([["run-1", makeForegroundControl()]]);
		const state = makeState({ foregroundControls: controls });
		const clock = makeClock(0);
		const controller = createFleetDockController(state, { now: clock.now, ...NO_ASYNC_DEPS });
		assert.equal(controller.getEntries().length, 1);

		controls.set("run-2", makeForegroundControl({ runId: "run-2", currentAgent: "helper" }));
		clock.advance(DEFAULT_REFRESH_INTERVAL_MS + 1);
		assert.equal(controller.getEntries().length, 2);
	});

	it("invalidateCache() forces a recompute even inside the window", () => {
		const controls = new Map([["run-1", makeForegroundControl()]]);
		const state = makeState({ foregroundControls: controls });
		const clock = makeClock(0);
		const controller = createFleetDockController(state, { now: clock.now, ...NO_ASYNC_DEPS });
		assert.equal(controller.getEntries().length, 1);

		controls.set("run-2", makeForegroundControl({ runId: "run-2", currentAgent: "helper" }));
		controller.invalidateCache();
		assert.equal(controller.getEntries().length, 2);
	});
});

describe("FleetDockController keyboard focus", () => {
	function stateWithTwoEntries() {
		return makeState({
			foregroundControls: new Map([
				["run-1", makeForegroundControl({ runId: "run-1" })],
				["run-2", makeForegroundControl({ runId: "run-2", currentAgent: "helper" })],
			]),
		});
	}

	it("activates on down when the editor is empty", () => {
		const controller = createFleetDockController(stateWithTwoEntries(), NO_ASYNC_DEPS);
		const result = controller.handleTerminalInput(emptyEditor(), "\u001b[B");
		assert.equal(result?.consume, true);
		assert.equal(controller.isActive(), true);
		assert.notEqual(controller.getSelectedKey(), undefined);
	});

	it("does not activate on down when the editor has text", () => {
		const controller = createFleetDockController(stateWithTwoEntries(), NO_ASYNC_DEPS);
		const result = controller.handleTerminalInput(filledEditor(), "\u001b[B");
		assert.equal(result, undefined);
		assert.equal(controller.isActive(), false);
	});

	it("ignores keys other than down while inactive", () => {
		const controller = createFleetDockController(stateWithTwoEntries(), NO_ASYNC_DEPS);
		const result = controller.handleTerminalInput(emptyEditor(), "\u001b[A");
		assert.equal(result, undefined);
		assert.equal(controller.isActive(), false);
	});

	it("navigates with up/down and toggles detail with return while active", () => {
		const controller = createFleetDockController(stateWithTwoEntries(), NO_ASYNC_DEPS);
		controller.handleTerminalInput(emptyEditor(), "\u001b[B"); // activate, select first
		const firstKey = controller.getSelectedKey();

		const downResult = controller.handleTerminalInput(emptyEditor(), "\u001b[B");
		assert.equal(downResult?.consume, true);
		assert.notEqual(controller.getSelectedKey(), firstKey);

		const upResult = controller.handleTerminalInput(emptyEditor(), "\u001b[A");
		assert.equal(upResult?.consume, true);
		assert.equal(controller.getSelectedKey(), firstKey);

		const enterResult = controller.handleTerminalInput(emptyEditor(), "\r");
		assert.equal(enterResult?.consume, true);
		assert.equal(controller.getExpandedKey(), firstKey);

		const enterAgainResult = controller.handleTerminalInput(emptyEditor(), "\r");
		assert.equal(enterAgainResult?.consume, true);
		assert.equal(controller.getExpandedKey(), undefined);
	});

	it("deactivates on escape", () => {
		const controller = createFleetDockController(stateWithTwoEntries(), NO_ASYNC_DEPS);
		controller.handleTerminalInput(emptyEditor(), "\u001b[B");
		assert.equal(controller.isActive(), true);
		const result = controller.handleTerminalInput(emptyEditor(), "\u001b");
		assert.equal(result?.consume, true);
		assert.equal(controller.isActive(), false);
	});

	it("self-heals: deactivates once the editor is no longer empty, without consuming the key", () => {
		const controller = createFleetDockController(stateWithTwoEntries(), NO_ASYNC_DEPS);
		controller.handleTerminalInput(emptyEditor(), "\u001b[B");
		assert.equal(controller.isActive(), true);

		const result = controller.handleTerminalInput(filledEditor(), "a");
		assert.equal(result, undefined);
		assert.equal(controller.isActive(), false);
	});

	it("never consumes a key while the editor is not empty, even if it looks like navigation", () => {
		const controller = createFleetDockController(stateWithTwoEntries(), NO_ASYNC_DEPS);
		const result = controller.handleTerminalInput(filledEditor(), "\u001b[A");
		assert.equal(result, undefined);
	});
});

describe("FleetDockController onOpenInspector", () => {
	function stateWithTwoEntries() {
		return makeState({
			foregroundControls: new Map([
				["run-1", makeForegroundControl({ runId: "run-1" })],
				["run-2", makeForegroundControl({ runId: "run-2", currentAgent: "helper" })],
			]),
		});
	}

	it("calls onOpenInspector with the selected key on return instead of toggling the inline detail line", () => {
		let openedKey: string | undefined;
		const controller = createFleetDockController(stateWithTwoEntries(), {
			...NO_ASYNC_DEPS,
			onOpenInspector: (key) => {
				openedKey = key;
			},
		});
		controller.handleTerminalInput(emptyEditor(), "\u001b[B"); // activate, select first
		const firstKey = controller.getSelectedKey();
		const result = controller.handleTerminalInput(emptyEditor(), "\r");
		assert.equal(result?.consume, true);
		assert.equal(openedKey, firstKey);
		assert.equal(controller.getExpandedKey(), undefined);
	});

	it("falls back to toggleExpanded() when onOpenInspector is not provided (PHASE-04 behavior unchanged)", () => {
		const controller = createFleetDockController(stateWithTwoEntries(), NO_ASYNC_DEPS);
		controller.handleTerminalInput(emptyEditor(), "\u001b[B");
		const firstKey = controller.getSelectedKey();
		controller.handleTerminalInput(emptyEditor(), "\r");
		assert.equal(controller.getExpandedKey(), firstKey);
	});
});
