import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FLEET_DOCK_WIDGET_KEY, type ExtensionConfig, type SubagentState } from "../../shared/types.ts";
import { createFleetDockController } from "./fleet-dock-controller.ts";

function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("Extension context no longer active");
}

export interface FleetDockWiring {
	readonly fleetViewEnabled: boolean;
	onSessionStart(ctx: ExtensionContext): void;
	onToolResult(ctx: ExtensionContext): void;
	dispose(): void;
}

export function createFleetDockWiring(state: SubagentState, config: ExtensionConfig): FleetDockWiring {
	const fleetViewEnabled = config.ui?.fleetView === true;
	const placement = config.ui?.fleetViewPlacement ?? "belowEditor";
	const controller = fleetViewEnabled ? createFleetDockController(state) : undefined;

	function onSessionStart(ctx: ExtensionContext): void {
		if (!controller || !ctx.hasUI) return;
		ctx.ui.setWidget(FLEET_DOCK_WIDGET_KEY, (_tui, theme) => controller.createComponent(theme), { placement });
	}

	function onToolResult(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !controller) return;
		controller.invalidateCache();
		// Tool results can change foreground and nested projections before the next poll.
		(ctx.ui as ExtensionContext["ui"] & { requestRender?: () => void }).requestRender?.();
	}

	function dispose(): void {
		if (!controller) return;
		try {
			if (state.lastUiContext?.hasUI) state.lastUiContext.ui.setWidget(FLEET_DOCK_WIDGET_KEY, undefined);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	}

	return { fleetViewEnabled, onSessionStart, onToolResult, dispose };
}
