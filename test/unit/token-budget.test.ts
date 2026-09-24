import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	TOOL_BUDGET_ENV,
	decodeToolBudgetEnv,
	encodeToolBudgetEnv,
	tokensFromUsage,
	validateToolBudgetConfig,
} from "../../src/runs/shared/tool-budget.ts";
import registerSubagentPromptRuntime from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { buildTemporaryAgentConfig, resolveEffectivePolicy, TEMPORARY_AGENT_DEFAULTS } from "../../src/agents/temporary-spec.ts";

const original = process.env[TOOL_BUDGET_ENV];
afterEach(() => {
	if (original === undefined) delete process.env[TOOL_BUDGET_ENV];
	else process.env[TOOL_BUDGET_ENV] = original;
});

type Handler = (payload: any) => unknown;

function register(budget: unknown) {
	const handlers = new Map<string, Handler>();
	const sent: string[] = [];
	process.env[TOOL_BUDGET_ENV] = JSON.stringify(budget);
	registerSubagentPromptRuntime({
		on(event: string, handler: Handler) {
			if (!handlers.has(event)) handlers.set(event, handler);
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
	} as never);
	return { handlers, sent };
}

const assistant = (input: number, output: number) => ({ message: { role: "assistant", usage: { input, output } } });

describe("token budget config", () => {
	it("survives validation and the env round trip", () => {
		const { budget, error } = validateToolBudgetConfig({ hard: 5, block: "*", tokens: 1000 });
		assert.equal(error, undefined);
		assert.equal(budget?.tokens, 1000);
		assert.equal(decodeToolBudgetEnv(encodeToolBudgetEnv(budget))?.tokens, 1000);
	});
	it("rejects invalid caps", () => {
		for (const tokens of [0, -5, 1.5, "10"]) {
			assert.ok(validateToolBudgetConfig({ hard: 5, tokens }).error, String(tokens));
		}
	});
	it("counts input plus output only", () => {
		assert.equal(tokensFromUsage({ input: 10, output: 5 }), 15);
		assert.equal(tokensFromUsage(undefined), 0);
	});
});

describe("token budget enforcement in the child", () => {
	it("blocks every tool once the cap is reached, with a clear reason, and nudges once", () => {
		const { handlers, sent } = register({ hard: 100, block: "*", tokens: 1000 });
		const toolCall = handlers.get("tool_call")!;
		const messageEnd = handlers.get("message_end")!;
		assert.equal(toolCall({ toolName: "read" }), undefined);
		messageEnd(assistant(400, 100));
		assert.equal(toolCall({ toolName: "grep" }), undefined, "below the cap tools still work");
		messageEnd(assistant(400, 100));
		assert.equal(sent.length, 1);
		assert.match(sent[0] ?? "", /Token budget reached \(1000\/1000/);
		for (const tool of ["read", "grep", "bash", "anything"]) {
			const result = toolCall({ toolName: tool }) as { block: boolean; reason: string };
			assert.equal(result.block, true, tool);
			assert.match(result.reason, /Token budget reached \(1000\/1000 tokens\)/);
		}
		messageEnd(assistant(1, 1));
		assert.equal(sent.length, 1, "nudge is sent once");
	});

	it("ignores non-assistant messages and does nothing without a token cap", () => {
		const { handlers } = register({ hard: 100, block: "*", tokens: 10 });
		handlers.get("message_end")!({ message: { role: "user", usage: { input: 999, output: 999 } } });
		assert.equal(handlers.get("tool_call")!({ toolName: "read" }), undefined);
		const none = register({ hard: 100, block: "*" });
		assert.equal(none.handlers.get("message_end"), undefined);
	});
});

describe("temporary agent token budget wiring", () => {
	it("has a sane default cap", () => {
		assert.ok(TEMPORARY_AGENT_DEFAULTS.perAgentTokenBudget >= 100_000);
		const spec = { objective: "x", profile: "analyse", delegationReason: "r" } as const;
		assert.ok(buildTemporaryAgentConfig("temp-1", spec, resolveEffectivePolicy(spec)));
	});
});
