import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChildEnv, validateChildEnvConfig } from "../../src/shared/child-env.ts";

describe("buildChildEnv", () => {
	it("filters credential segments and agent sockets while retaining ordinary variables", () => {
		const env = buildChildEnv({
			GITHUB_TOKEN: "secret",
			db_password: "secret",
			APP_CLIENT_SECRET: "secret",
			AWS_PRIVATE_KEY: "secret",
			SSH_AUTH_SOCK: "/socket",
			GPG_AGENT_INFO: "agent",
			GNOME_KEYRING_CONTROL: "keyring",
			OPENAI_API_KEY: "provider-key",
			ANTHROPIC_OAUTH_TOKEN: "provider-oauth",
			HF_TOKEN: "provider-token",
			PATH: "/bin",
			HOME: "/home/test",
			NIX_STORE: "/nix/store",
			SSL_CERT_FILE: "/certs",
			PI_SUBAGENT_DEPTH: "2",
			PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: "nested-route",
			HTTPS_PROXY: "http://proxy",
		});
		assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_OAUTH_TOKEN", "HF_TOKEN", "HOME", "HTTPS_PROXY", "NIX_STORE", "OPENAI_API_KEY", "PATH", "PI_SUBAGENT_DEPTH", "PI_SUBAGENT_PARENT_CAPABILITY_TOKEN", "SSL_CERT_FILE"].sort());
	});

	it("supports exact allow and deny overrides, and explicit values always win", () => {
		const env = buildChildEnv(
			{ GH_TOKEN: "inherited", KEEP_ME: "old", DROP_ME: "old" },
			{ GH_TOKEN: "explicit", DROP_ME: "explicit", PI_SUBAGENT_DEPTH: "3" },
			{ allow: ["GH_TOKEN"], deny: ["KEEP_ME"] },
		);
		assert.deepEqual(env, { GH_TOKEN: "explicit", DROP_ME: "explicit", PI_SUBAGENT_DEPTH: "3" });
	});

	it("validates childEnv lists and ignores invalid shapes", () => {
		assert.deepEqual(validateChildEnvConfig({ deny: ["PASSWORD"], allow: ["SAFE"] }), { deny: ["PASSWORD"], allow: ["SAFE"] });
		assert.deepEqual(validateChildEnvConfig({ deny: "PASSWORD", allow: [1] }), {});
		assert.equal(validateChildEnvConfig([]), undefined);
	});
});
