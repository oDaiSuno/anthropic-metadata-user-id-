import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadCreateJiti() {
	try {
		const mod = await import("jiti");
		if (typeof mod.createJiti === "function") return mod.createJiti;
	} catch {
		// Fall back to pi's bundled jiti when dev dependencies are not installed.
	}

	const require = createRequire(import.meta.url);
	const piRoot = process.env.PI_CODING_AGENT_ROOT || "/Users/sundai/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent";
	const mod = require(join(piRoot, "node_modules", "jiti", "lib", "jiti.cjs"));
	return mod.createJiti;
}

const root = mkdtempSync(join(tmpdir(), "pi-anthropic-metadata-user-id-"));
const stateFile = join(root, "state.json");
process.env.PI_ANTHROPIC_METADATA_STATE_FILE = stateFile;
process.env.PI_METADATA_ACCOUNT_UUID = "acct-test";

try {
	const createJiti = await loadCreateJiti();
	const jiti = createJiti(import.meta.url);
	const mod = jiti(join(__dirname, "index.ts"));
	assert.equal(typeof mod.default, "function");

	const handlers = new Map();
	mod.default({
		on(name, handler) {
			handlers.set(name, handler);
		},
	});

	const handler = handlers.get("before_provider_request");
	assert.equal(typeof handler, "function");

	const state = JSON.parse(readFileSync(stateFile, "utf8"));
	assert.equal(state.version, 1);
	assert.match(state.device_id, /^[a-f0-9]{64}$/);
	assert.equal(state.source, "crypto.randomBytes(32)");

	const ctx = {
		model: { api: "anthropic-messages", provider: "anthropic", id: "claude-opus-4-8" },
		sessionManager: { getSessionId: () => "session-test-123" },
	};

	const output = handler(
		{ payload: { model: "claude-opus-4-8", metadata: { keep: "yes" }, stream: true } },
		ctx,
	);

	assert.equal(output.model, "claude-opus-4-8");
	assert.equal(output.stream, true);
	assert.equal(output.metadata.keep, "yes");
	assert.equal(typeof output.metadata.user_id, "string");

	const userId = JSON.parse(output.metadata.user_id);
	assert.equal(userId.device_id, state.device_id);
	assert.equal(userId.account_uuid, "acct-test");
	assert.equal(userId.session_id, "session-test-123");

	const skipped = handler(
		{ payload: { model: "gpt-test", metadata: {} } },
		{ ...ctx, model: { api: "openai-responses", provider: "openai", id: "gpt-test" } },
	);
	assert.equal(skipped, undefined);

	console.log("ok anthropic-metadata-user-id");
} finally {
	rmSync(root, { recursive: true, force: true });
	delete process.env.PI_ANTHROPIC_METADATA_STATE_FILE;
	delete process.env.PI_METADATA_ACCOUNT_UUID;
}
