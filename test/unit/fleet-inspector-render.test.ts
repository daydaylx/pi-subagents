import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FleetAgentEntry, FleetAgentState } from "../../src/runs/shared/fleet-projection.ts";
import type { TranscriptEvent } from "../../src/runs/shared/fleet-transcript-reader.ts";
import { DEFAULT_INSPECTOR_MAX_VISIBLE_LINES, renderFleetInspector } from "../../src/tui/fleet-inspector.ts";

function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeTheme() {
	return {
		fg: (_name: string, text: string) => text,
		bg: (_name: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Parameters<typeof renderFleetInspector>[3]["theme"];
}

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

function baseOpts(overrides: Partial<Parameters<typeof renderFleetInspector>[3]> = {}) {
	return { width: 200, theme: makeTheme(), scrollFromBottom: 0, toolDetailsExpanded: false, now: 0, ...overrides };
}

function emptyTranscript(overrides: Partial<Parameters<typeof renderFleetInspector>[2]> = {}) {
	return { events: [], truncated: false, ...overrides };
}

describe("renderFleetInspector: identity and metadata", () => {
	it("shows a single placeholder line when the entry is gone", () => {
		const lines = renderFleetInspector(undefined, [], emptyTranscript(), baseOpts());
		assert.equal(lines.length, 1);
		assert.match(stripAnsi(lines[0]!), /nicht mehr verfuegbar/);
	});

	it("includes agent name, source, runId and childIndex in the header", () => {
		const entry = makeEntry({ key: "a", state: "running", agent: "worker-a", source: "async", runId: "run-9", childIndex: 2 });
		const lines = renderFleetInspector(entry, [], emptyTranscript(), baseOpts());
		const header = stripAnsi(lines[0]!);
		assert.match(header, /worker-a/);
		assert.match(header, /async/);
		assert.match(header, /run-9/);
		assert.match(header, /child 2/);
	});

	it("omits the child-index fragment when childIndex is undefined", () => {
		const entry = makeEntry({ key: "a", state: "running", runId: "run-9" });
		const lines = renderFleetInspector(entry, [], emptyTranscript(), baseOpts());
		assert.doesNotMatch(stripAnsi(lines[0]!), /child/);
	});

	it("shows a model/thinking badge only when at least one is present", () => {
		const withBoth = makeEntry({ key: "a", state: "running", model: "claude-sonnet-5", thinking: "high" });
		const withNeither = makeEntry({ key: "b", state: "running" });
		const linesWithBoth = renderFleetInspector(withBoth, [], emptyTranscript(), baseOpts()).map(stripAnsi);
		const linesWithNeither = renderFleetInspector(withNeither, [], emptyTranscript(), baseOpts()).map(stripAnsi);
		assert.ok(linesWithBoth.some((line) => line.includes("claude-sonnet-5")));
		assert.ok(!linesWithNeither.some((line) => line.includes("claude-sonnet-5")));
	});

	it("shows the description line only when present", () => {
		const withDescription = makeEntry({ key: "a", state: "running", description: "fixing the bug" });
		const withoutDescription = makeEntry({ key: "b", state: "running" });
		const withLines = renderFleetInspector(withDescription, [], emptyTranscript(), baseOpts()).map(stripAnsi);
		const withoutLines = renderFleetInspector(withoutDescription, [], emptyTranscript(), baseOpts()).map(stripAnsi);
		assert.ok(withLines.some((line) => line.includes("fixing the bug")));
		assert.ok(!withoutLines.some((line) => line.includes("fixing the bug")));
	});

	it("falls back cleanly when token totals are undefined", () => {
		const entry = makeEntry({ key: "a", state: "running", startedAt: 0, updatedAt: 0 });
		const lines = renderFleetInspector(entry, [], emptyTranscript(), baseOpts({ now: 5000 })).map(stripAnsi);
		assert.ok(lines.some((line) => line.includes("running")));
	});

	it("includes turn/tool/token counts in the stats line when present", () => {
		const entry = makeEntry({ key: "a", state: "running", turnCount: 4, toolCount: 7, tokens: 2500, startedAt: 0 });
		const lines = renderFleetInspector(entry, [], emptyTranscript(), baseOpts({ now: 1000 })).map(stripAnsi);
		const statsLine = lines.find((line) => line.includes("turns"))!;
		assert.match(statsLine, /4 turns/);
		assert.match(statsLine, /7 tools/);
		assert.match(statsLine, /2\.5k/);
	});
});

describe("renderFleetInspector: attention/error line", () => {
	it("shows a reason-specific line for each attentionReason value", () => {
		const reasons: Array<[Parameters<typeof makeEntry>[0]["attentionReason"], RegExp]> = [
			["control_notice", /control notice/],
			["watchdog_reviewing", /watchdog reviewing/],
			["watchdog_stalled", /watchdog stalled/],
			["supervisor_pending", /waiting for supervisor decision/],
		];
		for (const [attentionReason, pattern] of reasons) {
			const entry = makeEntry({ key: "a", state: "needs_attention", needsAttention: true, attentionReason });
			const lines = renderFleetInspector(entry, [], emptyTranscript(), baseOpts()).map(stripAnsi);
			assert.ok(lines.some((line) => pattern.test(line)), `missing line for ${attentionReason}`);
		}
	});

	it("shows a generic error line for a pure error state without an attentionReason", () => {
		const entry = makeEntry({ key: "a", state: "error" });
		const lines = renderFleetInspector(entry, [], emptyTranscript(), baseOpts()).map(stripAnsi);
		assert.ok(lines.some((line) => /\u26a0 error/.test(line)));
	});

	it("shows no attention line for a plain running entry", () => {
		const entry = makeEntry({ key: "a", state: "running" });
		const lines = renderFleetInspector(entry, [], emptyTranscript(), baseOpts()).map(stripAnsi);
		assert.ok(!lines.some((line) => line.includes("\u26a0")));
	});
});

describe("renderFleetInspector: children summary", () => {
	it("omits the children section when there are none", () => {
		const entry = makeEntry({ key: "a", state: "running" });
		const lines = renderFleetInspector(entry, [], emptyTranscript(), baseOpts()).map(stripAnsi);
		assert.ok(!lines.some((line) => line.includes("children:")));
	});

	it("lists up to MAX_INSPECTOR_CHILDREN_ROWS children and summarizes the rest", () => {
		const entry = makeEntry({ key: "a", state: "running" });
		const children = Array.from({ length: 8 }, (_, i) => makeEntry({ key: `c${i}`, state: "running", agent: `child-${i}` }));
		const lines = renderFleetInspector(entry, children, emptyTranscript(), baseOpts()).map(stripAnsi);
		assert.ok(lines.some((line) => line.includes("children:")));
		assert.ok(lines.some((line) => line.includes("child-0")));
		assert.ok(lines.some((line) => /\+3 weitere/.test(line)));
	});
});

describe("renderFleetInspector: transcript section", () => {
	it("marks the header with a truncation suffix only when transcript.truncated is true", () => {
		const entry = makeEntry({ key: "a", state: "running" });
		const truncatedLines = renderFleetInspector(entry, [], emptyTranscript({ truncated: true }), baseOpts()).map(stripAnsi);
		const cleanLines = renderFleetInspector(entry, [], emptyTranscript({ truncated: false }), baseOpts()).map(stripAnsi);
		assert.ok(truncatedLines.some((line) => line.includes("gekuerzt")));
		assert.ok(!cleanLines.some((line) => line.includes("gekuerzt")));
	});

	it("shows an error line instead of the event list when transcript.error is set", () => {
		const entry = makeEntry({ key: "a", state: "running" });
		const lines = renderFleetInspector(entry, [], emptyTranscript({ error: "Refusing to read symlink transcript path: /tmp/x" }), baseOpts()).map(stripAnsi);
		assert.ok(lines.some((line) => line.includes("Refusing to read symlink")));
	});

	it("renders each transcript event type distinctly", () => {
		const events: TranscriptEvent[] = [
			{ type: "user", ts: 1, text: "please fix the bug" },
			{ type: "assistant", ts: 2, text: "working on it" },
			{ type: "tool", ts: 3, toolName: "bash", argsPreview: "ls -la", toolState: "running" },
			{ type: "notice", ts: 4, text: "stray stderr output", kind: "stderr" },
		];
		const entry = makeEntry({ key: "a", state: "running" });
		const lines = renderFleetInspector(entry, [], emptyTranscript({ events }), baseOpts()).map(stripAnsi);
		assert.ok(lines.some((line) => line.includes("please fix the bug")));
		assert.ok(lines.some((line) => line.includes("working on it")));
		assert.ok(lines.some((line) => line.includes("bash") && line.includes("ls -la")));
		assert.ok(lines.some((line) => line.includes("stray stderr output")));
	});

	it("shows only the compact tool line when toolDetailsExpanded is false", () => {
		const events: TranscriptEvent[] = [{ type: "tool", ts: 1, toolName: "bash", resultText: "RESULT_TEXT", toolState: "complete", isError: false }];
		const entry = makeEntry({ key: "a", state: "running" });
		const lines = renderFleetInspector(entry, [], emptyTranscript({ events }), baseOpts({ toolDetailsExpanded: false })).map(stripAnsi);
		assert.ok(!lines.some((line) => line.includes("RESULT_TEXT")));
	});

	it("adds the result line when toolDetailsExpanded is true", () => {
		const events: TranscriptEvent[] = [{ type: "tool", ts: 1, toolName: "bash", resultText: "RESULT_TEXT", toolState: "complete", isError: false }];
		const entry = makeEntry({ key: "a", state: "running" });
		const lines = renderFleetInspector(entry, [], emptyTranscript({ events }), baseOpts({ toolDetailsExpanded: true })).map(stripAnsi);
		assert.ok(lines.some((line) => line.includes("RESULT_TEXT")));
	});

	it("shows a placeholder line when there are no transcript events and no error", () => {
		const entry = makeEntry({ key: "a", state: "running" });
		const lines = renderFleetInspector(entry, [], emptyTranscript(), baseOpts()).map(stripAnsi);
		assert.ok(lines.some((line) => line.includes("keine Ereignisse")));
	});
});

describe("renderFleetInspector: scroll window", () => {
	function manyEvents(count: number): TranscriptEvent[] {
		return Array.from({ length: count }, (_, i) => ({ type: "user" as const, ts: i, text: `msg-${i}` }));
	}

	it("shows the newest lines when scrollFromBottom is 0 (auto-follow)", () => {
		const entry = makeEntry({ key: "a", state: "running" });
		const events = manyEvents(DEFAULT_INSPECTOR_MAX_VISIBLE_LINES + 10);
		const lines = renderFleetInspector(entry, [], emptyTranscript({ events }), baseOpts({ scrollFromBottom: 0 })).map(stripAnsi);
		assert.ok(lines.some((line) => line.includes(`msg-${events.length - 1}`)));
		assert.ok(!lines.some((line) => line.includes("msg-0 ") || line.endsWith("msg-0")));
	});

	it("scrolls further back as scrollFromBottom increases", () => {
		const entry = makeEntry({ key: "a", state: "running" });
		const events = manyEvents(DEFAULT_INSPECTOR_MAX_VISIBLE_LINES + 10);
		const scrolled = renderFleetInspector(entry, [], emptyTranscript({ events }), baseOpts({ scrollFromBottom: 5 })).map(stripAnsi);
		assert.ok(!scrolled.some((line) => line.includes(`msg-${events.length - 1}`)));
	});

	it("clamps scrollFromBottom so it never scrolls past the beginning", () => {
		const entry = makeEntry({ key: "a", state: "running" });
		const events = manyEvents(DEFAULT_INSPECTOR_MAX_VISIBLE_LINES + 10);
		const overscrolled = renderFleetInspector(entry, [], emptyTranscript({ events }), baseOpts({ scrollFromBottom: 999 })).map(stripAnsi);
		assert.ok(overscrolled.some((line) => line.includes("msg-0")));
	});

	it("shows a position indicator only when content exceeds maxVisibleLines", () => {
		const entry = makeEntry({ key: "a", state: "running" });
		const short = renderFleetInspector(entry, [], emptyTranscript({ events: manyEvents(3) }), baseOpts()).map(stripAnsi);
		const long = renderFleetInspector(entry, [], emptyTranscript({ events: manyEvents(DEFAULT_INSPECTOR_MAX_VISIBLE_LINES + 5) }), baseOpts()).map(stripAnsi);
		assert.ok(!short.some((line) => /\[\d+.\d+ \/ \d+\]/.test(line)));
		assert.ok(long.some((line) => /\[\d+.\d+ \/ \d+\]/.test(line)));
	});
});

describe("renderFleetInspector: footer and width", () => {
	it("reflects toolDetailsExpanded in the footer hint text", () => {
		const entry = makeEntry({ key: "a", state: "running" });
		const collapsedFooter = renderFleetInspector(entry, [], emptyTranscript(), baseOpts({ toolDetailsExpanded: false })).map(stripAnsi).at(-1)!;
		const expandedFooter = renderFleetInspector(entry, [], emptyTranscript(), baseOpts({ toolDetailsExpanded: true })).map(stripAnsi).at(-1)!;
		assert.match(collapsedFooter, /expand tool details/);
		assert.match(expandedFooter, /collapse tool details/);
	});

	it("truncates every line to the given width", () => {
		const entry = makeEntry({ key: "a", state: "running", agent: "a-very-long-agent-name-that-will-not-fit-in-a-narrow-terminal", description: "a fairly long description that also will not fit" });
		const lines = renderFleetInspector(entry, [], emptyTranscript(), baseOpts({ width: 40 }));
		for (const line of lines) {
			assert.ok(stripAnsi(line).length <= 40, `line too long: ${JSON.stringify(line)}`);
		}
	});
});
