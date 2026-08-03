import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decodeTimeBudgetEnv,
	encodeTimeBudgetEnv,
	resolveTimeBudget,
	shouldNudgeForTimeBudget,
	timeBudgetSoftNudge,
} from "../../src/runs/shared/time-budget.ts";

describe("time-budget module", () => {
	it("resolves a budget only when timeoutMs is set", () => {
		assert.equal(resolveTimeBudget({}), undefined);
		const now = Date.now();
		const resolved = resolveTimeBudget({ timeoutMs: 120_000 });
		assert.equal(resolved?.timeoutMs, 120_000);
		assert.ok(resolved!.deadlineAt >= now + 120_000 && resolved!.deadlineAt <= now + 120_000 + 50);
	});

	it("prefers an explicit deadlineAt over deriving one from timeoutMs", () => {
		const resolved = resolveTimeBudget({ timeoutMs: 120_000, deadlineAt: 999 });
		assert.deepEqual(resolved, { timeoutMs: 120_000, deadlineAt: 999 });
	});

	it("serializes and decodes env config", () => {
		const budget = { timeoutMs: 120_000, deadlineAt: 1_700_000_000_000 };
		assert.deepEqual(decodeTimeBudgetEnv(encodeTimeBudgetEnv(budget)), budget);
	});

	it("decodes missing or malformed env values as undefined instead of throwing", () => {
		assert.equal(decodeTimeBudgetEnv(undefined), undefined);
		assert.equal(decodeTimeBudgetEnv(""), undefined);
		assert.equal(decodeTimeBudgetEnv("not json"), undefined);
		assert.equal(decodeTimeBudgetEnv(JSON.stringify({ timeoutMs: 1 })), undefined);
	});

	it("nudges only once the remaining time drops to the soft ratio", () => {
		const budget = { timeoutMs: 100_000, deadlineAt: 100_000 };
		// 30s elapsed of 100s budget -> 70s remaining (70%), above the 20% soft threshold.
		assert.equal(shouldNudgeForTimeBudget(30_000, budget), false);
		// 85s elapsed -> 15s remaining (15%), below the 20% soft threshold.
		assert.equal(shouldNudgeForTimeBudget(85_000, budget), true);
		// Already past the deadline: no nudge, the parent-side hard timeout is what matters here.
		assert.equal(shouldNudgeForTimeBudget(100_001, budget), false);
	});

	it("formats a user-facing nudge with the remaining and total seconds", () => {
		const budget = { timeoutMs: 120_000, deadlineAt: 100_000 + 15_000 };
		const message = timeBudgetSoftNudge(100_000, budget);
		assert.match(message, /about 15s remaining of 120s total/);
		assert.match(message, /do not start a new long-running command/i);
	});
});
