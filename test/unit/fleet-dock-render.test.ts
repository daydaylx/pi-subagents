import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FleetAgentEntry } from "../../src/runs/shared/fleet-projection.ts";
import { renderFleetDock } from "../../src/tui/fleet-dock.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as Parameters<typeof renderFleetDock>[1]["theme"];

function entry(key: string, state: FleetAgentEntry["state"], depth = 0): FleetAgentEntry {
	return { key, runId: key, source: "foreground", kind: "active", depth, agent: key, state, needsAttention: state === "needs_attention", startedAt: 0, updatedAt: 0 };
}

describe("Fleet Status Dock", () => {
	it("renders a compact read-only hierarchy and prioritizes attention", () => {
		const lines = renderFleetDock([entry("worker", "running"), entry("planner", "needs_attention"), entry("child", "paused", 1)], { width: 80, theme, now: 1000 });
		assert.match(lines[0]!, /AGENTS.*needs attention/);
		assert.match(lines[1]!, /planner/);
		assert.match(lines[2]!, /worker/);
		assert.match(lines[3]!, /child/);
		assert.doesNotMatch(lines.join("\n"), /select|inspect|Super\+↓|stop|dismiss/);
	});
});
