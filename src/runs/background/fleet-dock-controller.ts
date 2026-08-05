import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { SubagentState } from "../../shared/types.ts";
import { renderFleetDock, MAX_DOCK_ROWS } from "../../tui/fleet-dock.ts";
import { buildFleetEntries, type BuildFleetEntriesDeps, type FleetAgentEntry } from "../shared/fleet-projection.ts";

type Theme = ExtensionContext["ui"]["theme"];

export const DEFAULT_REFRESH_INTERVAL_MS = 250;

export interface FleetDockControllerOptions {
	now?: () => number;
	refreshIntervalMs?: number;
	maxRows?: number;
	deps?: BuildFleetEntriesDeps;
}

export class FleetDockController {
	private cachedEntries: FleetAgentEntry[] = [];
	private cachedAt = Number.NEGATIVE_INFINITY;
	private readonly state: SubagentState;
	private readonly options: FleetDockControllerOptions;

	constructor(state: SubagentState, options: FleetDockControllerOptions = {}) {
		this.state = state;
		this.options = options;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	getEntries(): FleetAgentEntry[] {
		const now = this.now();
		if (now - this.cachedAt < (this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS)) return this.cachedEntries;
		this.cachedEntries = buildFleetEntries(this.state, { now: () => now, ...this.options.deps });
		this.cachedAt = now;
		return this.cachedEntries;
	}

	invalidateCache(): void {
		this.cachedAt = Number.NEGATIVE_INFINITY;
	}

	createComponent(theme: Theme): Component {
		return {
			render: (width: number) => renderFleetDock(this.getEntries(), {
				width,
				theme,
				maxRows: this.options.maxRows ?? MAX_DOCK_ROWS,
				now: this.now(),
			}),
			invalidate: () => {},
		};
	}
}

export function createFleetDockController(state: SubagentState, options?: FleetDockControllerOptions): FleetDockController {
	return new FleetDockController(state, options);
}
