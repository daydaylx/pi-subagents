import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FleetAgentEntry, FleetAgentState } from "../../src/runs/shared/fleet-projection.ts";
import { compactActivityDetail, compactPath, MAX_DOCK_ROWS, nameColumnWidth, renderFleetDock, sortFleetEntries } from "../../src/tui/fleet-dock.ts";

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
		// PHASE-08: 1 Kopfzeile + MAX_DOCK_ROWS Eintraege + 1 "+N weitere"-Zeile.
		assert.equal(lines.length, MAX_DOCK_ROWS + 2);
		assert.match(stripAnsi(lines.at(-1)!), /\+3 weitere/);
	});

	it("includes activityDetail and token stats in the entry line", () => {
		const entries = [makeEntry({ key: "a", state: "running", agent: "alpha", activityDetail: "tool: bash", tokens: 1500, startedAt: 0 })];
		const lines = renderFleetDock(entries, undefined, { width: 200, theme: makeTheme(), now: 5000 });
		const line = stripAnsi(lines.find((candidate) => candidate.includes("alpha"))!);
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

	it("stays within bounds and keeps the agent name readable at 80/120/160 columns (PHASE-07)", () => {
		const entries = [
			makeEntry({ key: "a", state: "needs_attention", agent: "alpha", needsAttention: true, activityDetail: "watchdog: stalled after long-running tool call" }),
			makeEntry({ key: "b", state: "running", agent: "beta", activityDetail: "tool: bash - running a fairly long shell command" }),
		];
		for (const width of [80, 120, 160]) {
			const lines = renderFleetDock(entries, undefined, { width, theme: makeTheme(), now: 0 });
			assert.ok(lines.length > 0, `no output at width ${width}`);
			for (const line of lines) {
				assert.ok(stripAnsi(line).length <= width, `line too long at width ${width}: ${JSON.stringify(line)}`);
			}
			const rendered = lines.map(stripAnsi).join("\n");
			assert.match(rendered, /alpha/, `agent name truncated away at width ${width}`);
			assert.match(rendered, /beta/, `agent name truncated away at width ${width}`);
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

describe("renderFleetDock: Aurora-Politur (PHASE-08)", () => {
	it("renders a header line with active and needs-attention counts", () => {
		const entries = [
			makeEntry({ key: "a", state: "running", agent: "alpha" }),
			makeEntry({ key: "b", state: "needs_attention", agent: "beta", needsAttention: true, updatedAt: -1 }),
			makeEntry({ key: "c", state: "completed", agent: "gamma", updatedAt: -2 }),
		];
		const header = stripAnsi(renderFleetDock(entries, undefined, { width: 120, theme: makeTheme(), now: 0 })[0]!);
		assert.match(header, /AGENTS/);
		// completed zaehlt nicht als "active"
		assert.match(header, /2 active/);
		assert.match(header, /1 needs attention/);
	});

	it("omits the needs-attention counter when nothing needs attention", () => {
		const entries = [makeEntry({ key: "a", state: "running", agent: "alpha" })];
		const header = stripAnsi(renderFleetDock(entries, undefined, { width: 120, theme: makeTheme(), now: 0 })[0]!);
		assert.doesNotMatch(header, /needs attention/);
	});

	it("shows the down-arrow affordance only while the dock has no keyboard focus", () => {
		const entries = [makeEntry({ key: "a", state: "running", agent: "alpha" })];
		const idle = stripAnsi(renderFleetDock(entries, "a", { width: 120, theme: makeTheme(), now: 0 })[0]!);
		const focused = stripAnsi(renderFleetDock(entries, "a", { width: 120, theme: makeTheme(), now: 0, active: true })[0]!);
		assert.match(idle, /\u2193 select/);
		assert.doesNotMatch(focused, /\u2193 select/);
	});

	it("advertises the super+down jump only while the dock has no keyboard focus (PHASE-09)", () => {
		const entries = [makeEntry({ key: "a", state: "running", agent: "alpha" })];
		const idle = stripAnsi(renderFleetDock(entries, "a", { width: 120, theme: makeTheme(), now: 0 })[0]!);
		const focused = stripAnsi(renderFleetDock(entries, "a", { width: 120, theme: makeTheme(), now: 0, active: true })[0]!);
		assert.match(idle, /Super\+↓ jump/);
		assert.doesNotMatch(focused, /Super\+↓ jump/);
	});

	it("renders the shortcut hint line only while the dock has keyboard focus", () => {
		const entries = [makeEntry({ key: "a", state: "running", agent: "alpha" })];
		const idle = renderFleetDock(entries, "a", { width: 120, theme: makeTheme(), now: 0 }).map(stripAnsi).join("\n");
		const focused = renderFleetDock(entries, "a", { width: 120, theme: makeTheme(), now: 0, active: true }).map(stripAnsi).join("\n");
		assert.doesNotMatch(idle, /enter inspect/);
		assert.match(focused, /\u2191\u2193 select/);
		assert.match(focused, /enter inspect/);
		assert.match(focused, /esc back/);
	});

	it("advertises 's stop' and 'd dismiss' only when they apply to the selected entry", () => {
		const entries = [
			makeEntry({ key: "a", state: "running", agent: "alpha", source: "async", canStop: true, asyncDir: "/tmp/a" }),
			makeEntry({ key: "b", state: "completed", agent: "beta", source: "async", canStop: false, updatedAt: -1 }),
		];
		const onStoppable = renderFleetDock(entries, "a", { width: 120, theme: makeTheme(), now: 0, active: true }).map(stripAnsi).join("\n");
		const onTerminal = renderFleetDock(entries, "b", { width: 120, theme: makeTheme(), now: 0, active: true }).map(stripAnsi).join("\n");
		assert.match(onStoppable, /s stop/);
		assert.doesNotMatch(onStoppable, /d dismiss/);
		assert.doesNotMatch(onTerminal, /s stop/);
		assert.match(onTerminal, /d dismiss/);
	});

	it("gives every state its own glyph so status is never conveyed by color alone", () => {
		const states: FleetAgentState[] = ["needs_attention", "running", "paused", "completed", "error", "stopped"];
		const glyphs = states.map((state) => {
			const lines = renderFleetDock([makeEntry({ key: state, state })], undefined, { width: 120, theme: makeTheme(), now: 0 });
			return stripAnsi(lines[1]!).trimStart()[0]!;
		});
		assert.equal(new Set(glyphs).size, states.length, `glyphs are not unique: ${glyphs.join(" ")}`);
	});

	it("spells out non-running states as text without duplicating the projection fallback", () => {
		const stoppedLines = renderFleetDock([makeEntry({ key: "a", state: "stopped", agent: "alpha", activityDetail: "stopped" })], undefined, {
			width: 120,
			theme: makeTheme(),
			now: 0,
		});
		const stopped = stripAnsi(stoppedLines[1]!);
		assert.match(stopped, /stopped/);
		assert.equal(stopped.match(/stopped/g)!.length, 1);

		const pausedLines = renderFleetDock([makeEntry({ key: "b", state: "paused", agent: "beta", activityDetail: "tool: bash" })], undefined, {
			width: 120,
			theme: makeTheme(),
			now: 0,
		});
		const paused = stripAnsi(pausedLines[1]!);
		assert.match(paused, /paused/);
		assert.match(paused, /tool: bash/);
	});

	it("aligns the status columns on a fixed name column so they do not jump between entries", () => {
		const entries = [
			makeEntry({ key: "a", state: "running", agent: "ab", activityDetail: "tool: bash" }),
			makeEntry({ key: "b", state: "running", agent: "a-much-longer-name", activityDetail: "tool: bash", updatedAt: -1 }),
		];
		const rows = renderFleetDock(entries, undefined, { width: 120, theme: makeTheme(), now: 0 }).slice(1, 3).map(stripAnsi);
		const columns = rows.map((line) => line.indexOf("tool: bash"));
		assert.ok(columns[0]! > 0, "activity column not found");
		assert.equal(columns[0], columns[1]);
	});

	it("keeps runtime and token stats intact at 80 columns and shortens the activity instead", () => {
		const entries = [
			makeEntry({
				key: "a",
				state: "running",
				agent: "alpha",
				activityDetail: "tool: edit (/home/user/project/src/deeply/nested/module/file.ts)",
				tokens: 18200,
				startedAt: 0,
			}),
		];
		const line = stripAnsi(renderFleetDock(entries, undefined, { width: 80, theme: makeTheme(), now: 42000 })[1]!);
		assert.ok(line.length <= 80, `line too long: ${JSON.stringify(line)}`);
		assert.match(line, /42\.0s/);
		assert.match(line, /18k/);
	});

	it("shortens embedded paths to their last segments instead of cutting them off", () => {
		assert.equal(compactPath("/home/user/project/src/plan-mode/index.ts"), "\u2026/plan-mode/index.ts");
		assert.equal(compactPath("index.ts"), "index.ts");
		assert.equal(compactActivityDetail("tool: edit (/a/b/c/d.ts)"), "tool: edit (\u2026/c/d.ts)");
		assert.equal(compactActivityDetail("tool: bash"), "tool: bash");
	});

	it("survives a state value outside the six known ones instead of throwing", () => {
		const entries = [makeEntry({ key: "a", state: "zombie" as FleetAgentState, agent: "alpha" })];
		const lines = renderFleetDock(entries, undefined, { width: 120, theme: makeTheme(), now: 0 });
		assert.equal(lines.length, 2);
		assert.match(stripAnsi(lines[1]!), /alpha/);
	});

	it("does not emit a doubled separator for an empty activity detail", () => {
		const entries = [makeEntry({ key: "a", state: "running", agent: "alpha", activityDetail: "" })];
		const line = stripAnsi(renderFleetDock(entries, undefined, { width: 120, theme: makeTheme(), now: 0 })[1]!);
		assert.doesNotMatch(line, /·\s+·/);
	});

	it("still shortens embedded paths when the budget is too small for a fitted detail", () => {
		const entries = [
			makeEntry({ key: "a", state: "running", agent: "alpha", activityDetail: "tool: edit (/home/user/project/src/plan-mode/index.ts)" }),
		];
		const line = stripAnsi(renderFleetDock(entries, undefined, { width: 40, theme: makeTheme(), now: 0 })[1]!);
		assert.ok(line.length <= 40, `line too long: ${JSON.stringify(line)}`);
		assert.doesNotMatch(line, /home\/user\/project/, "raw path leaked into a narrow line");
	});

	it("exposes a stable name column width for the supported terminal widths", () => {
		assert.equal(nameColumnWidth(80), 16);
		assert.equal(nameColumnWidth(120), 24);
		assert.equal(nameColumnWidth(160), 24);
	});

	it("keeps every line within bounds at 80/120/160 columns including header, hint and detail lines", () => {
		const entries = [
			makeEntry({
				key: "a",
				state: "needs_attention",
				agent: "alpha",
				needsAttention: true,
				activityDetail: "watchdog: stalled after a long running tool call",
				source: "async",
				canStop: true,
				asyncDir: "/tmp/a",
			}),
			makeEntry({
				key: "b",
				state: "completed",
				agent: "a-really-long-agent-name-here",
				activityDetail: "tool: edit (/home/user/project/src/very/deep/file.ts)",
				transcriptPath: "/home/user/.pi/agent/async/run-1/transcript.jsonl",
				updatedAt: -1,
			}),
		];
		for (const width of [80, 120, 160]) {
			const lines = renderFleetDock(entries, "a", { width, theme: makeTheme(), now: 60000, active: true, expandedKey: "b" });
			for (const line of lines) {
				assert.ok(stripAnsi(line).length <= width, `line too long at width ${width}: ${JSON.stringify(stripAnsi(line))}`);
			}
			const rendered = lines.map(stripAnsi).join("\n");
			assert.match(rendered, /AGENTS/, `header missing at width ${width}`);
			assert.match(rendered, /alpha/, `agent name truncated away at width ${width}`);
		}
	});
});


describe("renderFleetDock: Uebersichtlichkeit (PHASE-09)", () => {
	// Nutzerfeedback nach Live-Einsatz: Laufzeit/Tokens folgten direkt der
	// Aktivitaetsbeschreibung und standen dadurch je nach deren Laenge an einer
	// anderen Spaltenposition - senkrechtes Scannen war nicht moeglich.
	it("keeps the stats column at the same offset regardless of activity text length", () => {
		const entries = [
			makeEntry({ key: "a", state: "running", agent: "alpha", activityDetail: "tool: bash", startedAt: 0 }),
			makeEntry({ key: "b", state: "running", agent: "beta", activityDetail: "tool: edit (extensions/plan-mode/index.ts)", startedAt: 0, updatedAt: -1 }),
		];
		const lines = renderFleetDock(entries, undefined, { width: 120, theme: makeTheme(), now: 42_000 }).map(stripAnsi);
		const lineA = lines.find((line) => line.includes("alpha"))!;
		const lineB = lines.find((line) => line.includes("beta"))!;
		assert.equal(lineA.indexOf("42.0s"), lineB.indexOf("42.0s"), "duration must start at the same column on both lines");
	});

	it("keeps the stats column at the same offset for a deeper (indented) entry too", () => {
		const entries = [
			makeEntry({ key: "a", state: "running", agent: "worker", depth: 0, activityDetail: "tool: edit (extensions/plan-mode/index.ts)", startedAt: 0 }),
			makeEntry({ key: "b", state: "running", agent: "scout", depth: 1, parentKey: "a", activityDetail: "tool: grep", startedAt: 0, updatedAt: -1 }),
		];
		const lines = renderFleetDock(entries, undefined, { width: 120, theme: makeTheme(), now: 42_000 }).map(stripAnsi);
		const parentLine = lines.find((line) => line.includes("worker"))!;
		const childLine = lines.find((line) => line.includes("scout"))!;
		assert.equal(parentLine.indexOf("42.0s"), childLine.indexOf("42.0s"), "indentation must not shift the stats column");
	});

	it("indents a deeper entry's glyph relative to a top-level entry (visible parent/child hierarchy)", () => {
		const entries = [
			makeEntry({ key: "a", state: "running", agent: "worker", depth: 0 }),
			makeEntry({ key: "b", state: "running", agent: "scout", depth: 1, parentKey: "a", updatedAt: -1 }),
		];
		const lines = renderFleetDock(entries, undefined, { width: 120, theme: makeTheme(), now: 0 }).map(stripAnsi);
		const parentLine = lines.find((line) => line.includes("worker"))!;
		const childLine = lines.find((line) => line.includes("scout"))!;
		assert.ok(childLine.indexOf("●") > parentLine.indexOf("●"), "a depth-1 entry's glyph must sit further right than a depth-0 entry's");
	});

	it("never overflows at narrow widths even with a deeply nested (depth 3) entry", () => {
		const entries = [makeEntry({ key: "a", state: "running", agent: "deep-child", depth: 3, activityDetail: "tool: edit (some/nested/path/file.ts)" })];
		for (const width of [45, 60, 80]) {
			const lines = renderFleetDock(entries, undefined, { width, theme: makeTheme(), now: 0 });
			for (const line of lines) {
				assert.ok(stripAnsi(line).length <= width, `line too long at width ${width}: ${JSON.stringify(stripAnsi(line))}`);
			}
		}
	});
});
