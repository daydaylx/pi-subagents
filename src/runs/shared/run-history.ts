import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../shared/utils.ts";

export interface RunEntry {
	agent: string;
	task: string;
	ts: number;
	status: "ok" | "error";
	duration: number;
	exit?: number;
	// cwd ist noetig, weil run-history.jsonl global unter getAgentDir() liegt
	// (nicht pro Worktree/Session isoliert) -- ohne cwd laesst sich ein
	// bestimmter Lauf (z.B. ein real-duel-Benchmark-Trial) nicht von anderer,
	// gleichzeitiger Pi-Nutzung auf derselben Maschine unterscheiden.
	cwd?: string;
	tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	cost?: number;
}

const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;

function getHistoryPath(): string {
	return path.join(getAgentDir(), "run-history.jsonl");
}

export interface RecordRunExtras {
	cwd?: string;
	tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	cost?: number;
}

export function recordRun(
	agent: string,
	task: string,
	exitCode: number,
	durationMs: number,
	extras?: RecordRunExtras,
): void {
	try {
		const entry: RunEntry = {
			agent,
			task: task.slice(0, 200),
			ts: Math.floor(Date.now() / 1000),
			status: exitCode === 0 ? "ok" : "error",
			duration: durationMs,
			...(exitCode !== 0 ? { exit: exitCode } : {}),
			...(extras?.cwd ? { cwd: extras.cwd } : {}),
			...(extras?.tokens ? { tokens: extras.tokens } : {}),
			...(typeof extras?.cost === "number" ? { cost: extras.cost } : {}),
		};
		const historyPath = getHistoryPath();
		fs.mkdirSync(path.dirname(historyPath), { recursive: true });
		fs.appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
	} catch {
		// Best-effort — never crash the execution flow for history recording
	}
}

export function loadRunsForAgent(agent: string): RunEntry[] {
	const historyPath = getHistoryPath();
	if (!fs.existsSync(historyPath)) return [];
	let raw: string;
	try {
		raw = fs.readFileSync(historyPath, "utf-8");
	} catch {
		return [];
	}

	let lines = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

	if (lines.length > ROTATE_READ_THRESHOLD) {
		lines = lines.slice(-ROTATE_KEEP);
		try { fs.writeFileSync(historyPath, `${lines.join("\n")}\n`, "utf-8"); } catch {}
	}

	return lines
		.map((line) => { try { return JSON.parse(line) as RunEntry; } catch { return undefined; } })
		.filter((entry): entry is RunEntry => entry !== undefined && entry.agent === agent)
		.reverse();
}
