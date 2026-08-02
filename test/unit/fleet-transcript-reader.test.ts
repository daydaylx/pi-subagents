import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { getArtifactsDir } from "../../src/shared/artifacts.ts";
import {
	INSPECTOR_MAX_EVENT_TEXT_CHARS,
	INSPECTOR_MAX_TRANSCRIPT_EVENTS,
	INSPECTOR_TRANSCRIPT_TAIL_BYTES,
	parseChildTranscriptLines,
	readChildTranscript,
	resolveInspectorTrustedRoots,
	type TranscriptEvent,
} from "../../src/runs/shared/fleet-transcript-reader.ts";
import { TEMP_ARTIFACTS_DIR } from "../../src/shared/types.ts";

function rec(recordType: string, ts: number, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ recordType, ts, ...extra });
}

function toolStart(ts: number, toolName: string, argsPreview?: string): string {
	return rec("tool_start", ts, argsPreview ? { toolName, argsPreview } : { toolName });
}

function toolEnd(ts: number, toolName?: string): string {
	return rec("tool_end", ts, toolName ? { toolName } : {});
}

function toolResult(ts: number, toolName: string, text: string, isError = false): string {
	return rec("message", ts, { role: "toolResult", text, message: { role: "toolResult", toolCallId: "call-1", toolName, isError } });
}

function userMessage(ts: number, text: string): string {
	return rec("message", ts, { role: "user", text });
}

function assistantMessage(ts: number, text: string, extra: Record<string, unknown> = {}): string {
	return rec("message", ts, { role: "assistant", text, ...extra });
}

function toolEvents(events: TranscriptEvent[]): Array<TranscriptEvent & { type: "tool" }> {
	return events.filter((event): event is TranscriptEvent & { type: "tool" } => event.type === "tool");
}

describe("parseChildTranscriptLines", () => {
	it("merges a single tool_start/tool_end/toolResult sequence into one complete tool event", () => {
		const { events, truncated } = parseChildTranscriptLines([
			toolStart(100, "bash", "ls -la"),
			toolEnd(150, "bash"),
			toolResult(160, "bash", "file1\nfile2"),
		]);
		assert.equal(events.length, 1);
		const [event] = events;
		assert.equal(event?.type, "tool");
		if (event?.type !== "tool") return;
		assert.equal(event.toolState, "complete");
		assert.equal(event.toolName, "bash");
		assert.equal(event.argsPreview, "ls -la");
		assert.equal(event.startTs, 100);
		assert.equal(event.endTs, 150);
		assert.equal(event.resultText, "file1\nfile2");
		assert.equal(event.isError, false);
		assert.equal(truncated, false);
	});

	it("correlates a realistic sequential multi-tool run (bash -> edit -> bash) via FIFO order", () => {
		const { events } = parseChildTranscriptLines([
			toolStart(100, "bash", "ls"),
			toolEnd(110, "bash"),
			toolResult(120, "bash", "OUT_1"),
			toolStart(130, "edit", "file.ts"),
			toolEnd(140, "edit"),
			toolResult(150, "edit", "OUT_2"),
			toolStart(160, "bash", "pwd"),
			toolEnd(170, "bash"),
			toolResult(180, "bash", "OUT_3"),
		]);
		const tools = toolEvents(events);
		assert.equal(tools.length, 3);
		assert.deepEqual(tools.map((t) => t.toolName), ["bash", "edit", "bash"]);
		assert.deepEqual(tools.map((t) => t.resultText), ["OUT_1", "OUT_2", "OUT_3"]);
	});

	it("marks a tool without a matching tool_end as running", () => {
		const { events } = parseChildTranscriptLines([toolStart(100, "bash", "sleep 100")]);
		const [event] = toolEvents(events);
		assert.equal(event?.toolState, "running");
		assert.equal(event?.resultText, undefined);
	});

	it("marks a tool with start+end but no result yet as awaiting_result", () => {
		const { events } = parseChildTranscriptLines([toolStart(100, "bash"), toolEnd(150, "bash")]);
		const [event] = toolEvents(events);
		assert.equal(event?.toolState, "awaiting_result");
		assert.equal(event?.startTs, 100);
		assert.equal(event?.endTs, 150);
		assert.equal(event?.resultText, undefined);
	});

	it("synthesizes a complete event from an orphaned result when start/end fell outside the tail window", () => {
		const { events } = parseChildTranscriptLines([toolResult(200, "bash", "LATE_RESULT")]);
		const [event] = toolEvents(events);
		assert.equal(event?.toolState, "complete");
		assert.equal(event?.toolName, "bash");
		assert.equal(event?.resultText, "LATE_RESULT");
		assert.equal(event?.startTs, undefined);
	});

	it("skips unparsable lines and emits exactly one aggregated malformed_lines notice", () => {
		const { events } = parseChildTranscriptLines(["not json {{{", userMessage(100, "hi"), "also not json"]);
		const notices = events.filter((event) => event.type === "notice" && event.kind === "malformed_lines");
		assert.equal(notices.length, 1);
		assert.match((notices[0] as TranscriptEvent & { type: "notice" }).text, /2 transcript line\(s\)/);
		assert.equal(events.some((event) => event.type === "user"), true);
	});

	it("drops empty/whitespace-only lines silently, without counting them as malformed", () => {
		const { events } = parseChildTranscriptLines(["", "   ", userMessage(100, "hi"), ""]);
		assert.equal(events.some((event) => event.type === "notice" && event.kind === "malformed_lines"), false);
		assert.equal(events.length, 1);
	});

	it("caps to the newest INSPECTOR_MAX_TRANSCRIPT_EVENTS events and flags truncated", () => {
		const total = INSPECTOR_MAX_TRANSCRIPT_EVENTS + 5;
		const lines = Array.from({ length: total }, (_, i) => userMessage(1000 + i, `msg-${i}`));
		const { events, truncated } = parseChildTranscriptLines(lines);
		assert.equal(events.length, INSPECTOR_MAX_TRANSCRIPT_EVENTS);
		assert.equal(truncated, true);
		const first = events[0] as TranscriptEvent & { type: "user" };
		assert.equal(first.text, "msg-5");
	});

	it("caps individual event text to INSPECTOR_MAX_EVENT_TEXT_CHARS and flags it truncated", () => {
		const longText = "x".repeat(INSPECTOR_MAX_EVENT_TEXT_CHARS + 500);
		const { events } = parseChildTranscriptLines([userMessage(100, longText)]);
		const [event] = events;
		assert.equal(event?.type, "user");
		if (event?.type !== "user") return;
		assert.equal(event.text.length, INSPECTOR_MAX_EVENT_TEXT_CHARS + 1);
		assert.equal(event.truncated, true);
	});

	it("turns a writer truncated marker into a notice and flags the whole parse as truncated", () => {
		const { events, truncated } = parseChildTranscriptLines([
			userMessage(100, "hi"),
			rec("truncated", 200, { maxBytes: 1024, message: "Child transcript exceeded 1024 bytes; further records were omitted." }),
		]);
		assert.equal(truncated, true);
		const notice = events.find((event) => event.type === "notice" && event.kind === "writer_truncated");
		assert.notEqual(notice, undefined);
	});

	it("turns stdout/stderr records into dim notices, not chat events", () => {
		const { events } = parseChildTranscriptLines([rec("stdout", 100, { text: "building..." }), rec("stderr", 110, { text: "warning: x" })]);
		assert.equal(events.length, 2);
		assert.equal(events[0]?.type, "notice");
		assert.equal((events[0] as TranscriptEvent & { type: "notice" }).kind, "stdout");
		assert.equal((events[1] as TranscriptEvent & { type: "notice" }).kind, "stderr");
	});

	it("emits assistant events carrying model/stopReason/errorMessage/usage", () => {
		const { events } = parseChildTranscriptLines([
			assistantMessage(100, "done", { model: "claude-sonnet-5", stopReason: "end_turn", usage: { input: 10, output: 20 } }),
		]);
		const [event] = events;
		assert.equal(event?.type, "assistant");
		if (event?.type !== "assistant") return;
		assert.equal(event.model, "claude-sonnet-5");
		assert.equal(event.stopReason, "end_turn");
		assert.deepEqual(event.usage, { input: 10, output: 20, total: 30 });
	});

	it("keeps events chronologically sorted even though trailing drafts are appended after the main loop", () => {
		const { events } = parseChildTranscriptLines([
			toolStart(50, "bash"),
			userMessage(200, "later message"),
		]);
		assert.equal(events.length, 2);
		assert.equal(events[0]?.ts, 50);
		assert.equal(events[1]?.ts, 200);
	});
});

describe("resolveInspectorTrustedRoots", () => {
	it("includes the project artifacts dir plus TEMP_ARTIFACTS_DIR when only projectCwd is given", () => {
		const roots = resolveInspectorTrustedRoots({ projectCwd: "/tmp/project" });
		assert.equal(roots.includes(path.resolve(getArtifactsDir(null, "/tmp/project"))), true);
		assert.equal(roots.includes(path.resolve(TEMP_ARTIFACTS_DIR)), true);
		assert.equal(roots.length, 2);
	});

	it("deduplicates when sessionFile alone resolves to the same dir via both lookups", () => {
		const roots = resolveInspectorTrustedRoots({ sessionFile: "/tmp/sess/session.jsonl" });
		assert.equal(roots.length, 2);
	});

	it("keeps both roots distinct when sessionFile and projectCwd resolve differently", () => {
		const roots = resolveInspectorTrustedRoots({ sessionFile: "/tmp/sess/session.jsonl", projectCwd: "/tmp/project" });
		assert.equal(roots.length, 3);
	});

	it("expands a tilde-prefixed worktreeBaseDir against the home directory", () => {
		const roots = resolveInspectorTrustedRoots({ projectCwd: "/tmp/project", worktreeBaseDir: "~/wt" });
		assert.equal(roots.includes(path.join(os.homedir(), "wt")), true);
	});
});

describe("readChildTranscript security and fs handling", () => {
	function tempRoot(prefix: string): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	}

	it("reads a well-formed transcript within a trusted root", () => {
		const root = tempRoot("pi-fleet-transcript-happy-");
		try {
			const file = path.join(root, "run-1_worker_transcript.jsonl");
			fs.writeFileSync(file, `${userMessage(100, "hello")}\n`, "utf-8");
			const result = readChildTranscript(file, [root]);
			assert.equal(result.error, undefined);
			assert.equal(result.events.length, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns an empty result without an error for a missing file", () => {
		const root = tempRoot("pi-fleet-transcript-missing-");
		try {
			const result = readChildTranscript(path.join(root, "does-not-exist.jsonl"), [root]);
			assert.equal(result.error, undefined);
			assert.deepEqual(result.events, []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses when trustedRoots is empty", () => {
		const root = tempRoot("pi-fleet-transcript-noroots-");
		try {
			const file = path.join(root, "t.jsonl");
			fs.writeFileSync(file, `${userMessage(100, "hi")}\n`, "utf-8");
			const result = readChildTranscript(file, []);
			assert.match(result.error ?? "", /without a trusted root/);
			assert.deepEqual(result.events, []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a relative-path traversal outside the trusted root", () => {
		const root = tempRoot("pi-fleet-transcript-traversal-");
		try {
			const trustedRoot = path.join(root, "artifacts");
			fs.mkdirSync(trustedRoot);
			const outsideFile = path.join(root, "outside.jsonl");
			fs.writeFileSync(outsideFile, `${userMessage(100, "OUTSIDE_TRAVERSAL_SENTINEL")}\n`, "utf-8");
			const traversalPath = path.join(trustedRoot, "..", "outside.jsonl");
			const result = readChildTranscript(traversalPath, [trustedRoot]);
			assert.match(result.error ?? "", /outside trusted roots/);
			assert.equal(JSON.stringify(result.events).includes("OUTSIDE_TRAVERSAL_SENTINEL"), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a symlink placed inside the trusted root that points outside it", () => {
		const root = tempRoot("pi-fleet-transcript-symlink-");
		try {
			const trustedRoot = path.join(root, "artifacts");
			fs.mkdirSync(trustedRoot);
			const outsideFile = path.join(root, "outside.jsonl");
			fs.writeFileSync(outsideFile, `${userMessage(100, "OUTSIDE_SYMLINK_SENTINEL")}\n`, "utf-8");
			const linkedFile = path.join(trustedRoot, "transcript.jsonl");
			fs.symlinkSync(outsideFile, linkedFile);
			const result = readChildTranscript(linkedFile, [trustedRoot]);
			assert.match(result.error ?? "", /Refusing to read symlink/);
			assert.equal(JSON.stringify(result.events).includes("OUTSIDE_SYMLINK_SENTINEL"), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a transcript reached only through a symlinked ancestor directory", () => {
		const root = tempRoot("pi-fleet-transcript-ancestor-");
		try {
			const trustedRoot = path.join(root, "artifacts");
			fs.mkdirSync(trustedRoot);
			const evilDir = path.join(root, "evil");
			fs.mkdirSync(evilDir);
			fs.writeFileSync(path.join(evilDir, "transcript.jsonl"), `${userMessage(100, "OUTSIDE_ANCESTOR_SENTINEL")}\n`, "utf-8");
			const symlinkedAncestor = path.join(trustedRoot, "subdir");
			fs.symlinkSync(evilDir, symlinkedAncestor);
			const candidate = path.join(symlinkedAncestor, "transcript.jsonl");
			const result = readChildTranscript(candidate, [trustedRoot]);
			assert.match(result.error ?? "", /outside trusted roots/);
			assert.equal(JSON.stringify(result.events).includes("OUTSIDE_ANCESTOR_SENTINEL"), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a path that points at a directory instead of a file", () => {
		const root = tempRoot("pi-fleet-transcript-dir-");
		try {
			const trustedRoot = path.join(root, "artifacts");
			const asDir = path.join(trustedRoot, "not-a-file.jsonl");
			fs.mkdirSync(asDir, { recursive: true });
			const result = readChildTranscript(asDir, [trustedRoot]);
			assert.match(result.error ?? "", /non-file/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads only the tail window of an oversized file and marks it truncated", () => {
		const root = tempRoot("pi-fleet-transcript-oversized-");
		try {
			const trustedRoot = path.join(root, "artifacts");
			fs.mkdirSync(trustedRoot);
			const file = path.join(trustedRoot, "big_transcript.jsonl");
			const fd = fs.openSync(file, "w");
			fs.writeSync(fd, `${userMessage(1, "START_OF_FILE_SENTINEL")}\n`);
			const padding = `${rec("stdout", 2, { text: "x".repeat(2000) })}\n`;
			const paddingLinesNeeded = Math.ceil((INSPECTOR_TRANSCRIPT_TAIL_BYTES * 2) / Buffer.byteLength(padding, "utf-8"));
			for (let i = 0; i < paddingLinesNeeded; i += 1) fs.writeSync(fd, padding);
			fs.writeSync(fd, `${userMessage(999999, "END_OF_FILE_SENTINEL")}\n`);
			fs.closeSync(fd);

			const result = readChildTranscript(file, [trustedRoot]);
			assert.equal(result.truncated, true);
			assert.equal(JSON.stringify(result.events).includes("START_OF_FILE_SENTINEL"), false);
			assert.equal(JSON.stringify(result.events).includes("END_OF_FILE_SENTINEL"), true);
			assert.equal(result.events.some((event) => event.type === "notice" && event.kind === "reader_truncated"), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("silently drops an incomplete trailing JSONL line instead of erroring", () => {
		const root = tempRoot("pi-fleet-transcript-incomplete-");
		try {
			const trustedRoot = path.join(root, "artifacts");
			fs.mkdirSync(trustedRoot);
			const file = path.join(trustedRoot, "t.jsonl");
			const complete = `${userMessage(100, "complete message")}\n`;
			const fullSecondLine = `${userMessage(200, "cut off mid-write")}\n`;
			const incomplete = fullSecondLine.slice(0, Math.floor(fullSecondLine.length / 2));
			fs.writeFileSync(file, complete + incomplete, "utf-8");
			const result = readChildTranscript(file, [trustedRoot]);
			assert.equal(result.error, undefined);
			assert.equal(result.events.length, 1);
			assert.equal((result.events[0] as TranscriptEvent & { type: "user" }).text, "complete message");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("sees newly appended lines on a subsequent read (live growth)", () => {
		const root = tempRoot("pi-fleet-transcript-growth-");
		try {
			const trustedRoot = path.join(root, "artifacts");
			fs.mkdirSync(trustedRoot);
			const file = path.join(trustedRoot, "t.jsonl");
			fs.writeFileSync(file, `${userMessage(100, "first")}\n`, "utf-8");
			const first = readChildTranscript(file, [trustedRoot]);
			assert.equal(first.events.length, 1);

			fs.appendFileSync(file, `${toolStart(200, "bash")}\n${toolEnd(210, "bash")}\n${toolResult(220, "bash", "grown")}\n`, "utf-8");
			const second = readChildTranscript(file, [trustedRoot]);
			assert.equal(second.events.length, 2);
			assert.equal(second.events.some((event) => event.type === "tool" && event.toolState === "complete"), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
