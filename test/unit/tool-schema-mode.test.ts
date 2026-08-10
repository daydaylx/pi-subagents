import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
	HARNESS_MANAGEMENT_ACTIONS,
	HarnessSubagentParams,
	resolveToolSchemaMode,
	subagentToolParameters,
	SubagentParams,
} from "../../src/extension/schemas.ts";
import { buildDoctorReport } from "../../src/extension/doctor.ts";
import type { ExtensionConfig, SubagentState } from "../../src/shared/types.ts";

/**
 * The runtime validates model-supplied arguments with exactly this helper
 * before the executor runs, so the reduced surface is asserted through it
 * rather than through a hand-written schema walk.
 */
function validate(parameters: unknown, args: Record<string, unknown>): unknown {
	return validateToolArguments(
		{ name: "subagent", parameters } as Parameters<typeof validateToolArguments>[0],
		{ name: "subagent", arguments: args } as Parameters<typeof validateToolArguments>[1],
	);
}

function rejects(parameters: unknown, args: Record<string, unknown>): boolean {
	try {
		validate(parameters, args);
		return false;
	} catch {
		return true;
	}
}

describe("toolSchemaMode", () => {
	it("defaults to the full parameter surface", () => {
		assert.equal(resolveToolSchemaMode({}), "full");
		assert.equal(subagentToolParameters({}), SubagentParams);
	});

	it("selects the reduced surface only for the explicit harness mode", () => {
		assert.equal(resolveToolSchemaMode({ toolSchemaMode: "harness" }), "harness");
		assert.equal(subagentToolParameters({ toolSchemaMode: "harness" }), HarnessSubagentParams);
		assert.equal(subagentToolParameters({ toolSchemaMode: "full" }), SubagentParams);
	});

	it("is independent of the visible tool description mode", () => {
		// toolDescriptionMode: "custom" used to imply the reduced schema. A host
		// that only overrides the description text must keep the full surface.
		const descriptionOnly = { toolDescriptionMode: "custom" } as ExtensionConfig;
		assert.equal(resolveToolSchemaMode(descriptionOnly), "full");
		assert.equal(subagentToolParameters(descriptionOnly), SubagentParams);
	});

	it("warns and keeps the full surface for an unknown mode", () => {
		const warnings: string[] = [];
		const mode = resolveToolSchemaMode(
			{ toolSchemaMode: "reduced" } as unknown as ExtensionConfig,
			(message) => warnings.push(message),
		);
		assert.equal(mode, "full");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /Ignoring invalid toolSchemaMode "reduced"/);
	});
});

describe("reduced harness parameter surface", () => {
	it("accepts single execution", () => {
		const accepted = validate(HarnessSubagentParams, {
			agent: "investigator",
			task: "locate the change surface",
		}) as { agent: string };
		assert.equal(accepted.agent, "investigator");
	});

	it("accepts exactly the four management actions", () => {
		assert.deepEqual([...HARNESS_MANAGEMENT_ACTIONS], ["list", "status", "stop", "interrupt"]);
		for (const action of HARNESS_MANAGEMENT_ACTIONS) {
			assert.doesNotThrow(
				() => validate(HarnessSubagentParams, { action, id: "run-1" }),
				`action '${action}' must validate`,
			);
		}
	});

	it("rejects every management action outside the closed enum", () => {
		for (const action of [
			"get",
			"create",
			"update",
			"delete",
			"eject",
			"disable",
			"enable",
			"reset",
			"models",
			"resume",
			"steer",
			"append-step",
			"schedule",
			"schedule-list",
			"schedule-status",
			"schedule-cancel",
			"doctor",
			"watch",
			"single",
			"parallel",
		]) {
			assert.ok(
				rejects(HarnessSubagentParams, { action }),
				`action '${action}' must be rejected by the reduced surface`,
			);
		}
	});

	it("rejects chain, parallel, worktree and sharing parameters", () => {
		for (const args of [
			{ chain: [{ agent: "investigator", task: "step" }] },
			{ tasks: [{ agent: "investigator", task: "one" }] },
			{ chainName: "review" },
			{ chainDir: "/tmp/chain" },
			{ agent: "investigator", task: "t", worktree: true },
			{ agent: "investigator", task: "t", share: true },
			{ agent: "investigator", task: "t", agentScope: "project" },
			{ agent: "investigator", task: "t", sessionDir: "/tmp/sessions" },
			{ agent: "investigator", task: "t", acceptance: "verified" },
			{ action: "status", view: "fleet" },
			{ action: "stop", message: "steer me" },
		]) {
			assert.ok(
				rejects(HarnessSubagentParams, args),
				`${JSON.stringify(args)} must be rejected by the reduced surface`,
			);
		}
	});

	it("still accepts those parameters on the full surface", () => {
		assert.doesNotThrow(() =>
			validate(SubagentParams, { chain: [{ agent: "investigator", task: "step" }] }),
		);
		assert.doesNotThrow(() => validate(SubagentParams, { action: "create", agent: "new-agent" }));
	});

	it("keeps the parameters the harness actually uses", () => {
		assert.doesNotThrow(() =>
			validate(HarnessSubagentParams, {
				agent: "verifier",
				task: "verify the diff",
				context: "fresh",
				async: false,
				timeoutMs: 1_200_000,
				turnBudget: { maxTurns: 40, graceTurns: 2 },
				toolBudget: { hard: 200 },
				cwd: "/workspace",
				artifacts: true,
				clarify: false,
				output: false,
				outputMode: "inline",
				skill: false,
				model: "anthropic/claude-sonnet-5",
			}),
		);
	});
});

describe("doctor tool surface section", () => {
	const state = { currentSessionId: null } as unknown as SubagentState;
	const deps = {
		isAsyncAvailable: () => true,
		discoverAgentsAll: () => ({ builtin: [], package: [], user: [], project: [], chains: [] }),
		discoverAvailableSkills: () => [],
		diagnoseIntercomBridge: () => ({
			active: false,
			mode: "off",
			extensionDir: "/tmp",
			supervisorChannelAvailable: false,
		}),
	} as unknown as Parameters<typeof buildDoctorReport>[0]["deps"];

	function report(config: ExtensionConfig): string {
		return buildDoctorReport({ cwd: "/workspace", config, state, deps });
	}

	it("names the reduced surface and its accepted actions", () => {
		const lines = report({ toolDescriptionMode: "custom", toolSchemaMode: "harness" });
		assert.match(lines, /- tool description mode: custom/);
		assert.match(lines, /- tool schema mode: harness/);
		assert.match(lines, /- accepted actions: list, status, stop, interrupt/);
	});

	it("reports the full surface when only the description is customised", () => {
		const lines = report({ toolDescriptionMode: "custom" });
		assert.match(lines, /- tool schema mode: full/);
		assert.match(lines, /- accepted actions: full management surface/);
	});
});
