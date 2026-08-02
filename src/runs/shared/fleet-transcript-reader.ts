/**
 * Sicherer Leser fuer Kind-Transcript-Artefakte (PHASE-05).
 *
 * Liest die von src/shared/child-transcript.ts geschriebenen
 * "_transcript.jsonl"-Dateien (recordType: message/tool_start/tool_end/
 * stdout/stderr/truncated) und uebersetzt sie in ein UI-unabhaengiges
 * TranscriptEvent[]-Modell (user/assistant/tool/notice). Diese Datei ist
 * bewusst framework-unabhaengig (kein pi-tui/pi-coding-agent-Import),
 * analog zu fleet-projection.ts.
 *
 * Sicherheitsalgorithmus spiegelt das bewaehrte, aber private Muster aus
 * src/runs/background/fleet-view.ts (readContainedTextTail) 1:1 - diese
 * Datei bleibt unangetastete Baseline dieser Phase, daher wird pathWithin/
 * isNotFoundError/getErrorMessage hier lokal dupliziert statt importiert:
 * resolve+Praefix-Check -> lstat (ENOENT still leer, Symlink/Non-File
 * ablehnen) -> realpath von Kandidat UND allen Roots, erneuter Containment-
 * Check (schlaegt einen symlinkten Ancestor).
 *
 * Korrelationsalgorithmus (dreistufig, siehe DECISIONS.md): tool_start und
 * tool_end tragen NIE ein Ergebnis - das eigentliche Tool-Ergebnis kommt als
 * eigener recordType:"message"-Eintrag mit role:"toolResult". Zwei FIFO-
 * Queues (openTools/awaitingResult) korrelieren die drei Records; Tiefe 1
 * im Normalfall (ein Kind-Agent fuehrt nie zwei Tools gleichzeitig aus,
 * verifiziert gegen execution.ts/subagent-runner.ts), die Queue-Struktur
 * ist reine Verteidigungstiefe. Fensterrand-Faelle (Start/Ende/Ergebnis vom
 * Tail-Read abgeschnitten) werden nie stillschweigend verworfen, sondern
 * synthetisieren ein bestmoegliches Event.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import { TEMP_ARTIFACTS_DIR } from "../../shared/types.ts";

export const INSPECTOR_TRANSCRIPT_TAIL_BYTES = 512 * 1024;
export const INSPECTOR_MAX_TRANSCRIPT_EVENTS = 300;
export const INSPECTOR_MAX_EVENT_TEXT_CHARS = 4000;

export type TranscriptEvent =
	| { type: "user"; ts: number; text: string; truncated?: boolean }
	| {
			type: "assistant";
			ts: number;
			text: string;
			truncated?: boolean;
			model?: string;
			stopReason?: string;
			errorMessage?: string;
			usage?: { input: number; output: number; total: number };
	  }
	| {
			type: "tool";
			ts: number;
			toolName: string;
			argsPreview?: string;
			startTs?: number;
			endTs?: number;
			resultText?: string;
			resultTruncated?: boolean;
			isError?: boolean;
			toolState: "running" | "awaiting_result" | "complete";
	  }
	| {
			type: "notice";
			ts: number;
			text: string;
			kind: "writer_truncated" | "reader_truncated" | "stdout" | "stderr" | "malformed_lines";
	  };

export interface ParsedChildTranscript {
	events: TranscriptEvent[];
	truncated: boolean;
}

export interface ReadChildTranscriptResult {
	events: TranscriptEvent[];
	truncated: boolean;
	error?: string;
}

export interface InspectorTrustedRootsInput {
	sessionFile?: string | null;
	projectCwd?: string;
	worktreeBaseDir?: string;
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function expandHomeTilde(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
	return value;
}

/**
 * Trusted Roots fuer readChildTranscript(): dieselbe Ableitung, die der
 * Schreiber (child-transcript.ts ueber shared/artifacts.ts) fuer den
 * aktuellen Kontext verwendet, UNION TEMP_ARTIFACTS_DIR (Fallback/Legacy-
 * Laeufe) UND optional config.worktreeBaseDir (Worktree-Kind-Laeufe rufen
 * getArtifactsDir() mit einem abweichenden effectiveCwd auf, siehe
 * DECISIONS.md). transcriptPath wird NIE ungeprueft vertraut - immer
 * resolve+realpath+Containment-Check gegen dieses Set.
 */
export function resolveInspectorTrustedRoots(input: InspectorTrustedRootsInput): string[] {
	const roots = new Set<string>();
	roots.add(path.resolve(getArtifactsDir(input.sessionFile ?? null, input.projectCwd)));
	if (input.sessionFile) roots.add(path.resolve(getArtifactsDir(input.sessionFile, undefined)));
	roots.add(path.resolve(TEMP_ARTIFACTS_DIR));
	if (input.worktreeBaseDir) roots.add(path.resolve(expandHomeTilde(input.worktreeBaseDir)));
	return [...roots];
}

function capText(text: string): { text: string; truncated: boolean } {
	if (text.length <= INSPECTOR_MAX_EVENT_TEXT_CHARS) return { text, truncated: false };
	return { text: `${text.slice(0, INSPECTOR_MAX_EVENT_TEXT_CHARS)}\u2026`, truncated: true };
}

function normalizeUsageForEvent(value: unknown): { input: number; output: number; total: number } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const input = typeof raw.input === "number" ? raw.input : 0;
	const output = typeof raw.output === "number" ? raw.output : 0;
	return { input, output, total: input + output };
}

interface ToolDraft {
	toolName: string;
	argsPreview?: string;
	startTs: number;
	endTs?: number;
}

/**
 * Reine Funktion (kein fs) - parst bereits extrahierte, vollstaendige
 * JSONL-Zeilen (Fensterrand-/Teilzeilen muss der Aufrufer vorher entfernt
 * haben, siehe readTranscriptLinesTail) in ein sortiertes TranscriptEvent[].
 */
export function parseChildTranscriptLines(lines: string[]): ParsedChildTranscript {
	const events: TranscriptEvent[] = [];
	const openTools: ToolDraft[] = [];
	const awaitingResult: ToolDraft[] = [];
	let writerTruncated = false;
	let malformedLineCount = 0;

	for (const line of lines) {
		if (!line.trim()) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			malformedLineCount += 1;
			continue;
		}

		const recordType = record.recordType as string | undefined;
		const ts = typeof record.ts === "number" ? record.ts : Date.now();

		if (recordType === "tool_start") {
			const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
			const argsPreview = typeof record.argsPreview === "string" ? record.argsPreview : undefined;
			openTools.push({ toolName, argsPreview, startTs: ts });
			continue;
		}

		if (recordType === "tool_end") {
			const draft = openTools.shift();
			if (draft) {
				draft.endTs = ts;
				awaitingResult.push(draft);
			} else {
				// Fensterrand: der Start wurde vom Tail-Read abgeschnitten. Trotzdem
				// aufnehmen, damit ein nachfolgendes Ergebnis nicht verloren geht.
				const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
				awaitingResult.push({ toolName, startTs: ts, endTs: ts });
			}
			continue;
		}

		if (recordType === "message") {
			const role = record.role as string | undefined;

			if (role === "toolResult") {
				const message = (record.message ?? {}) as Record<string, unknown>;
				const draft = awaitingResult.shift();
				const toolName = draft?.toolName ?? (typeof message.toolName === "string" ? message.toolName : "tool");
				const { text: resultText, truncated: resultTruncated } = capText(typeof record.text === "string" ? record.text : "");
				events.push({
					type: "tool",
					ts: draft?.startTs ?? ts,
					toolName,
					argsPreview: draft?.argsPreview,
					startTs: draft?.startTs,
					endTs: draft?.endTs,
					resultText,
					resultTruncated,
					isError: message.isError === true,
					toolState: "complete",
				});
				continue;
			}

			if (role === "user") {
				const rawText = typeof record.text === "string" ? record.text : undefined;
				if (rawText) {
					const { text, truncated } = capText(rawText);
					events.push({ type: "user", ts, text, truncated });
				}
				continue;
			}

			if (role === "assistant") {
				const rawText = typeof record.text === "string" ? record.text : undefined;
				const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : undefined;
				if (rawText || errorMessage) {
					const { text, truncated } = capText(rawText ?? "");
					events.push({
						type: "assistant",
						ts,
						text,
						truncated,
						model: typeof record.model === "string" ? record.model : undefined,
						stopReason: typeof record.stopReason === "string" ? record.stopReason : undefined,
						errorMessage,
						usage: normalizeUsageForEvent(record.usage),
					});
				}
				continue;
			}
			// Unbekannte role: still ignorieren.
			continue;
		}

		if (recordType === "truncated") {
			writerTruncated = true;
			const message = typeof record.message === "string" ? record.message : "Transcript truncated by writer.";
			events.push({ type: "notice", ts, text: message, kind: "writer_truncated" });
			continue;
		}

		if (recordType === "stdout" || recordType === "stderr") {
			const { text } = capText(typeof record.text === "string" ? record.text : "");
			events.push({ type: "notice", ts, text, kind: recordType });
			continue;
		}
		// Unbekannter recordType: still ignorieren, kein Fehler.
	}

	// Verbleibende Drafts nach der letzten Zeile sind die Live-Grundlage fuer
	// "Live-Transcript eines laufenden Agents wird korrekt aktualisiert".
	for (const draft of openTools) {
		events.push({ type: "tool", ts: draft.startTs, toolName: draft.toolName, argsPreview: draft.argsPreview, startTs: draft.startTs, toolState: "running" });
	}
	for (const draft of awaitingResult) {
		events.push({
			type: "tool",
			ts: draft.startTs,
			toolName: draft.toolName,
			argsPreview: draft.argsPreview,
			startTs: draft.startTs,
			endTs: draft.endTs,
			toolState: "awaiting_result",
		});
	}

	if (malformedLineCount > 0) {
		events.push({
			type: "notice",
			ts: Date.now(),
			text: `${malformedLineCount} transcript line(s) could not be parsed and were skipped.`,
			kind: "malformed_lines",
		});
	}

	events.sort((a, b) => a.ts - b.ts);

	let truncated = writerTruncated;
	let finalEvents = events;
	if (events.length > INSPECTOR_MAX_TRANSCRIPT_EVENTS) {
		finalEvents = events.slice(events.length - INSPECTOR_MAX_TRANSCRIPT_EVENTS);
		truncated = true;
	}

	return { events: finalEvents, truncated };
}

interface TranscriptLinesTailResult {
	lines: string[];
	windowTruncated: boolean;
}

/**
 * Tail-liest bis zu INSPECTOR_TRANSCRIPT_TAIL_BYTES vom Dateiende. Anders als
 * das textuelle readTextTail-Vorbild in fleet-view.ts wird der letzte Split-
 * Rest IMMER verworfen (nicht nur wenn er leer ist): fuer JSONL ist ein
 * nicht auf "\n" endender Rest zwingend eine unvollstaendige Zeile (der
 * Schreiber war noch mitten im appendFileSync), niemals sinnvoll anzeigbarer
 * Klartext - die Aenderungsregel verlangt, ihn zu ignorieren statt als
 * Fehler zu werfen.
 */
function readTranscriptLinesTail(filePath: string): TranscriptLinesTailResult {
	const stat = fs.statSync(filePath);
	if (stat.size === 0) return { lines: [], windowTruncated: false };

	const bytesToRead = Math.min(stat.size, INSPECTOR_TRANSCRIPT_TAIL_BYTES);
	const start = stat.size - bytesToRead;
	const buffer = Buffer.alloc(bytesToRead);
	const fd = fs.openSync(filePath, "r");
	let bytesRead: number;
	try {
		bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
	} finally {
		fs.closeSync(fd);
	}

	const content = buffer.subarray(0, bytesRead).toString("utf-8");
	let lines = content.split(/\r?\n/);
	lines = lines.slice(0, -1); // letzter Rest: entweder "" (sauber terminiert) oder Teilzeile - immer verwerfen.
	if (start > 0 && lines.length > 0) lines = lines.slice(1); // erster Rest: durch das Tail-Fenster abgeschnitten.

	return { lines, windowTruncated: start > 0 };
}

/**
 * Sicherer Voll-Ablauf: Trusted-Root-Pruefung -> Tail-Read -> Parser.
 * Reihenfolge spiegelt readContainedTextTail() aus fleet-view.ts 1:1.
 */
export function readChildTranscript(filePath: string, trustedRoots: string[]): ReadChildTranscriptResult {
	if (trustedRoots.length === 0) {
		return { events: [], truncated: false, error: `Refusing to read transcript path without a trusted root: ${filePath}` };
	}

	const resolvedPath = path.resolve(filePath);
	if (!trustedRoots.some((root) => pathWithin(root, resolvedPath))) {
		return { events: [], truncated: false, error: `Refusing to read transcript path outside trusted roots: ${filePath}` };
	}

	let lstat: fs.Stats;
	try {
		lstat = fs.lstatSync(resolvedPath);
	} catch (error) {
		if (isNotFoundError(error)) return { events: [], truncated: false };
		return { events: [], truncated: false, error: getErrorMessage(error) };
	}
	if (lstat.isSymbolicLink()) {
		return { events: [], truncated: false, error: `Refusing to read symlink transcript path: ${filePath}` };
	}
	if (!lstat.isFile()) {
		return { events: [], truncated: false, error: `Refusing to read non-file transcript path: ${filePath}` };
	}

	let realPath: string;
	let realRoots: string[];
	try {
		realPath = fs.realpathSync(resolvedPath);
		realRoots = trustedRoots.filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root));
	} catch (error) {
		return { events: [], truncated: false, error: getErrorMessage(error) };
	}
	if (!realRoots.some((root) => pathWithin(root, realPath))) {
		return { events: [], truncated: false, error: `Refusing to read transcript path outside trusted roots: ${filePath}` };
	}

	let tail: TranscriptLinesTailResult;
	try {
		tail = readTranscriptLinesTail(resolvedPath);
	} catch (error) {
		return { events: [], truncated: false, error: getErrorMessage(error) };
	}

	const parsed = parseChildTranscriptLines(tail.lines);
	const events = tail.windowTruncated
		? [
				{
					type: "notice" as const,
					ts: parsed.events[0]?.ts ?? Date.now(),
					text: "Earlier transcript content was omitted (file exceeds the read window).",
					kind: "reader_truncated" as const,
				},
				...parsed.events,
			]
		: parsed.events;

	return { events, truncated: tail.windowTruncated || parsed.truncated };
}
