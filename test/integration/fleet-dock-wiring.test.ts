/**
 * Integrationstests fuer die Fleet-Dock-Verdrahtung in src/extension/index.ts
 * (PHASE-04). Folgt dem execFileSync/eval-Skript-Muster aus
 * test/unit/index-child-registration.test.ts: jedes Testszenario laeuft in
 * einem frischen Node-Prozess, damit der globalThis-basierte
 * Reload-Sicherheitsmechanismus der Extension (globalStore) isoliert pro
 * Testfall beobachtet werden kann.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function makeAgentDir(uiConfig: Record<string, unknown>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-dock-wiring-test-"));
	const configDir = path.join(dir, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ ui: uiConfig }), "utf-8");
	return dir;
}

function runScript(script: string, agentDir: string): void {
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
	execFileSync(
		process.execPath,
		["--experimental-transform-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
		{ cwd: projectRoot, env, stdio: "pipe" },
	);
}

// Gemeinsamer Skript-Baustein: fakes Pi/ctx analog zu
// index-child-registration.test.ts, ergaenzt um: (a) pi.on() faengt Handler
// pro Eventname in einem Array ein (statt sie zu verwerfen), (b) ctx.ui
// bietet echte setWidget/onTerminalInput/getEditorText-Stubs mit Buchfuehrung.
const HARNESS = String.raw`
	import registerSubagentExtension from "./src/extension/index.ts";

	const capturedHandlers = {};
	function fakePi() {
		return new Proxy({
			events: { on() { return () => {}; }, emit() {} },
			on(name, handler) {
				(capturedHandlers[name] ??= []).push(handler);
			},
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			sendMessage() {},
			getSessionName() { return undefined; },
		}, {
			get(target, prop) {
				if (prop in target) return target[prop];
				return () => undefined;
			},
		});
	}

	const setWidgetCalls = [];
	let nextSubId = 0;
	const liveSubscriptions = new Set();
	function makeCtx() {
		return {
			cwd: process.cwd(),
			hasUI: true,
			ui: {
				setWidget(key, content, opts) { setWidgetCalls.push({ key, content, opts }); },
				onTerminalInput(handler) {
					const id = nextSubId++;
					liveSubscriptions.add(id);
					return () => { liveSubscriptions.delete(id); };
				},
				getEditorText() { return ""; },
				requestRender() {},
				setToolsExpanded() {},
				theme: { fg: (_n, t) => t, bg: (_n, t) => t, bold: (t) => t },
			},
			sessionManager: {
				getSessionId() { return "session-test"; },
				getSessionFile() { return null; },
				getEntries() { return []; },
			},
			modelRegistry: { getAvailable() { return []; } },
		};
	}

	function lastCallFor(key) {
		const calls = setWidgetCalls.filter((c) => c.key === key);
		return calls.length > 0 ? calls[calls.length - 1] : undefined;
	}

	// registerMainWatchdog() also registers its own session_start handler
	// before the extension's own (see src/watchdog/register-main.ts), so
	// index 0 is never the one that calls resetSessionState(). Always fire
	// the most recently registered handler for a given event instead of
	// assuming a fixed index.
	function latest(name) {
		const handlers = capturedHandlers[name] ?? [];
		return handlers[handlers.length - 1];
	}
`;

describe("fleet dock wiring", () => {
	it("registers the fleet dock widget and terminal input handler when fleetView is enabled", () => {
		const agentDir = makeAgentDir({ fleetView: true });
		const script = `${HARNESS}
			registerSubagentExtension(fakePi());
			const ctx = makeCtx();
			latest("session_start")({}, ctx);

			const fleetCall = lastCallFor("subagent-fleet-dock");
			if (!fleetCall) throw new Error("expected subagent-fleet-dock widget to be registered");
			if (typeof fleetCall.content !== "function") throw new Error("expected fleet dock widget content to be a factory function");
			if (fleetCall.opts?.placement !== "belowEditor") throw new Error("expected default placement belowEditor, got " + JSON.stringify(fleetCall.opts));
			if (liveSubscriptions.size !== 1) throw new Error("expected exactly 1 terminal input subscription, got " + liveSubscriptions.size);
		`;
		runScript(script, agentDir);
	});

	it("does not touch the fleet dock widget or terminal input when fleetView is disabled", () => {
		const agentDir = makeAgentDir({});
		const script = `${HARNESS}
			registerSubagentExtension(fakePi());
			const ctx = makeCtx();
			latest("session_start")({}, ctx);

			if (lastCallFor("subagent-fleet-dock")) throw new Error("did not expect the fleet dock widget to be registered when fleetView is off");
			if (liveSubscriptions.size !== 0) throw new Error("did not expect any terminal input subscription when fleetView is off, got " + liveSubscriptions.size);
		`;
		runScript(script, agentDir);
	});

	it("does not accumulate terminal input handlers across an extension reload", () => {
		const agentDir = makeAgentDir({ fleetView: true });
		const script = `${HARNESS}
			const ctx = makeCtx();

			registerSubagentExtension(fakePi());
			latest("session_start")({}, ctx);
			if (liveSubscriptions.size !== 1) throw new Error("expected 1 subscription after first load, got " + liveSubscriptions.size);

			// Simulates a hot reload: registering the extension again triggers
			// index.ts's existing globalThis-based runtimeCleanup, which now also
			// disposes the previous FleetDockController's terminal input handler.
			registerSubagentExtension(fakePi());
			latest("session_start")({}, ctx);
			if (liveSubscriptions.size !== 1) throw new Error("expected exactly 1 live subscription after reload, got " + liveSubscriptions.size);
		`;
		runScript(script, agentDir);
	});

	it("registers the fleet inspector widget through the real extension (PHASE-05)", () => {
		const agentDir = makeAgentDir({ fleetView: true });
		const script = `${HARNESS}
			registerSubagentExtension(fakePi());
			const ctx = makeCtx();
			latest("session_start")({}, ctx);

			const inspectorCall = lastCallFor("subagent-fleet-inspector");
			if (!inspectorCall) throw new Error("expected subagent-fleet-inspector widget to be registered");
			if (typeof inspectorCall.content !== "function") throw new Error("expected fleet inspector widget content to be a factory function");
			if (inspectorCall.opts?.placement !== "belowEditor") throw new Error("expected default placement belowEditor, got " + JSON.stringify(inspectorCall.opts));
			// Still exactly 1 shared terminal input subscription - the inspector
			// does not register a second onTerminalInput handler of its own.
			if (liveSubscriptions.size !== 1) throw new Error("expected exactly 1 terminal input subscription, got " + liveSubscriptions.size);
		`;
		runScript(script, agentDir);
	});

	it("does not register the fleet inspector widget when fleetView is disabled", () => {
		const agentDir = makeAgentDir({});
		const script = `${HARNESS}
			registerSubagentExtension(fakePi());
			const ctx = makeCtx();
			latest("session_start")({}, ctx);

			if (lastCallFor("subagent-fleet-inspector")) throw new Error("did not expect the fleet inspector widget to be registered when fleetView is off");
		`;
		runScript(script, agentDir);
	});
});
