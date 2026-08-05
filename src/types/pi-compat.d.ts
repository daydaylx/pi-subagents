export {};

/**
 * Compatibility declaration for older supported Pi peer versions.
 *
 * Pi's runtime and newer agent-core declarations expose `isError` on tool
 * results. Older peer declarations omit it, although this extension uses the
 * field in its existing result and status paths.
 */
declare module "@earendil-works/pi-agent-core" {
	interface AgentToolResult<T> {
		isError?: boolean;
	}
}
