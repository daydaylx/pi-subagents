import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FleetAgentEntry, FleetAgentState } from "../../src/runs/shared/fleet-projection.ts";
import { MAX_DOCK_ROWS, renderFleetDock, sortFleetEntries } from "../../src/tui/fleet-dock.ts";

function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeTheme() {
	return {
		fg: (_name: string, text: string) => text,
		bg: (_name: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Parameters<typeof renderFleetDock>[2]["theme"];
}

function makeEntry(overrides: Partial<FleetAgentEntry> & { key: string; state: FleetAgentState }): FleetAgentEntry {
	return {
		key: overrides.key,
		runId: overrides.runId ?? overrides.key,
		source: overrides.source ?? "foreground",
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

describe("sortFleetEntries", () => {
	it("orders needs_attention strictly before running before paused before terminal states (PHASE-06)", () => {
		// needs_attention has its own rank ahead of running (not just a same-rank,
		// updatedAt-broken tie) so an attention entry can never age out of the
		// visible MAX_DOCK_ROWS window before a plain running entry does.
		const entries = [
			makeEntry({ key: "a", state: "completed", updatedAt: 100 }),
			makeEntry({ key: "b", state: "needs_attention", updatedAt: 1 }),
			makeEntry({ key: "c", state: "paused", updatedAt: 50 }),
			makeEntry({ key: "d", state: "running", updatedAt: 2 }),
		];
		const sorted = sortFleetEntries(entries).map((e) => e.key);
		assert.deepEqual(sorted, ["b", "d", "c", "a"]);
	});

	it("breaks ties within the same rank by updatedAt descending", () => {
		const entries = [
			makeEntry({ key: "old", state: "running", updatedAt: 10 }),
			makeEntry({ key: "new", state: "running", updatedAt: 20 }),
		];
		const sorted = sortFleetEntries(entries).map((e) => e.key);
		assert.deepEqual(sorted, ["new", "old"]);
	});

	it("does not mutate the input array", () => {
		const entries = [makeEntry({ key: "a", state: "completed", updatedAt: 1 }), makeEntry({ key: "b", state: "running", updatedAt: 2 })];
		const copy = [...entries];
		sortFleetEntries(entries);
		assert.deepEqual(entries, copy);
	});
});

describe("renderFleetDock", () => {
	it("shows a placeholder line when there are no entries", () => {
		const lines = renderFleetDock([], undefined, { width: 60, theme: makeTheme() });
		assert.equal(lines.length, 1);
		assert.match(stripAnsi(lines[0]!), /keine aktiven Subagenten/);
	});

	it("marks the selected entry with a distinct prefix", () => {
		const entries = [makeEntry({ key: "a", state: "running", agent: "alpha" }), makeEntry({ key: "b", state: "running", agent: "beta", updatedAt: -1 })];
		const lines = renderFleetDock(entries, "b", { width: 60, theme: makeTheme(), now: 0 });
		const selectedLine = lines.find((line) => line.includes("beta"))!;
		const unselectedLine = lines.find((line) => line.includes("alpha"))!;
		assert.match(selectedLine, /›/);
		assert.doesNotMatch(unselectedLine, /›/);
	});

	it("caps visible rows and reports the remainder as a hint", () => {
		const entries = Array.from({ length: MAX_DOCK_ROWS + 3 }, (_, i) => makeEntry({ key: `r${i}`, state: "running", agent: `agent-${i}`, updatedAt: i }));
		const lines = renderFleetDock(entries, undefined, { width: 80, theme: makeTheme(), now: 0 });
		assert.equal(lines.length, MAX_DOCK_ROWS + 1);
		assert.match(stripAnsi(lines.at(-1)!), /\+3 weitere/);
	});

	it("includes activityDetail and token stats in the entry line", () => {
		const entries = [makeEntry({ key: "a", state: "running", agent: "alpha", activityDetail: "tool: bash", tokens: 1500, startedAt: 0 })];
		const lines = renderFleetDock(entries, undefined, { width: 200, theme: makeTheme(), now: 5000 });
		const line = stripAnsi(lines[0]!);
		assert.match(line, /tool: bash/);
		assert.match(line, /1\.5k/);
	});

	it("renders extra detail lines only for the expanded key", () => {
		const entries = [
			makeEntry({ key: "a", state: "running", agent: "alpha", transcriptPath: "/tmp/a.jsonl" }),
			makeEntry({ key: "b", state: "running", agent: "beta", transcriptPath: "/tmp/b.jsonl", updatedAt: -1 }),
		];
		const lines = renderFleetDock(entries, undefined, { width: 200, theme: makeTheme(), expandedKey: "a", now: 0 });
		const transcriptLines = lines.filter((line) => line.includes("transcript:"));
		assert.equal(transcriptLines.length, 1);
		assert.match(transcriptLines[0]!, /a\.jsonl/);
	});

	it("marks stale transcript paths in the expanded detail", () => {
		const entries = [makeEntry({ key: "a", state: "running", agent: "alpha", transcriptPath: "/tmp/a.jsonl", transcriptPathMaybeStale: true })];
		const lines = renderFleetDock(entries, undefined, { width: 200, theme: makeTheme(), expandedKey: "a", now: 0 });
		const transcriptLine = lines.find((line) => line.includes("transcript:"))!;
		assert.match(transcriptLine, /moeglicherweise veraltet/);
	});

	it("truncates lines to the given width", () => {
		const entries = [makeEntry({ key: "a", state: "running", agent: "a-very-long-agent-name-that-should-be-truncated", activityDetail: "a very long activity detail that will not fit" })];
		const lines = renderFleetDock(entries, undefined, { width: 20, theme: makeTheme(), now: 0 });
		for (const line of lines) {
			assert.ok(stripAnsi(line).length <= 20, `line too long: ${JSON.stringify(line)}`);
		}
	});

	it("renders the activity line in warning color for a needsAttention entry, dim otherwise (PHASE-06)", () => {
		const taggingTheme = {
			fg: (name: string, text: string) => `[${name}]${text}[/${name}]`,
			bg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Parameters<typeof renderFleetDock>[2]["theme"];
		const entries = [
			makeEntry({ key: "a", state: "needs_attention", agent: "alpha", activityDetail: "watchdog: stalled", needsAttention: true }),
			makeEntry({ key: "b", state: "running", agent: "beta", activityDetail: "tool: bash", updatedAt: -1 }),
		];
		const lines = renderFleetDock(entries, undefined, { width: 200, theme: taggingTheme, now: 0 });
		const attentionLine = lines.find((line) => line.includes("alpha"))!;
		const runningLine = lines.find((line) => line.includes("beta"))!;
		assert.match(attentionLine, /\[warning\]watchdog: stalled\[\/warning\]/);
		assert.match(runningLine, /\[dim\]tool: bash\[\/dim\]/);
	});

	it("renders a stop confirmation line only under the armed entry (PHASE-06)", () => {
		const entries = [
			makeEntry({ key: "a", state: "running", agent: "alpha" }),
			makeEntry({ key: "b", state: "running", agent: "beta", updatedAt: -1 }),
		];
		const lines = renderFleetDock(entries, undefined, { width: 200, theme: makeTheme(), now: 0, stopArmedKey: "a" });
		const alphaIdx = lines.findIndex((line) => line.includes("alpha"));
		assert.match(stripAnsi(lines[alphaIdx + 1]!), /Stop bestaetigen/);
		const betaIdx = lines.findIndex((line) => line.includes("beta"));
		const afterBeta = lines[betaIdx + 1];
		assert.ok(afterBeta === undefined || !stripAnsi(afterBeta).includes("Stop bestaetigen"));
	});
});
