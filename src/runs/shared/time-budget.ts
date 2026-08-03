export const TIME_BUDGET_ENV = "PI_SUBAGENT_TIME_BUDGET";

export interface TimeBudget {
	timeoutMs: number;
	deadlineAt: number;
}

/** Nudge once the remaining time drops to this fraction of the total budget. */
const SOFT_REMAINING_RATIO = 0.2;

export function resolveTimeBudget(input: { timeoutMs?: number; deadlineAt?: number }): TimeBudget | undefined {
	if (input.timeoutMs === undefined) return undefined;
	return { timeoutMs: input.timeoutMs, deadlineAt: input.deadlineAt ?? Date.now() + input.timeoutMs };
}

export function shouldNudgeForTimeBudget(now: number, budget: TimeBudget): boolean {
	const remainingMs = budget.deadlineAt - now;
	return remainingMs > 0 && remainingMs <= budget.timeoutMs * SOFT_REMAINING_RATIO;
}

export function timeBudgetSoftNudge(now: number, budget: TimeBudget): string {
	const remainingSeconds = Math.max(0, Math.round((budget.deadlineAt - now) / 1000));
	const totalSeconds = Math.round(budget.timeoutMs / 1000);
	return `Time budget soft limit reached: about ${remainingSeconds}s remaining of ${totalSeconds}s total. Do not start a new long-running command (e.g. a full test or verify suite) now — it will likely be killed mid-run before it finishes. Finalize from what you already have, or run only a fast, narrowly-scoped check.`;
}

export function encodeTimeBudgetEnv(budget: TimeBudget | undefined): string | undefined {
	return budget ? JSON.stringify(budget) : undefined;
}

export function decodeTimeBudgetEnv(value: string | undefined): TimeBudget | undefined {
	if (!value?.trim()) return undefined;
	let parsed: Partial<TimeBudget>;
	try {
		parsed = JSON.parse(value) as Partial<TimeBudget>;
	} catch {
		return undefined;
	}
	if (typeof parsed.timeoutMs !== "number" || typeof parsed.deadlineAt !== "number") return undefined;
	return { timeoutMs: parsed.timeoutMs, deadlineAt: parsed.deadlineAt };
}
