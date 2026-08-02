/**
 * Fleet-Zustandsprojektion (PHASE-03).
 *
 * Konsolidiert fuenf im Fork parallel existierende, teils inkonsistente
 * Progress-Schemas (anonymer foregroundControls-Wert, AsyncJobState /
 * AsyncRunSummary, NestedRunSummary / PublicNestedRunSummary,
 * ForegroundResumeRun, SingleResult / Details) zu einem einzigen,
 * UI-unabhaengigen Modell: FleetAgentEntry.
 *
 * State-Vokabular-Mapping (mapRawStateToFleetState), da mindestens vier
 * inkonsistente Rohvokabulare im Umlauf sind:
 *
 *   Rohwert                 | Herkunft                                 | FleetAgentState
 *   ------------------------|-------------------------------------------|------------------
 *   "queued", "pending"     | AsyncStatus/AsyncJobState/AsyncJobStep     | "running"
 *   "running"                | alle                                       | "running"
 *   "complete", "completed" | AsyncStatus/SubagentResultStatus/...       | "completed"
 *   "failed"                 | alle                                       | "error"
 *   "paused"                 | alle                                       | "paused"
 *   "stopped"                | alle                                       | "stopped"
 *   "detached"                | SubagentResultStatus/WorkflowNodeStatus    | "running" + detached:true
 *
 * Design-Entscheidung "flache Liste statt Rekursion": Live-Parallel-/
 * Chain-Kinder existieren im durablen State ohnehin nicht als Array
 * (state.foregroundControls haelt nur EIN Objekt pro Top-Level-runId, das
 * von jedem Kind-Update ueberschrieben wird). Nur Nested-Runs sind wirklich
 * rekursiv. Ein children?:FleetAgentEntry[]-Feld waere fuer Foreground-
 * Parallel/Chain dauerhaft leer, fuer Nested aber "echt" - inkonsistente
 * Semantik. Stattdessen: parentKey + depth, Consumer gruppiert selbst.
 *
 * KNOWN GAP 1: Watchdog-Eskalation ist nur fuer Async-/Nested-Quellen
 * moeglich. Weder der foregroundControls-Wert noch ForegroundResumeChild
 * fuehren ein watchdog-Feld.
 *
 * KNOWN GAP 2: Fuer aktive Foreground-Parallel-/Chain-Laeufe existiert im
 * Live-State kein Array aller Kinder (nur "wer zuletzt lief, gewinnt" im
 * einzigen foregroundControls-Eintrag). normalizeForegroundActive() liefert
 * daher bewusst nur EINE Sammelzeile pro Top-Level-Lauf.
 *
 * KNOWN GAP 3: Bekannter Fork-Bug - AsyncRunStepSummary (Projektion in
 * async-status.ts, Basis von listAsyncRuns()) fuehrt kein transcriptPath-
 * und kein watchdog-Feld. Nach einem Extension-Neustart (restoreActiveJobs
 * laeuft ueber genau diesen Pfad) fehlen beide Felder auf state.asyncJobs,
 * bis der naechste Poll-Tick sie aus dem rohen AsyncStatus.steps ueberschreibt.
 * transcriptPathMaybeStale markiert betroffene, disk-projizierte Eintraege;
 * fuer live aus state.asyncJobs gelesene Eintraege ist der fehlende Wert von
 * einer echten Neustart-Luecke nicht unterscheidbar und wird daher nicht
 * markiert. Kein Fix dieses Fork-Bugs - ausserhalb des PHASE-03-Scopes.
 *
 * KNOWN GAP 4: ForegroundResumeRun/ForegroundResumeChild fuehren kein
 * startedAt-Feld (nur updatedAt). normalizeForegroundRecent() faellt fuer
 * startedAt auf updatedAt zurueck, statt einen Wert zu erfinden.
 *
 * KNOWN GAP 5: Abgeschlossene/detachte Foreground-Runs (ForegroundResumeRun)
 * fuehren keine nestedChildren mehr - die Nested-Projektion existiert nur auf
 * lebenden foregroundControls-/AsyncJobState-Eintraegen.
 *
 * KNOWN GAP 6 (PHASE-05): model/thinking existieren strukturell nur auf
 * AsyncJobStep/AsyncRunStepSummary (Async-Steps). Weder der anonyme
 * foregroundControls-Wert noch ForegroundResumeChild/NestedStepSummary
 * fuehren diese Felder - Foreground- und Nested-Eintraege lassen model/
 * thinking daher immer undefined, auch wenn der zugrundeliegende Agent
 * tatsaechlich mit einem bestimmten Modell laeuft.
 *
 * KNOWN GAP 7 (PHASE-06): asyncDir/pid (Voraussetzung fuer eine echte,
 * kanalbasierte Stop-Aktion) existieren strukturell nur auf der Async-
 * Parent-Zeile (job.asyncDir/job.pid bzw. run.asyncDir - AsyncRunSummary
 * fuehrt kein pid-Feld, dort bleibt pid daher immer undefined). Foreground-
 * und Nested-Eintraege sowie Async-Steps fuehren beide Felder nicht - deckt
 * sich mit canStop, das fuer all diese Quellen ohnehin false ist (siehe
 * subagent-executor.ts: action="stop" wird fuer foreground/nested explizit
 * abgelehnt, nur echte Async-Runs besitzen den dateibasierten Stop-Kanal
 * aus control-channel.ts).
 */

import { shortenPath } from "../../shared/formatters.ts";
import {
	type ActivityState,
	ASYNC_DIR,
	type AsyncJobState,
	type ForegroundControlState,
	type ForegroundResumeChild,
	type ForegroundResumeRun,
	type NestedRunSummary,
	type NestedStepSummary,
	RESULTS_DIR,
	type SubagentRunMode,
	type SubagentState,
} from "../../shared/types.ts";
import { childWatchdogIsActive, type ChildWatchdogStateSnapshot } from "../../watchdog/child-status.ts";
import { listAsyncRuns, type AsyncRunSummary } from "../background/async-status.ts";
import { updateAsyncJobNestedProjection, updateForegroundNestedProjection } from "./nested-events.ts";

export type FleetAgentState = "running" | "needs_attention" | "paused" | "stopped" | "completed" | "error";

export type FleetAttentionReason = "control_notice" | "watchdog_reviewing" | "watchdog_stalled" | "supervisor_pending";

/**
 * Strukturell kompatibler, lokal definierter Ersatz fuer das nicht
 * exportierte PendingSupervisorRequest aus native-supervisor-channel.ts
 * (diese Datei ist bewusste, unangetastete Baseline dieser Phase).
 */
export interface FleetPendingSupervisorRequest {
	runId: string;
	agent: string;
	childIndex: number;
	expectsReply: boolean;
	reason: string;
}

export interface FleetAgentEntry {
	key: string;
	runId: string;
	childIndex?: number;
	source: "foreground" | "async";
	kind: "active" | "recent";
	parentKey?: string;
	depth: number;

	agent: string;
	description?: string;
	mode?: SubagentRunMode;
	model?: string;
	thinking?: string;

	state: FleetAgentState;
	needsAttention: boolean;
	attentionReason?: FleetAttentionReason;
	canStop: boolean;
	asyncDir?: string;
	pid?: number;

	currentTool?: string;
	currentPath?: string;
	activityDetail?: string;

	startedAt: number;
	updatedAt: number;

	tokens?: number;
	tokenUsage?: { input: number; output: number; total: number };
	toolCount?: number;
	turnCount?: number;

	transcriptPath?: string;
	transcriptPathMaybeStale?: boolean;

	detached?: boolean;
}

type RawLifecycleState = "queued" | "pending" | "running" | "complete" | "completed" | "failed" | "paused" | "stopped" | "detached";

const RAW_STATE_MAP: Record<RawLifecycleState, FleetAgentState> = {
	queued: "running",
	pending: "running",
	running: "running",
	complete: "completed",
	completed: "completed",
	failed: "error",
	paused: "paused",
	stopped: "stopped",
	detached: "running",
};

/** Unbekannte Rohwerte fallen tolerant auf "running" zurueck statt zu werfen. */
export function mapRawStateToFleetState(raw: string): FleetAgentState {
	return RAW_STATE_MAP[raw as RawLifecycleState] ?? "running";
}

function isLiveRawState(raw: string): boolean {
	return raw === "running" || raw === "queued" || raw === "pending";
}

const STATE_SEVERITY: Record<FleetAgentState, number> = {
	error: 0,
	running: 1,
	needs_attention: 1,
	stopped: 2,
	paused: 3,
	completed: 4,
};

function pickWorstState(states: FleetAgentState[]): FleetAgentState {
	if (states.length === 0) return "completed";
	return states.reduce((worst, candidate) => (STATE_SEVERITY[candidate] < STATE_SEVERITY[worst] ? candidate : worst));
}

export interface AttentionInput {
	lifecycleTerminal: boolean;
	controlActivityState?: ActivityState;
	watchdogSnapshot?: ChildWatchdogStateSnapshot;
	hasPendingSupervisorRequest: boolean;
}

export interface AttentionResult {
	needsAttention: boolean;
	attentionReason?: FleetAttentionReason;
	stateOverride?: "error";
}

/**
 * Kombiniert control-notices, Watchdog-Snapshot und offene Supervisor-
 * Requests zu einem einzigen needsAttention/attentionReason-Ergebnis.
 * Terminal-Guard zuerst: ein bereits abgeschlossener/gestoppter/pausierter
 * Lauf "braucht keine Aufmerksamkeit mehr", auch wenn ein alter Watchdog-
 * Snapshot aus der letzten Aktivitaet vor Abschluss das nahelegen wuerde.
 */
export function resolveAttention(input: AttentionInput): AttentionResult {
	if (input.lifecycleTerminal) return { needsAttention: false };

	if (input.controlActivityState === "needs_attention") {
		return { needsAttention: true, attentionReason: "control_notice" };
	}

	const watchdog = input.watchdogSnapshot;
	if (watchdog) {
		if (watchdog.phase === "failed") {
			// Ein havarierter Watchdog eskaliert den State selbst zu "error", nicht nur
			// die Attention-Flag - die Supervision des Kindes ist gescheitert. Es teilt
			// sich den "watchdog_stalled"-Reason-Bucket mit stale/timedOut, da das
			// FleetAttentionReason-Vokabular bewusst keinen eigenen "failed"-Wert fuehrt.
			return { needsAttention: true, attentionReason: "watchdog_stalled", stateOverride: "error" };
		}
		if (watchdog.phase === "stale" || watchdog.timedOut) {
			return { needsAttention: true, attentionReason: "watchdog_stalled" };
		}
		if (childWatchdogIsActive(watchdog)) {
			return { needsAttention: true, attentionReason: "watchdog_reviewing" };
		}
	}

	if (input.hasPendingSupervisorRequest) {
		return { needsAttention: true, attentionReason: "supervisor_pending" };
	}

	return { needsAttention: false };
}

export interface ActivityDetailInput {
	currentTool?: string;
	currentPath?: string;
	watchdogSnapshot?: ChildWatchdogStateSnapshot;
	pendingSupervisorReason?: string;
	needsAttention: boolean;
	state: FleetAgentState;
}

/**
 * Informationspriroritaet fuer die konkrete Taetigkeitsanzeige. Erste
 * zutreffende Regel gewinnt; der generische Lifecycle-State ist bewusst
 * nur der letzte Fallback (Verifikationskriterium der Phase).
 */
export function pickActivityDetail(input: ActivityDetailInput): string | undefined {
	if (input.currentTool) {
		return input.currentPath ? `tool: ${input.currentTool} (${shortenPath(input.currentPath)})` : `tool: ${input.currentTool}`;
	}

	const watchdog = input.watchdogSnapshot;
	if (watchdog) {
		if (watchdog.phase === "stale" || watchdog.timedOut) return "watchdog: stalled";
		if (childWatchdogIsActive(watchdog)) return `watchdog: ${watchdog.phase}`;
	}

	if (input.pendingSupervisorReason) return `waiting: ${input.pendingSupervisorReason}`;
	if (input.needsAttention) return "needs attention";
	return input.state;
}

function findPendingRequest(pending: FleetPendingSupervisorRequest[], runId: string, childIndex?: number): FleetPendingSupervisorRequest | undefined {
	return pending.find(
		(request) => request.expectsReply && request.runId === runId && (childIndex === undefined || request.childIndex === childIndex),
	);
}

export interface ForegroundActiveContext {
	pending: FleetPendingSupervisorRequest[];
	now: number;
}

/**
 * Normalisiert die aktive Sammelzeile eines Foreground-Laufs (single,
 * parallel oder chain). Liefert bewusst nur EINE Zeile - siehe KNOWN GAP 2.
 */
export function normalizeForegroundActive(control: ForegroundControlState, ctx: ForegroundActiveContext): FleetAgentEntry {
	updateForegroundNestedProjection(control);

	const pendingRequest = findPendingRequest(ctx.pending, control.runId, control.currentIndex);
	const attention = resolveAttention({
		lifecycleTerminal: false,
		controlActivityState: control.currentActivityState,
		watchdogSnapshot: undefined, // KNOWN GAP 1
		hasPendingSupervisorRequest: Boolean(pendingRequest),
	});

	const state: FleetAgentState = attention.stateOverride ?? "running";
	const startedAt = control.startedAt;
	const updatedAt = control.updatedAt ?? control.lastActivityAt ?? startedAt;

	return {
		// Bewusst OHNE currentIndex im Key - der wechselt bei Parallel-/Chain-Laeufen
		// laufend ("wer zuletzt lief, gewinnt"), waehrend der Key stabil bleiben muss.
		key: `foreground:active:${control.runId}`,
		runId: control.runId,
		source: "foreground",
		kind: "active",
		depth: 0,
		agent: control.mode === "single" && control.currentAgent ? control.currentAgent : control.mode,
		mode: control.mode,
		state,
		needsAttention: attention.needsAttention,
		attentionReason: attention.attentionReason,
		canStop: typeof control.interrupt === "function",
		currentTool: control.currentTool,
		currentPath: control.currentPath,
		activityDetail: pickActivityDetail({
			currentTool: control.currentTool,
			currentPath: control.currentPath,
			watchdogSnapshot: undefined,
			pendingSupervisorReason: pendingRequest?.reason,
			needsAttention: attention.needsAttention,
			state,
		}),
		startedAt,
		updatedAt,
		tokens: control.tokens,
		toolCount: control.toolCount,
		turnCount: control.turnCount,
	};
}

/**
 * Normalisiert einen kuerzlich abgeschlossenen Foreground-Lauf (Parent- +
 * Kind-Zeilen). Bereits aktive runIds werden uebersprungen (kein Duplikat
 * zur aktiven Zeile). KNOWN GAP 4 (kein startedAt) und KNOWN GAP 5 (keine
 * Nested-Kinder) gelten hier.
 */
export function normalizeForegroundRecent(run: ForegroundResumeRun, activeRunIds: Set<string>): FleetAgentEntry[] {
	if (activeRunIds.has(run.runId)) return [];

	const parentKey = `foreground:recent:${run.runId}`;
	const childEntries = run.children.map((child) => normalizeForegroundRecentChild(child, run, parentKey));
	const worstState = pickWorstState(childEntries.map((entry) => entry.state));

	const parentEntry: FleetAgentEntry = {
		key: parentKey,
		runId: run.runId,
		source: "foreground",
		kind: "recent",
		depth: 0,
		agent: run.mode,
		mode: run.mode,
		state: worstState,
		needsAttention: false,
		canStop: false,
		startedAt: run.updatedAt, // KNOWN GAP 4
		updatedAt: run.updatedAt,
	};

	return [parentEntry, ...childEntries];
}

function normalizeForegroundRecentChild(child: ForegroundResumeChild, run: ForegroundResumeRun, parentKey: string): FleetAgentEntry {
	const state = mapRawStateToFleetState(child.status);
	const updatedAt = child.updatedAt ?? run.updatedAt;

	return {
		key: `${parentKey}:${child.index}`,
		runId: run.runId,
		childIndex: child.index,
		source: "foreground",
		kind: "recent",
		parentKey,
		depth: 1,
		agent: child.agent,
		mode: run.mode,
		state,
		needsAttention: false,
		canStop: false,
		startedAt: updatedAt, // KNOWN GAP 4
		updatedAt,
		transcriptPath: child.transcriptPath,
		detached: child.status === "detached",
	};
}

interface AsyncStepInput {
	runId: string;
	parentKey: string;
	index: number;
	agent: string;
	status: string;
	activityState?: ActivityState;
	watchdog?: ChildWatchdogStateSnapshot;
	currentTool?: string;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	tokens?: { input: number; output: number; total: number };
	startedAt?: number;
	endedAt?: number;
	lastActivityAt?: number;
	transcriptPath?: string;
	transcriptPathMaybeStale?: boolean;
	model?: string;
	thinking?: string;
	now: number;
}

function normalizeAsyncStep(input: AsyncStepInput): FleetAgentEntry {
	const baseState = mapRawStateToFleetState(input.status);
	const terminal = baseState === "completed" || baseState === "error" || baseState === "stopped" || baseState === "paused";
	const attention = resolveAttention({
		lifecycleTerminal: terminal,
		controlActivityState: input.activityState,
		watchdogSnapshot: input.watchdog,
		hasPendingSupervisorRequest: false,
	});
	const state = attention.stateOverride ?? baseState;
	const updatedAt = input.lastActivityAt ?? input.endedAt ?? input.startedAt ?? input.now;
	const startedAt = input.startedAt ?? updatedAt;

	return {
		key: `${input.parentKey}:${input.index}`,
		runId: input.runId,
		childIndex: input.index,
		source: "async",
		kind: isLiveRawState(input.status) ? "active" : "recent",
		parentKey: input.parentKey,
		depth: 1,
		agent: input.agent,
		state,
		needsAttention: attention.needsAttention,
		attentionReason: attention.attentionReason,
		canStop: false,
		currentTool: input.currentTool,
		currentPath: input.currentPath,
		activityDetail: pickActivityDetail({
			currentTool: input.currentTool,
			currentPath: input.currentPath,
			watchdogSnapshot: input.watchdog,
			pendingSupervisorReason: undefined,
			needsAttention: attention.needsAttention,
			state,
		}),
		startedAt,
		updatedAt,
		tokens: input.tokens?.total,
		tokenUsage: input.tokens,
		toolCount: input.toolCount,
		turnCount: input.turnCount,
		transcriptPath: input.transcriptPath,
		transcriptPathMaybeStale: input.transcriptPathMaybeStale,
		model: input.model,
		thinking: input.thinking,
	};
}

export interface AsyncActiveContext {
	pending: FleetPendingSupervisorRequest[];
	now: number;
}

/**
 * Normalisiert einen Eintrag aus state.asyncJobs (frisch, in-memory).
 * kind wird pro Eintrag aus dem tatsaechlichen Rohstatus abgeleitet, nicht
 * aus der Herkunfts-Map - abgeschlossene Jobs verbleiben bis zu 10s nach
 * Abschluss in state.asyncJobs (completionRetentionMs, scheduleCleanup()).
 */
export function normalizeAsyncJobState(job: AsyncJobState, ctx: AsyncActiveContext): FleetAgentEntry[] {
	updateAsyncJobNestedProjection(job);

	const parentKey = `async:${job.asyncId}`;
	const pendingRequest = findPendingRequest(ctx.pending, job.asyncId);
	const attention = resolveAttention({
		lifecycleTerminal: !isLiveRawState(job.status),
		controlActivityState: job.activityState,
		watchdogSnapshot: undefined, // KNOWN GAP 1: kein Job-Level-Watchdog, nur pro Step.
		hasPendingSupervisorRequest: Boolean(pendingRequest),
	});
	const state = attention.stateOverride ?? mapRawStateToFleetState(job.status);
	const updatedAt = job.updatedAt ?? job.startedAt ?? ctx.now;
	const startedAt = job.startedAt ?? updatedAt;

	const parentEntry: FleetAgentEntry = {
		key: parentKey,
		runId: job.asyncId,
		source: "async",
		kind: isLiveRawState(job.status) ? "active" : "recent",
		depth: 0,
		agent: job.mode === "single" && job.agents?.[0] ? job.agents[0] : (job.mode ?? "async"),
		mode: job.mode,
		state,
		needsAttention: attention.needsAttention,
		attentionReason: attention.attentionReason,
		canStop: isLiveRawState(job.status),
		asyncDir: job.asyncDir,
		pid: job.pid,
		currentTool: job.currentTool,
		currentPath: job.currentPath,
		activityDetail: pickActivityDetail({
			currentTool: job.currentTool,
			currentPath: job.currentPath,
			watchdogSnapshot: undefined,
			pendingSupervisorReason: pendingRequest?.reason,
			needsAttention: attention.needsAttention,
			state,
		}),
		startedAt,
		updatedAt,
		tokens: job.totalTokens?.total,
		tokenUsage: job.totalTokens,
		toolCount: job.toolCount,
		turnCount: job.turnCount,
	};

	const stepEntries = (job.steps ?? []).map((step, index) =>
		normalizeAsyncStep({
			runId: job.asyncId,
			parentKey,
			index: step.index ?? index,
			agent: step.agent,
			status: step.status,
			activityState: step.activityState,
			watchdog: step.watchdog,
			currentTool: step.currentTool,
			currentPath: step.currentPath,
			turnCount: step.turnCount,
			toolCount: step.toolCount,
			tokens: step.tokens,
			startedAt: step.startedAt,
			endedAt: step.endedAt,
			lastActivityAt: step.lastActivityAt,
			transcriptPath: step.transcriptPath,
			transcriptPathMaybeStale: false,
			model: step.model,
			thinking: step.thinking,
			now: ctx.now,
		}),
	);

	return [parentEntry, ...stepEntries];
}

/**
 * Normalisiert einen Eintrag aus listAsyncRuns() (Disk-Scan). Wird nur fuer
 * asyncIds verwendet, die NICHT bereits in state.asyncJobs stehen (Dedupe
 * durch den Aufrufer) - noetig, weil abgeschlossene Jobs dort nach 10s
 * verschwinden (kind:"recent" jenseits dieses Fensters kommt ausschliesslich
 * von hier). KNOWN GAP 3 gilt fuer alle Step-Zeilen dieser Funktion.
 */
export function normalizeAsyncRunSummary(run: AsyncRunSummary, ctx: { now: number }): FleetAgentEntry[] {
	const attention = resolveAttention({
		lifecycleTerminal: !isLiveRawState(run.state),
		controlActivityState: run.activityState,
		watchdogSnapshot: undefined,
		hasPendingSupervisorRequest: false,
	});
	const state = attention.stateOverride ?? mapRawStateToFleetState(run.state);
	const updatedAt = run.lastUpdate ?? run.startedAt ?? ctx.now;
	const parentKey = `async:${run.id}`;

	const parentEntry: FleetAgentEntry = {
		key: parentKey,
		runId: run.id,
		source: "async",
		kind: isLiveRawState(run.state) ? "active" : "recent",
		depth: 0,
		agent: run.mode === "single" && run.steps[0]?.agent ? run.steps[0].agent : run.mode,
		mode: run.mode,
		state,
		needsAttention: attention.needsAttention,
		attentionReason: attention.attentionReason,
		canStop: isLiveRawState(run.state),
		asyncDir: run.asyncDir,
		currentTool: run.currentTool,
		currentPath: run.currentPath,
		activityDetail: pickActivityDetail({
			currentTool: run.currentTool,
			currentPath: run.currentPath,
			watchdogSnapshot: undefined,
			pendingSupervisorReason: undefined,
			needsAttention: attention.needsAttention,
			state,
		}),
		startedAt: run.startedAt,
		updatedAt,
		tokens: run.totalTokens?.total,
		tokenUsage: run.totalTokens,
		toolCount: run.toolCount,
		turnCount: run.turnCount,
	};

	const terminal = state === "completed" || state === "error" || state === "stopped" || state === "paused";
	const stepEntries = run.steps.map((step, index) =>
		normalizeAsyncStep({
			runId: run.id,
			parentKey,
			index,
			agent: step.agent,
			status: step.status,
			activityState: step.activityState,
			watchdog: undefined, // KNOWN GAP 3
			currentTool: step.currentTool,
			currentPath: step.currentPath,
			turnCount: step.turnCount,
			toolCount: step.toolCount,
			tokens: step.tokens,
			startedAt: undefined,
			endedAt: undefined,
			lastActivityAt: step.lastActivityAt,
			transcriptPath: undefined, // KNOWN GAP 3
			transcriptPathMaybeStale: terminal,
			model: step.model,
			thinking: step.thinking,
			now: ctx.now,
		}),
	);

	return [parentEntry, ...stepEntries];
}

interface NestedContext {
	now: number;
	source: "foreground" | "async";
	rootRunId: string;
}

const NESTED_MAX_DEPTH = 3; // mirrors MAX_DEPTH in nested-events.ts (nicht re-exportiert).

function isLiveNestedState(state: NestedRunSummary["state"]): boolean {
	return state === "running" || state === "queued";
}

/**
 * Normalisiert einen Nested-Run rekursiv (bis NESTED_MAX_DEPTH), liefert
 * aber eine FLACHE Liste (Run-Zeile + Step-Zeilen + rekursive Kind-Zeilen).
 * runId bleibt ueber die gesamte Rekursion die des Wurzel-Laufs (ctx.rootRunId),
 * NICHT run.parentRunId, das sich pro Ebene aendert.
 */
export function normalizeNestedRun(run: NestedRunSummary, parentKey: string, depth: number, ctx: NestedContext): FleetAgentEntry[] {
	if (depth > NESTED_MAX_DEPTH) return [];

	const key = `nested:${run.id}`;
	const terminal = run.state === "complete" || run.state === "failed" || run.state === "paused" || run.state === "stopped";
	const lastStepWatchdog = run.steps?.length ? run.steps[run.steps.length - 1]?.watchdog : undefined;
	const attention = resolveAttention({
		lifecycleTerminal: terminal,
		controlActivityState: run.activityState,
		watchdogSnapshot: lastStepWatchdog,
		hasPendingSupervisorRequest: false,
	});
	const state = attention.stateOverride ?? mapRawStateToFleetState(run.state);
	const updatedAt = run.lastUpdate ?? run.endedAt ?? run.startedAt ?? ctx.now;
	const startedAt = run.startedAt ?? updatedAt;

	const entry: FleetAgentEntry = {
		key,
		runId: ctx.rootRunId,
		source: ctx.source,
		kind: isLiveNestedState(run.state) ? "active" : "recent",
		parentKey,
		depth,
		agent: run.agent ?? run.mode ?? "nested",
		mode: run.mode,
		state,
		needsAttention: attention.needsAttention,
		attentionReason: attention.attentionReason,
		canStop: false,
		currentTool: run.currentTool,
		currentPath: run.currentPath,
		activityDetail: pickActivityDetail({
			currentTool: run.currentTool,
			currentPath: run.currentPath,
			watchdogSnapshot: lastStepWatchdog,
			pendingSupervisorReason: undefined,
			needsAttention: attention.needsAttention,
			state,
		}),
		startedAt,
		updatedAt,
		tokens: run.totalTokens?.total,
		tokenUsage: run.totalTokens,
		toolCount: run.toolCount,
		turnCount: run.turnCount,
	};

	const stepEntries = (run.steps ?? []).flatMap((step, index) => normalizeNestedStep(step, key, index, depth + 1, ctx));
	const childRunEntries = (run.children ?? []).flatMap((child) => normalizeNestedRun(child, key, depth + 1, ctx));

	return [entry, ...stepEntries, ...childRunEntries];
}

function normalizeNestedStep(step: NestedStepSummary, parentKey: string, index: number, depth: number, ctx: NestedContext): FleetAgentEntry[] {
	const stepKey = `${parentKey}:step:${index}`;
	const terminal = step.status === "complete" || step.status === "completed" || step.status === "failed" || step.status === "paused" || step.status === "stopped";
	const attention = resolveAttention({
		lifecycleTerminal: terminal,
		controlActivityState: step.activityState,
		watchdogSnapshot: step.watchdog,
		hasPendingSupervisorRequest: false,
	});
	const state = attention.stateOverride ?? mapRawStateToFleetState(step.status);
	const updatedAt = step.lastActivityAt ?? step.endedAt ?? step.startedAt ?? ctx.now;
	const startedAt = step.startedAt ?? updatedAt;

	const entry: FleetAgentEntry = {
		key: stepKey,
		runId: ctx.rootRunId,
		source: ctx.source,
		// Nested-Steps haben kein eigenes id-Feld - Index-basierter Pseudo-Key, stabil
		// solange Chain-Step-Arrays append-only/positionsfest bleiben (Annahme, siehe Doku-Kopf).
		kind: step.status === "running" || step.status === "pending" ? "active" : "recent",
		parentKey,
		depth,
		agent: step.agent,
		state,
		needsAttention: attention.needsAttention,
		attentionReason: attention.attentionReason,
		canStop: false,
		currentTool: step.currentTool,
		currentPath: step.currentPath,
		activityDetail: pickActivityDetail({
			currentTool: step.currentTool,
			currentPath: step.currentPath,
			watchdogSnapshot: step.watchdog,
			pendingSupervisorReason: undefined,
			needsAttention: attention.needsAttention,
			state,
		}),
		startedAt,
		updatedAt,
		transcriptPath: step.transcriptPath,
	};

	const childEntries = (step.children ?? []).flatMap((child) => normalizeNestedRun(child, stepKey, depth + 1, ctx));
	return [entry, ...childEntries];
}

export interface BuildFleetEntriesDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	pending?: FleetPendingSupervisorRequest[];
	now?: () => number;
	recentAsyncLimit?: number;
}

const DEFAULT_RECENT_ASYNC_LIMIT = 20;

/**
 * Haupt-Entrypoint: baut die vollstaendige, flache FleetAgentEntry-Liste aus
 * allen Runtime-Quellen (Foreground aktiv/recent, Async aktiv/recent,
 * Nested-Kinder beider Wurzeln).
 */
export function buildFleetEntries(state: SubagentState, deps: BuildFleetEntriesDeps = {}): FleetAgentEntry[] {
	const now = deps.now?.() ?? Date.now();
	const pending = deps.pending ?? [];
	const entries: FleetAgentEntry[] = [];

	const activeRunIds = new Set(state.foregroundControls.keys());
	for (const control of state.foregroundControls.values()) {
		const activeEntry = normalizeForegroundActive(control, { pending, now });
		entries.push(activeEntry);
		for (const child of control.nestedChildren ?? []) {
			entries.push(...normalizeNestedRun(child, activeEntry.key, 1, { now, source: "foreground", rootRunId: control.runId }));
		}
	}

	for (const run of state.foregroundRuns?.values() ?? []) {
		entries.push(...normalizeForegroundRecent(run, activeRunIds));
	}

	for (const job of state.asyncJobs.values()) {
		const jobEntries = normalizeAsyncJobState(job, { pending, now });
		entries.push(...jobEntries);
		const parentEntry = jobEntries[0];
		for (const child of job.nestedChildren ?? []) {
			entries.push(...normalizeNestedRun(child, parentEntry.key, 1, { now, source: "async", rootRunId: job.asyncId }));
		}
	}

	const knownAsyncIds = new Set(state.asyncJobs.keys());
	let recentRuns: AsyncRunSummary[] = [];
	try {
		recentRuns = listAsyncRuns(deps.asyncDirRoot ?? ASYNC_DIR, {
			states: ["complete", "failed", "paused", "stopped"],
			sessionId: state.currentSessionId ?? undefined,
			resultsDir: deps.resultsDir ?? RESULTS_DIR,
			limit: deps.recentAsyncLimit ?? DEFAULT_RECENT_ASYNC_LIMIT,
		});
	} catch {
		// Ein Disk-Scan-Fehler liefert still eine leere recent-Liste statt zu werfen -
		// vertretbar fuer eine reine Anzeige-Projektionsschicht.
		recentRuns = [];
	}
	for (const run of recentRuns) {
		if (knownAsyncIds.has(run.id)) continue;
		const runEntries = normalizeAsyncRunSummary(run, { now });
		entries.push(...runEntries);
		const parentEntry = runEntries[0];
		for (const child of run.nestedChildren ?? []) {
			entries.push(...normalizeNestedRun(child, parentEntry.key, 1, { now, source: "async", rootRunId: run.id }));
		}
	}

	return entries;
}
