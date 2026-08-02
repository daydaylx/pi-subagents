import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FleetAgentEntry, FleetAgentState } from "../../src/runs/shared/fleet-projection.ts";
import type { ReadChildTranscriptResult } from "../../src/runs/shared/fleet-transcript-reader.ts";
import { createFleetInspectorController, DEFAULT_INSPECTOR_REFRESH_INTERVAL_MS } from "../../src/runs/background/fleet-inspector-controller.ts";

function makeEntry(overrides: Partial<FleetAgentEntry> & { key: string; state: FleetAgentState }): FleetAgentEntry {
	return {
		key: overrides.key,
		runId: overrides.runId ?? overrides.key,
		source: overrides.source ?? "async",
		kind: overrides.kind ?? "active",
		depth: overrides.depth ?? 0,
		agent: overrides.agent ?? "worker",
		state: overrides.state,
		needsAttention: overrides.needsAttention ?? false,
		canStop: overrides.canStop ?? true,
		startedAt: overrides.startedAt ?? 0,
		updatedAt: overrides.updatedAt ?? 0,
		...overrides,
	};
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

function stubReader(result: ReadChildTranscriptResult) {
	let calls = 0;
	return {
		fn: (_path: string, _roots: string[]): ReadChildTranscriptResult => {
			calls += 1;
			return result;
		},
		callCount: () => calls,
	};
}

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const SPACE = " ";
const RETURN = "\r";

describe("FleetInspectorController lifecycle", () => {
	it("is closed by default and opens/closes on demand", () => {
		const controller = createFleetInspectorController(() => []);
		assert.equal(controller.isOpen(), false);
		controller.open("a");
		assert.equal(controller.isOpen(), true);
		controller.close();
		assert.equal(controller.isOpen(), false);
	});

	it("resets scroll and tool-details-expanded when opening, even for a previously inspected entry", () => {
		const controller = createFleetInspectorController(() => []);
		controller.open("a");
		controller.scrollUp(5);
		controller.toggleToolDetails();
		assert.equal(controller.getScrollFromBottom(), 5);
		assert.equal(controller.isToolDetailsExpanded(), true);

		controller.open("b");
		assert.equal(controller.getScrollFromBottom(), 0);
		assert.equal(controller.isToolDetailsExpanded(), false);
	});

	it("resolves the selected entry and its children from the injected getEntries accessor", () => {
		const entries = [
			makeEntry({ key: "parent", state: "running" }),
			makeEntry({ key: "parent:0", state: "running", parentKey: "parent" }),
			makeEntry({ key: "parent:1", state: "running", parentKey: "parent" }),
			makeEntry({ key: "other", state: "running" }),
		];
		const controller = createFleetInspectorController(() => entries);
		controller.open("parent");
		assert.equal(controller.getSelectedEntry()?.key, "parent");
		assert.deepEqual(controller.getChildren().map((e) => e.key), ["parent:0", "parent:1"]);
	});

	it("returns undefined/empty when the previously opened key has disappeared from the entries list", () => {
		const controller = createFleetInspectorController(() => []);
		controller.open("gone");
		assert.equal(controller.getSelectedEntry(), undefined);
		assert.deepEqual(controller.getChildren(), []);
		assert.doesNotThrow(() => controller.getTranscript());
	});
});

describe("FleetInspectorController transcript throttling", () => {
	function controllerWithEntry(reader: ReturnType<typeof stubReader>, clock: ReturnType<typeof makeClock>) {
		const entry = makeEntry({ key: "a", state: "running", transcriptPath: "/tmp/a_transcript.jsonl" });
		const controller = createFleetInspectorController(() => [entry], {
			now: clock.now,
			readTranscript: reader.fn,
			trustedRoots: () => ["/tmp"],
		});
		controller.open("a");
		return controller;
	}

	it("does not re-read within the refresh window", () => {
		const clock = makeClock(0);
		const reader = stubReader({ events: [], truncated: false });
		const controller = controllerWithEntry(reader, clock);
		assert.equal(reader.callCount(), 0); // open() invalidates the cache but does not itself trigger a read
		controller.getTranscript();
		controller.getTranscript();
		clock.advance(DEFAULT_INSPECTOR_REFRESH_INTERVAL_MS - 1);
		controller.getTranscript();
		assert.equal(reader.callCount(), 1);
	});

	it("re-reads once the refresh window elapses", () => {
		const clock = makeClock(0);
		const reader = stubReader({ events: [], truncated: false });
		const controller = controllerWithEntry(reader, clock);
		controller.getTranscript();
		const before = reader.callCount();
		clock.advance(DEFAULT_INSPECTOR_REFRESH_INTERVAL_MS + 1);
		controller.getTranscript();
		assert.equal(reader.callCount(), before + 1);
	});

	it("invalidateTranscriptCache() forces an immediate re-read even inside the window", () => {
		const clock = makeClock(0);
		const reader = stubReader({ events: [], truncated: false });
		const controller = controllerWithEntry(reader, clock);
		controller.getTranscript();
		const before = reader.callCount();
		controller.invalidateTranscriptCache();
		controller.getTranscript();
		assert.equal(reader.callCount(), before + 1);
	});

	it("skips reading entirely when the selected entry has no transcriptPath", () => {
		const clock = makeClock(0);
		const reader = stubReader({ events: [], truncated: false });
		const entry = makeEntry({ key: "a", state: "running" });
		const controller = createFleetInspectorController(() => [entry], { now: clock.now, readTranscript: reader.fn });
		controller.open("a");
		controller.getTranscript();
		assert.equal(reader.callCount(), 0);
	});
});

describe("FleetInspectorController scroll state", () => {
	it("clamps scrollUp/scrollDown at zero", () => {
		const controller = createFleetInspectorController(() => []);
		controller.open("a");
		assert.equal(controller.getScrollFromBottom(), 0);
		controller.scrollDown();
		assert.equal(controller.getScrollFromBottom(), 0);
		controller.scrollUp(3);
		assert.equal(controller.getScrollFromBottom(), 3);
		controller.scrollDown(10);
		assert.equal(controller.getScrollFromBottom(), 0);
	});

	it("pageUp/pageDown move by maxVisibleLines", () => {
		const controller = createFleetInspectorController(() => [], { maxVisibleLines: 7 });
		controller.open("a");
		controller.pageUp();
		assert.equal(controller.getScrollFromBottom(), 7);
		controller.pageDown();
		assert.equal(controller.getScrollFromBottom(), 0);
	});

	it("scrollToBottom resets to 0 and scrollToTop jumps to a large value clamped later by the renderer", () => {
		const controller = createFleetInspectorController(() => []);
		controller.open("a");
		controller.scrollToTop();
		assert.ok(controller.getScrollFromBottom() > 1_000_000);
		controller.scrollToBottom();
		assert.equal(controller.getScrollFromBottom(), 0);
	});

	it("toggleToolDetails flips isToolDetailsExpanded", () => {
		const controller = createFleetInspectorController(() => []);
		assert.equal(controller.isToolDetailsExpanded(), false);
		controller.toggleToolDetails();
		assert.equal(controller.isToolDetailsExpanded(), true);
		controller.toggleToolDetails();
		assert.equal(controller.isToolDetailsExpanded(), false);
	});
});

describe("FleetInspectorController handleTerminalInput", () => {
	it("ignores all input while closed", () => {
		const controller = createFleetInspectorController(() => []);
		for (const key of [ESC, UP, DOWN, PAGE_UP, PAGE_DOWN, HOME, END, SPACE, RETURN]) {
			assert.equal(controller.handleTerminalInput(key), undefined);
		}
	});

	it("closes on escape", () => {
		const controller = createFleetInspectorController(() => []);
		controller.open("a");
		const result = controller.handleTerminalInput(ESC);
		assert.equal(result?.consume, true);
		assert.equal(controller.isOpen(), false);
	});

	it("scrolls up/down by one line", () => {
		const controller = createFleetInspectorController(() => []);
		controller.open("a");
		controller.scrollUp(5);
		const downResult = controller.handleTerminalInput(DOWN);
		assert.equal(downResult?.consume, true);
		assert.equal(controller.getScrollFromBottom(), 4);
		const upResult = controller.handleTerminalInput(UP);
		assert.equal(upResult?.consume, true);
		assert.equal(controller.getScrollFromBottom(), 5);
	});

	it("pages with pageUp/pageDown", () => {
		const controller = createFleetInspectorController(() => [], { maxVisibleLines: 4 });
		controller.open("a");
		const result = controller.handleTerminalInput(PAGE_UP);
		assert.equal(result?.consume, true);
		assert.equal(controller.getScrollFromBottom(), 4);
		controller.handleTerminalInput(PAGE_DOWN);
		assert.equal(controller.getScrollFromBottom(), 0);
	});

	it("jumps with home/end", () => {
		const controller = createFleetInspectorController(() => []);
		controller.open("a");
		controller.handleTerminalInput(HOME);
		assert.ok(controller.getScrollFromBottom() > 0);
		const endResult = controller.handleTerminalInput(END);
		assert.equal(endResult?.consume, true);
		assert.equal(controller.getScrollFromBottom(), 0);
	});

	it("toggles tool details with space", () => {
		const controller = createFleetInspectorController(() => []);
		controller.open("a");
		const result = controller.handleTerminalInput(SPACE);
		assert.equal(result?.consume, true);
		assert.equal(controller.isToolDetailsExpanded(), true);
	});

	it("consumes return without side effects (reserved for a future phase)", () => {
		const controller = createFleetInspectorController(() => []);
		controller.open("a");
		const result = controller.handleTerminalInput(RETURN);
		assert.equal(result?.consume, true);
		assert.equal(controller.getScrollFromBottom(), 0);
		assert.equal(controller.isToolDetailsExpanded(), false);
	});

	it("does not consume unrecognized keys", () => {
		const controller = createFleetInspectorController(() => []);
		controller.open("a");
		assert.equal(controller.handleTerminalInput("q"), undefined);
	});
});

describe("FleetInspectorController createComponent", () => {
	function makeTheme() {
		return { fg: (_n: string, t: string) => t, bg: (_n: string, t: string) => t, bold: (t: string) => t } as Parameters<
			ReturnType<typeof createFleetInspectorController>["createComponent"]
		>[0];
	}

	it("renders no lines while closed", () => {
		const controller = createFleetInspectorController(() => []);
		const component = controller.createComponent(makeTheme());
		assert.deepEqual(component.render(80), []);
	});

	it("renders inspector content once opened", () => {
		const entry = makeEntry({ key: "a", state: "running", agent: "worker-x" });
		const controller = createFleetInspectorController(() => [entry]);
		controller.open("a");
		const component = controller.createComponent(makeTheme());
		const lines = component.render(80);
		assert.ok(lines.length > 0);
		assert.ok(lines.some((line) => line.includes("worker-x")));
	});
});
