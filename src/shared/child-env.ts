import type { ChildEnvConfig } from "./types/execution-options.ts";

const CREDENTIAL_SEGMENTS = new Set(["TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "CREDENTIAL", "CREDENTIALS"]);
const SENSITIVE_EXACT_NAMES = new Set(["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "GNOME_KEYRING_CONTROL"]);
/** Provider authentication the child engine reads from the environment (pi-ai env-api-keys); never filtered. */
const PROVIDER_AUTH_NAMES = new Set([
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"COPILOT_GITHUB_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_SESSION_TOKEN",
	"HF_TOKEN",
]);

export function validateChildEnvConfig(value: unknown): ChildEnvConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const list = (candidate: unknown): string[] | undefined =>
		Array.isArray(candidate) && candidate.every((name) => typeof name === "string") ? candidate : undefined;
	return { ...(list(input.deny) ? { deny: list(input.deny) } : {}), ...(list(input.allow) ? { allow: list(input.allow) } : {}) };
}

function isSensitiveEnvName(name: string, deny: Set<string>, allow: Set<string>): boolean {
	if (allow.has(name)) return false;
	if (deny.has(name)) return true;
	if (PROVIDER_AUTH_NAMES.has(name.toUpperCase())) return false;
	if (/^PI_/i.test(name)) return false;
	if (SENSITIVE_EXACT_NAMES.has(name.toUpperCase())) return true;
	const segments = name.toUpperCase().split("_");
	return segments.some((segment, index) =>
		CREDENTIAL_SEGMENTS.has(segment) || (segment === "PRIVATE" && segments[index + 1] === "KEY"),
	);
}

/** Remove credential-like inherited values while preserving explicit engine values. */
export function buildChildEnv(
	inherited: Record<string, string | undefined>,
	explicit: Record<string, string | undefined> = {},
	config?: ChildEnvConfig,
): Record<string, string | undefined> {
	const deny = new Set(config?.deny ?? []);
	const allow = new Set(config?.allow ?? []);
	const env: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(inherited)) {
		if (value !== undefined && !isSensitiveEnvName(name, deny, allow)) env[name] = value;
	}
	return Object.assign(env, explicit);
}
