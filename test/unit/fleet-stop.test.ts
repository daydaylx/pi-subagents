import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestFleetStop } from "../../src/runs/background/fleet-stop.ts";
import type { FleetAgentEntry } from "../../src/runs/shared/fleet-projection.ts";

function makeEntry(overrides: Partial<FleetAgentEntry> = {}): FleetAgentEntry {
	return {
		key: "async:async-1",
		runId: "async-1",
		source: "async",
		kind: "active",
		depth: 0,
		agent: "worker",
		state: "running",
		needsAttention: false,
		canStop: true,
		asyncDir: "/tmp/async-1",
		pid: 4242,
		startedAt: 1000,
		updatedAt: 1000,
		...overrides,
	};
}

describe("requestFleetStop", () => {
	it("delivers a stop request with the entry's asyncDir/pid for a stoppable async entry", () => {
		const calls: Array<{ asyncDir: string; pid?: number; source?: string }> = [];
		const result = requestFleetStop(makeEntry(), (input) => {
			calls.push(input);
		});
		assert.equal(result.ok, true);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], { asyncDir: "/tmp/async-1", pid: 4242, source: "fleet-dock" });
	});

	it("refuses foreground entries - no terminal stop channel exists for them", () => {
		const calls: unknown[] = [];
		const result = requestFleetStop(makeEntry({ source: "foreground", asyncDir: undefined }), (input) => {
			calls.push(input);
		});
		assert.equal(result.ok, false);
		assert.equal(calls.length, 0);
	});

	it("refuses an entry that is no longer stoppable", () => {
		const calls: unknown[] = [];
		const result = requestFleetStop(makeEntry({ canStop: false, state: "stopped" }), (input) => {
			calls.push(input);
		});
		assert.equal(result.ok, false);
		assert.equal(calls.length, 0);
	});

	it("refuses an async entry missing asyncDir defensively, even if canStop is true", () => {
		const calls: unknown[] = [];
		const result = requestFleetStop(makeEntry({ asyncDir: undefined }), (input) => {
			calls.push(input);
		});
		assert.equal(result.ok, false);
		assert.equal(calls.length, 0);
	});

	it("reports failure without throwing if the underlying deliver call throws", () => {
		const result = requestFleetStop(makeEntry(), () => {
			throw new Error("disk full");
		});
		assert.equal(result.ok, false);
		assert.match(result.message, /disk full/);
	});

	it("omits pid from the delivered request when the entry has none (disk-projected runs)", () => {
		const calls: Array<{ asyncDir: string; pid?: number; source?: string }> = [];
		requestFleetStop(makeEntry({ pid: undefined }), (input) => {
			calls.push(input);
		});
		assert.equal(calls[0]?.pid, undefined);
	});
});
