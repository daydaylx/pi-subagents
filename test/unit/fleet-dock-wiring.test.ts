import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionConfig, SubagentState } from "../../src/shared/types.ts";
import { FLEET_DOCK_WIDGET_KEY, WIDGET_KEY } from "../../src/shared/types.ts";
import { createFleetDockWiring } from "../../src/runs/background/fleet-dock-wiring.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";

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

interface FakeUi {
	setWidgetCalls: Array<{ key: string; content: unknown; opts: unknown }>;
	terminalInputSubscriptions: number;
	terminalInputUnsubscribed: number;
	requestRenderCalls: number;
}

function makeCtx(overrides: { hasUI?: boolean } = {}) {
	const fake: FakeUi = {
		setWidgetCalls: [],
		terminalInputSubscriptions: 0,
		terminalInputUnsubscribed: 0,
		requestRenderCalls: 0,
	};
	const ctx = {
		hasUI: overrides.hasUI ?? true,
		ui: {
			setWidget(key: string, content: unknown, opts?: unknown) {
				fake.setWidgetCalls.push({ key, content, opts });
			},
			onTerminalInput(_handler: (data: string) => unknown) {
				fake.terminalInputSubscriptions += 1;
				return () => {
					fake.terminalInputUnsubscribed += 1;
				};
			},
			getEditorText: () => "",
			requestRender: () => {
				fake.requestRenderCalls += 1;
			},
		},
	};
	return { ctx, fake };
}

describe("createFleetDockWiring - disabled", () => {
	it("reports fleetViewEnabled=false and never touches the UI", () => {
		const wiring = createFleetDockWiring(makeState(), {} as ExtensionConfig);
		assert.equal(wiring.fleetViewEnabled, false);

		const { ctx, fake } = makeCtx();
		wiring.onSessionStart(ctx as never);
		wiring.onToolResult(ctx as never);
		assert.equal(fake.setWidgetCalls.length, 0);
		assert.equal(fake.terminalInputSubscriptions, 0);
		assert.equal(fake.requestRenderCalls, 0);
	});
});

describe("createFleetDockWiring - asyncWidget precedence (fleetView off)", () => {
	it("hides the old async widget when ui.asyncWidget is explicitly false, even without fleetView", () => {
		const wiring = createFleetDockWiring(makeState(), { ui: { asyncWidget: false } } as ExtensionConfig);
		assert.equal(wiring.fleetViewEnabled, false);
		const { ctx, fake } = makeCtx();

		wiring.onSessionStart(ctx as never);
		assert.equal(fake.setWidgetCalls.length, 0, "fleetView is off, no fleet dock widget expected");
		assert.equal(fake.terminalInputSubscriptions, 0);

		wiring.onToolResult(ctx as never);
		const asyncCall = fake.setWidgetCalls.find((c) => c.key === WIDGET_KEY);
		assert.ok(asyncCall, "expected ui.asyncWidget:false to override the old widget");
		assert.equal(asyncCall!.content, undefined);
		assert.equal(fake.requestRenderCalls, 1);
	});

	it("leaves the old async widget alone when ui.asyncWidget is unset (falls back to index.ts's own showAsyncWidget)", () => {
		const wiring = createFleetDockWiring(makeState(), {} as ExtensionConfig);
		const { ctx, fake } = makeCtx();
		wiring.onToolResult(ctx as never);
		assert.equal(fake.setWidgetCalls.length, 0);
		assert.equal(fake.requestRenderCalls, 0);
	});

	it("leaves the old async widget alone when ui.asyncWidget is explicitly true", () => {
		const wiring = createFleetDockWiring(makeState(), { ui: { asyncWidget: true } } as ExtensionConfig);
		const { ctx, fake } = makeCtx();
		wiring.onToolResult(ctx as never);
		assert.equal(fake.setWidgetCalls.length, 0);
	});
});

describe("createFleetDockWiring + async-job-tracker.ts - widget resurrection regression", () => {
	// Regression test for a bug found during independent verification: the
	// legacy widget was hidden once via onToolResult(), but async-job-tracker's
	// own rerenderWidget() (poller ticks, handleStarted/handleComplete) kept
	// showing it again on every job status change, unaware of fleetView/
	// asyncWidget. This test wires up the REAL async-job-tracker.ts (not a
	// mock) to prove state.suppressAsyncWidget actually reaches it.
	function fakePiEvents() {
		return { events: { on: () => () => {}, emit: () => {} } };
	}

	it("keeps the old widget hidden across an async-job-tracker re-render when fleetView is active", () => {
		const state = makeState();
		const wiring = createFleetDockWiring(state, { ui: { fleetView: true } } as ExtensionConfig);
		assert.equal(state.suppressAsyncWidget, true);

		const tracker = createAsyncJobTracker(fakePiEvents(), state, "/nonexistent-fleet-dock-wiring-test-dir", { showAsyncWidget: true });
		const { ctx, fake } = makeCtx();
		state.lastUiContext = ctx as never;

		wiring.onToolResult(ctx as never);
		assert.ok(fake.setWidgetCalls.some((c) => c.key === WIDGET_KEY && c.content === undefined));

		fake.setWidgetCalls.length = 0;
		// Simulates an async job status change arriving between two tool_result
		// events - the real trigger for the resurrection bug.
		tracker.handleComplete({ id: "unrelated-job", success: true });

		const resurrected = fake.setWidgetCalls.find((c) => c.key === WIDGET_KEY && c.content !== undefined);
		assert.equal(resurrected, undefined, "the old widget must not reappear via the tracker's own rerender path");
	});

	it("keeps the old widget hidden across a tracker re-render when only ui.asyncWidget:false is set", () => {
		const state = makeState();
		const wiring = createFleetDockWiring(state, { ui: { asyncWidget: false } } as ExtensionConfig);
		assert.equal(state.suppressAsyncWidget, true);

		const tracker = createAsyncJobTracker(fakePiEvents(), state, "/nonexistent-fleet-dock-wiring-test-dir", { showAsyncWidget: true });
		const { ctx, fake } = makeCtx();
		state.lastUiContext = ctx as never;
		wiring.onToolResult(ctx as never);
		fake.setWidgetCalls.length = 0;

		tracker.handleComplete({ id: "unrelated-job", success: true });

		const resurrected = fake.setWidgetCalls.find((c) => c.key === WIDGET_KEY && c.content !== undefined);
		assert.equal(resurrected, undefined);
	});

	it("does not suppress the tracker's own widget when FleetView and asyncWidget are both untouched", () => {
		const state = makeState();
		createFleetDockWiring(state, {} as ExtensionConfig);
		assert.equal(state.suppressAsyncWidget, false);

		const tracker = createAsyncJobTracker(fakePiEvents(), state, "/nonexistent-fleet-dock-wiring-test-dir", { showAsyncWidget: true });
		const { ctx, fake } = makeCtx();
		state.lastUiContext = ctx as never;

		tracker.handleComplete({ id: "unrelated-job", success: true });
		assert.ok(fake.setWidgetCalls.some((c) => c.key === WIDGET_KEY), "the legacy widget should render normally when nothing suppresses it");
	});
});

describe("createFleetDockWiring - enabled", () => {
	function config(overrides: Record<string, unknown> = {}): ExtensionConfig {
		return { ui: { fleetView: true, ...overrides } } as ExtensionConfig;
	}

	it("registers the fleet dock widget with the default belowEditor placement", () => {
		const wiring = createFleetDockWiring(makeState(), config());
		assert.equal(wiring.fleetViewEnabled, true);
		const { ctx, fake } = makeCtx();
		wiring.onSessionStart(ctx as never);

		const fleetCall = fake.setWidgetCalls.find((c) => c.key === FLEET_DOCK_WIDGET_KEY);
		assert.ok(fleetCall, "expected the fleet dock widget to be registered");
		assert.equal(typeof fleetCall!.content, "function");
		assert.deepEqual(fleetCall!.opts, { placement: "belowEditor" });
		assert.equal(fake.terminalInputSubscriptions, 1);
	});

	it("honors a custom fleetViewPlacement", () => {
		const wiring = createFleetDockWiring(makeState(), config({ fleetViewPlacement: "aboveEditor" }));
		const { ctx, fake } = makeCtx();
		wiring.onSessionStart(ctx as never);
		const fleetCall = fake.setWidgetCalls.find((c) => c.key === FLEET_DOCK_WIDGET_KEY);
		assert.deepEqual(fleetCall!.opts, { placement: "aboveEditor" });
	});

	it("does nothing when ctx.hasUI is false", () => {
		const wiring = createFleetDockWiring(makeState(), config());
		const { ctx, fake } = makeCtx({ hasUI: false });
		wiring.onSessionStart(ctx as never);
		wiring.onToolResult(ctx as never);
		assert.equal(fake.setWidgetCalls.length, 0);
		assert.equal(fake.terminalInputSubscriptions, 0);
	});

	it("unsubscribes the previous terminal input handler on a repeated onSessionStart call", () => {
		const wiring = createFleetDockWiring(makeState(), config());
		const { ctx, fake } = makeCtx();
		wiring.onSessionStart(ctx as never);
		wiring.onSessionStart(ctx as never);
		assert.equal(fake.terminalInputSubscriptions, 2);
		assert.equal(fake.terminalInputUnsubscribed, 1);
	});

	it("overrides the old async widget to undefined and requests a render on tool_result", () => {
		const wiring = createFleetDockWiring(makeState(), config());
		const { ctx, fake } = makeCtx();
		wiring.onToolResult(ctx as never);

		const asyncCall = fake.setWidgetCalls.find((c) => c.key === WIDGET_KEY);
		assert.ok(asyncCall, "expected the old async widget key to be touched");
		assert.equal(asyncCall!.content, undefined);
		assert.equal(fake.requestRenderCalls, 1);
	});

	it("dispose() clears the fleet dock widget via state.lastUiContext and unsubscribes terminal input", () => {
		const { ctx, fake } = makeCtx();
		const state = makeState({ lastUiContext: ctx as never });
		const wiring = createFleetDockWiring(state, config());
		wiring.onSessionStart(ctx as never);
		wiring.dispose();

		const fleetCalls = fake.setWidgetCalls.filter((c) => c.key === FLEET_DOCK_WIDGET_KEY);
		assert.equal(fleetCalls.at(-1)!.content, undefined);
		assert.equal(fake.terminalInputUnsubscribed, 1);
	});

	it("dispose() is a no-op when there is no lastUiContext", () => {
		const wiring = createFleetDockWiring(makeState({ lastUiContext: null }), config());
		assert.doesNotThrow(() => wiring.dispose());
	});

	it("dispose() swallows a stale extension context error", () => {
		const ctx = {
			hasUI: true,
			ui: {
				setWidget() {
					throw new Error("Extension context no longer active");
				},
			},
		};
		const state = makeState({ lastUiContext: ctx as never });
		const wiring = createFleetDockWiring(state, config());
		assert.doesNotThrow(() => wiring.dispose());
	});

	it("dispose() rethrows unrelated errors", () => {
		const ctx = {
			hasUI: true,
			ui: {
				setWidget() {
					throw new Error("boom");
				},
			},
		};
		const state = makeState({ lastUiContext: ctx as never });
		const wiring = createFleetDockWiring(state, config());
		assert.throws(() => wiring.dispose(), /boom/);
	});
});
