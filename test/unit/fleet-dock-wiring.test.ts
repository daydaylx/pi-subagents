import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AsyncJobState, ExtensionConfig, ForegroundControlState, SubagentState } from "../../src/shared/types.ts";
import { FLEET_DOCK_WIDGET_KEY, FLEET_INSPECTOR_WIDGET_KEY, WIDGET_KEY } from "../../src/shared/types.ts";
import { createFleetDockWiring } from "../../src/runs/background/fleet-dock-wiring.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import { getProjectArtifactsDir } from "../../src/shared/artifacts.ts";

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
		startedAt: 0,
		updatedAt: 0,
		currentAgent: "worker-x",
		...overrides,
	} as ForegroundControlState;
}

function makeAsyncJobState(overrides: Partial<AsyncJobState> = {}): AsyncJobState {
	return {
		asyncId: "async-1",
		asyncDir: "/tmp/async-1",
		status: "running",
		...overrides,
	} as AsyncJobState;
}

const ESC = "\u001b";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const RETURN = "\r";

interface FakeUi {
	setWidgetCalls: Array<{ key: string; content: unknown; opts: unknown }>;
	terminalInputSubscriptions: number;
	terminalInputUnsubscribed: number;
	requestRenderCalls: number;
	terminalInputHandler?: (data: string) => { consume?: boolean; data?: string } | undefined;
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
		sessionManager: {
			getSessionFile: () => null,
			getSessionId: () => "session-test",
		},
		ui: {
			setWidget(key: string, content: unknown, opts?: unknown) {
				fake.setWidgetCalls.push({ key, content, opts });
			},
			onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined) {
				fake.terminalInputSubscriptions += 1;
				fake.terminalInputHandler = handler;
				return () => {
					fake.terminalInputUnsubscribed += 1;
				};
			},
			getEditorText: () => "",
			requestRender: () => {
				fake.requestRenderCalls += 1;
			},
			theme: { fg: (_n: string, t: string) => t, bg: (_n: string, t: string) => t, bold: (t: string) => t },
		},
	};
	return { ctx, fake };
}

function renderWidget(fake: FakeUi, key: string): string[] {
	const call = [...fake.setWidgetCalls].reverse().find((c) => c.key === key);
	if (!call || typeof call.content !== "function") return [];
	const component = (call.content as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
		{},
		{ fg: (_n: string, t: string) => t, bg: (_n: string, t: string) => t, bold: (t: string) => t },
	);
	return component.render(80);
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

describe("createFleetDockWiring - documented fallback configuration (PHASE-08)", () => {
	// Exakt die in README.md dokumentierte Rueckfallkonfiguration:
	// { "ui": { "fleetView": false, "asyncWidget": true } }. Die Zusage lautet:
	// nichts vom Dock wird registriert (kein Widget, kein Input-Handler, kein
	// Timer) UND das alte Async-Widget bleibt unangetastet, d.h. es wird weder
	// versteckt noch wird state.suppressAsyncWidget gesetzt.
	it("registers nothing of the dock and leaves the old async widget fully intact", () => {
		const state = makeState({ asyncJobs: new Map([["async-1", makeAsyncJobState()]]) });
		const wiring = createFleetDockWiring(state, { ui: { fleetView: false, asyncWidget: true } } as ExtensionConfig);
		assert.equal(wiring.fleetViewEnabled, false);

		const { ctx, fake } = makeCtx();
		wiring.onSessionStart(ctx as never);
		wiring.onToolResult(ctx as never);

		assert.equal(fake.setWidgetCalls.length, 0, "no widget of any kind may be registered or cleared");
		assert.equal(fake.terminalInputSubscriptions, 0, "no terminal input handler may be installed");
		assert.equal(fake.requestRenderCalls, 0, "no render may be forced");
		assert.ok(!state.suppressAsyncWidget, "the old async widget must not be suppressed");

		wiring.dispose();
		assert.equal(fake.setWidgetCalls.length, 0, "dispose() must stay a no-op as well");
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

	it("dispose() also clears the fleet inspector widget", () => {
		const { ctx, fake } = makeCtx();
		const state = makeState({ lastUiContext: ctx as never });
		const wiring = createFleetDockWiring(state, config());
		wiring.onSessionStart(ctx as never);
		wiring.dispose();

		const inspectorCalls = fake.setWidgetCalls.filter((c) => c.key === FLEET_INSPECTOR_WIDGET_KEY);
		assert.equal(inspectorCalls.at(-1)!.content, undefined);
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

describe("createFleetDockWiring - inspector (PHASE-05)", () => {
	function config(overrides: Record<string, unknown> = {}): ExtensionConfig {
		return { ui: { fleetView: true, ...overrides } } as ExtensionConfig;
	}

	it("registers the fleet inspector widget alongside the dock widget", () => {
		const wiring = createFleetDockWiring(makeState(), config());
		const { ctx, fake } = makeCtx();
		wiring.onSessionStart(ctx as never);

		const inspectorCall = fake.setWidgetCalls.find((c) => c.key === FLEET_INSPECTOR_WIDGET_KEY);
		assert.ok(inspectorCall, "expected the fleet inspector widget to be registered");
		assert.equal(typeof inspectorCall!.content, "function");
		assert.deepEqual(inspectorCall!.opts, { placement: "belowEditor" });
	});

	it("renders no inspector content until it is opened", () => {
		const wiring = createFleetDockWiring(makeState(), config());
		const { ctx, fake } = makeCtx();
		wiring.onSessionStart(ctx as never);
		assert.deepEqual(renderWidget(fake, FLEET_INSPECTOR_WIDGET_KEY), []);
	});

	it("Enter opens the inspector for the selected entry and renders its content", () => {
		const state = makeState({ foregroundControls: new Map([["run-1", makeForegroundControl({ runId: "run-1", currentAgent: "worker-x" })]]) });
		const wiring = createFleetDockWiring(state, config());
		const { ctx, fake } = makeCtx();
		wiring.onSessionStart(ctx as never);

		fake.terminalInputHandler!(DOWN); // activate dock, select first entry
		const enterResult = fake.terminalInputHandler!(RETURN); // open inspector instead of toggling inline detail
		assert.equal(enterResult?.consume, true);

		const lines = renderWidget(fake, FLEET_INSPECTOR_WIDGET_KEY);
		assert.ok(lines.some((line) => line.includes("worker-x")));
	});

	it("first Escape closes only the inspector; the dock stays active and keeps consuming arrow keys", () => {
		const state = makeState({ foregroundControls: new Map([["run-1", makeForegroundControl({ runId: "run-1" })]]) });
		const wiring = createFleetDockWiring(state, config());
		const { ctx, fake } = makeCtx();
		wiring.onSessionStart(ctx as never);

		fake.terminalInputHandler!(DOWN);
		fake.terminalInputHandler!(RETURN);
		assert.ok(renderWidget(fake, FLEET_INSPECTOR_WIDGET_KEY).length > 0, "inspector should show content once opened");

		const firstEscape = fake.terminalInputHandler!(ESC);
		assert.equal(firstEscape?.consume, true);
		assert.deepEqual(renderWidget(fake, FLEET_INSPECTOR_WIDGET_KEY), [], "inspector widget should be empty again after closing");

		// The dock must still be active: UP is only consumed while FleetDockController is active.
		const upAfterFirstEscape = fake.terminalInputHandler!(UP);
		assert.equal(upAfterFirstEscape?.consume, true, "dock should still be active and consuming navigation keys");
	});

	it("second Escape (after the inspector is already closed) deactivates the dock", () => {
		const state = makeState({ foregroundControls: new Map([["run-1", makeForegroundControl({ runId: "run-1" })]]) });
		const wiring = createFleetDockWiring(state, config());
		const { ctx, fake } = makeCtx();
		wiring.onSessionStart(ctx as never);

		fake.terminalInputHandler!(DOWN);
		fake.terminalInputHandler!(RETURN);
		fake.terminalInputHandler!(ESC); // closes the inspector only

		const secondEscape = fake.terminalInputHandler!(ESC);
		assert.equal(secondEscape?.consume, true);

		// The dock is now inactive: UP is no longer a recognized activation key, so it must not be consumed.
		const upAfterSecondEscape = fake.terminalInputHandler!(UP);
		assert.equal(upAfterSecondEscape, undefined, "dock should be deactivated, so UP is no longer consumed");
	});

	it("onToolResult invalidates the inspector's transcript cache, forcing a re-read of a real transcript file", () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-dock-wiring-inspector-"));
		try {
			const artifactsDir = getProjectArtifactsDir(projectDir);
			fs.mkdirSync(artifactsDir, { recursive: true });
			const transcriptPath = path.join(artifactsDir, "async-1_worker-a_0_transcript.jsonl");
			fs.writeFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", ts: 1, role: "user", text: "first" })}\n`, "utf-8");

			const job = makeAsyncJobState({
				status: "running",
				steps: [{ index: 0, agent: "worker-a", status: "running", transcriptPath }],
			});
			const state = makeState({ baseCwd: projectDir, asyncJobs: new Map([["async-1", job]]) });
			const wiring = createFleetDockWiring(state, config());
			const { ctx, fake } = makeCtx();
			state.lastUiContext = ctx as never;
			wiring.onSessionStart(ctx as never);

			// buildFleetEntries() returns [parentEntry, stepEntry] in that (unsorted)
			// order; the first DOWN activates the dock and selects the parent (index
			// 0, no transcriptPath), the second DOWN moves to the child step, which
			// carries the transcriptPath.
			fake.terminalInputHandler!(DOWN);
			fake.terminalInputHandler!(DOWN);
			fake.terminalInputHandler!(RETURN);
			const firstRender = renderWidget(fake, FLEET_INSPECTOR_WIDGET_KEY);
			assert.ok(firstRender.some((line) => line.includes("first")), "expected the initial transcript content to render");

			fs.appendFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", ts: 2, role: "user", text: "second" })}\n`, "utf-8");
			wiring.onToolResult(ctx as never);

			const secondRender = renderWidget(fake, FLEET_INSPECTOR_WIDGET_KEY);
			assert.ok(secondRender.some((line) => line.includes("second")), "expected onToolResult to invalidate the cache and pick up the appended line");
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});
});

describe("createFleetDockWiring - stop dispatch (PHASE-06)", () => {
	function config(overrides: Record<string, unknown> = {}): ExtensionConfig {
		return { ui: { fleetView: true, ...overrides } } as ExtensionConfig;
	}

	it("delivers a real stop request file to the async run's control inbox after the second 's'", () => {
		const asyncRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-dock-wiring-stop-"));
		try {
			const asyncDir = path.join(asyncRoot, "async-1");
			fs.mkdirSync(asyncDir, { recursive: true });
			const job = makeAsyncJobState({ asyncDir, status: "running", pid: 4242 });
			const state = makeState({ asyncJobs: new Map([["async-1", job]]) });
			const wiring = createFleetDockWiring(state, config());
			const { ctx, fake } = makeCtx();
			wiring.onSessionStart(ctx as never);

			fake.terminalInputHandler!(DOWN); // activate dock, select the async parent row
			const first = fake.terminalInputHandler!("s");
			assert.equal(first?.consume, true);
			const stopFile = path.join(asyncDir, "control", "stop.json");
			assert.ok(!fs.existsSync(stopFile), "the first 's' only arms the confirmation, it must not stop yet");

			const second = fake.terminalInputHandler!("s");
			assert.equal(second?.consume, true);
			assert.ok(fs.existsSync(stopFile), "the second 's' on the same entry must deliver a real stop request");
			const payload = JSON.parse(fs.readFileSync(stopFile, "utf-8"));
			assert.equal(payload.type, "stop");
		} finally {
			fs.rmSync(asyncRoot, { recursive: true, force: true });
		}
	});

	it("never writes a stop request for a foreground entry - no terminal stop channel exists for it", () => {
		const state = makeState({ foregroundControls: new Map([["run-1", makeForegroundControl({ runId: "run-1" })]]) });
		const wiring = createFleetDockWiring(state, config());
		const { ctx, fake } = makeCtx();
		wiring.onSessionStart(ctx as never);

		fake.terminalInputHandler!(DOWN);
		const result = fake.terminalInputHandler!("s");
		assert.equal(result, undefined);
	});
});

