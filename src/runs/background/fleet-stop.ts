/**
 * Fleet Stop-Dispatch (PHASE-06).
 *
 * Bindet die Dock/Inspector-Stop-Aktion an den bestehenden, dateibasierten
 * Control-Kanal aus control-channel.ts an - keine neue Orchestrierungslogik,
 * kein direktes Signal/process.kill, nur ein neuer Aufrufer desselben Kanals,
 * den subagent-executor.ts (action="stop") und rpc.ts ("stop"-RPC) bereits
 * nutzen.
 *
 * Bewusst auf source==="async" beschraenkt (siehe KNOWN GAP 7 in
 * fleet-projection.ts): das ist der einzige Fleet-Eintragstyp mit einem
 * echten, terminalen "stopped"-Kanal. Foreground kennt strukturell nur
 * Interrupt (pausiert, nicht terminal - subagent-executor.ts lehnt
 * action="stop" fuer foreground/nested explizit ab, siehe deren Fehlertext
 * "action='stop' supports async runs only"). Eine neue Foreground-Stop-
 * Semantik zu erfinden waere neue Orchestrierungslogik und damit ausserhalb
 * des Phasen-Scopes (Nicht-Ziel) - Foreground/Nested bleiben daher ohne
 * Dock/Inspector-Stop-Aktion, entsprechend canStop-Semantik unveraendert.
 */

import { deliverStopRequest } from "./control-channel.ts";
import type { FleetAgentEntry } from "../shared/fleet-projection.ts";

export interface FleetStopResult {
	ok: boolean;
	message: string;
}

export type FleetStopDeliverFn = (input: { asyncDir: string; pid?: number; source?: string }) => void;

/**
 * Stoesst einen Stop fuer einen Fleet-Eintrag an. Reiner Dispatch: prueft nur,
 * ob der Eintrag ueberhaupt ueber den bestehenden Kanal stoppbar ist, und
 * ruft dann deliver() (Default: deliverStopRequest) auf. Kein Warten auf die
 * tatsaechliche Zustandsaenderung - die kommt asynchron ueber den naechsten
 * Poller-Tick von async-job-tracker.ts zurueck in state.asyncJobs.
 */
export function requestFleetStop(entry: FleetAgentEntry, deliver: FleetStopDeliverFn = deliverStopRequest): FleetStopResult {
	if (entry.source !== "async") {
		return { ok: false, message: "Nur Async-Laeufe koennen ueber das Dock gestoppt werden." };
	}
	if (!entry.canStop) {
		return { ok: false, message: "Lauf ist nicht mehr aktiv." };
	}
	if (!entry.asyncDir) {
		return { ok: false, message: "Kein Stop-Kanal fuer diesen Eintrag verfuegbar." };
	}
	try {
		deliver({ asyncDir: entry.asyncDir, pid: entry.pid, source: "fleet-dock" });
		return { ok: true, message: "Stop angefordert." };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `Stop fehlgeschlagen: ${message}` };
	}
}
