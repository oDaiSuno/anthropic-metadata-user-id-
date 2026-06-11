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

function addHandler(handlers, name, handler) {
	const list = handlers.get(name) ?? [];
	list.push(handler);
	handlers.set(name, list);
}

function getHandler(handlers, name) {
	const list = handlers.get(name) ?? [];
	assert.equal(list.length, 1, `expected one ${name} handler`);
	return list[0];
}

const root = mkdtempSync(join(tmpdir(), "pi-anthropic-metadata-user-id-"));
const stateFile = join(root, "state.json");
process.env.PI_ANTHROPIC_METADATA_STATE_FILE = stateFile;
process.env.PI_METADATA_ACCOUNT_UUID = "acct-test";
process.env.PI_CLAUDE_CODE_VERSION = "9.8.7";

try {
	const createJiti = await loadCreateJiti();
	const jiti = createJiti(import.meta.url);
	const mod = jiti(join(__dirname, "index.ts"));
	assert.equal(typeof mod.default, "function");

	const handlers = new Map();
	const registrations = [];
	let currentThinkingLevel = "high";
	const providerRequestConfigs = new Map([
		[
			"guda-anthropic",
			{
				apiKey: "$GUDA_KEY",
				authHeader: true,
				headers: {
					"x-existing": "1",
					"User-Agent": "old-agent",
					"x-claude-code-session-id": "old-session",
				},
			},
		],
	]);

	await mod.default({
		on(name, handler) {
			addHandler(handlers, name, handler);
		},
		registerProvider(name, config) {
			registrations.push({ name, config });
			providerRequestConfigs.set(name, {
				apiKey: config.apiKey,
				authHeader: config.authHeader,
				headers: config.headers,
			});
		},
		getThinkingLevel() {
			return currentThinkingLevel;
		},
	});

	const beforeProviderRequest = getHandler(handlers, "before_provider_request");
	const messageUpdate = getHandler(handlers, "message_update");
	const messageEnd = getHandler(handlers, "message_end");
	const sessionStart = getHandler(handlers, "session_start");
	const modelSelect = getHandler(handlers, "model_select");
	const beforeAgentStart = getHandler(handlers, "before_agent_start");

	const state = JSON.parse(readFileSync(stateFile, "utf8"));
	assert.equal(state.version, 1);
	assert.match(state.device_id, /^[a-f0-9]{64}$/);
	assert.equal(state.source, "crypto.randomBytes(32)");

	let currentSessionId = "session-test-123";
	const anthropicModel = { api: "anthropic-messages", provider: "guda-anthropic", id: "claude-opus-4-8" };
	const openaiModel = { api: "openai-responses", provider: "guda-responses", id: "gpt-5.5" };
	const ctx = {
		model: anthropicModel,
		sessionManager: { getSessionId: () => currentSessionId },
		modelRegistry: {
			providerRequestConfigs,
			async getApiKeyForProvider(provider) {
				return providerRequestConfigs.get(provider)?.apiKey;
			},
		},
	};

	await sessionStart({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0].name, "guda-anthropic");
	assert.equal(registrations[0].config.apiKey, "$GUDA_KEY");
	assert.equal(registrations[0].config.authHeader, true);
	assert.equal(registrations[0].config.headers["x-existing"], "1");
	assert.equal(registrations[0].config.headers["user-agent"], "claude-cli/9.8.7 (external, cli)");
	assert.equal(registrations[0].config.headers["X-Claude-Code-Session-Id"], "session-test-123");
	assert.equal("User-Agent" in registrations[0].config.headers, false);
	assert.equal("x-claude-code-session-id" in registrations[0].config.headers, false);

	currentSessionId = "session-test-456";
	await beforeAgentStart({ type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: {} }, ctx);
	assert.equal(registrations.length, 2);
	assert.equal(registrations[1].config.apiKey, "$GUDA_KEY");
	assert.equal(registrations[1].config.authHeader, true);
	assert.equal(registrations[1].config.headers["X-Claude-Code-Session-Id"], "session-test-456");

	const beforeNonAnthropicRegistrations = registrations.length;
	await modelSelect(
		{ type: "model_select", model: openaiModel, previousModel: anthropicModel, source: "set" },
		{ ...ctx, model: openaiModel },
	);
	assert.equal(registrations.length, beforeNonAnthropicRegistrations);

	const output = await beforeProviderRequest(
		{
			type: "before_provider_request",
			payload: {
				model: "claude-opus-4-8",
				metadata: { keep: "yes" },
				stream: true,
				thinking: { type: "enabled", budget_tokens: 16384, display: "summarized" },
				output_config: { effort: "medium", keep: "no" },
				tools: [
					{ name: "read", description: "read files" },
					{ name: "ask_user_question", description: "ask" },
					{ name: "init_experiment", description: "init experiment" },
				],
				tool_choice: { type: "tool", name: "bash" },
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "I'll edit." },
							{ type: "tool_use", id: "toolu_1", name: "edit", input: { path: "a" } },
							{ type: "tool_use", id: "toolu_2", name: "init_experiment", input: { name: "x" } },
						],
					},
				],
			},
		},
		ctx,
	);

	assert.equal(output.model, "claude-opus-4-8");
	assert.equal(output.stream, true);
	assert.equal(output.metadata.keep, "yes");
	assert.equal(typeof output.metadata.user_id, "string");
	assert.deepEqual(output.thinking, { type: "adaptive" });
	assert.deepEqual(output.output_config, { effort: "high" });
	assert.equal(output.tools[0].name, "Read");
	assert.equal(output.tools[1].name, "mcp__ask_user_question");
	assert.equal(output.tools[2].name, "mcp__init_experiment");
	assert.equal(output.tool_choice.name, "Bash");
	assert.equal(output.messages[0].content[1].name, "Edit");
	assert.equal(output.messages[0].content[2].name, "mcp__init_experiment");

	currentThinkingLevel = "xhigh";
	const xhighOutput = await beforeProviderRequest(
		{ type: "before_provider_request", payload: { model: "claude-opus-4-8", metadata: {}, tools: [] } },
		ctx,
	);
	assert.deepEqual(xhighOutput.output_config, { effort: "xhigh" });

	currentThinkingLevel = "minimal";
	const minimalOutput = await beforeProviderRequest(
		{ type: "before_provider_request", payload: { model: "claude-opus-4-8", metadata: {}, tools: [] } },
		ctx,
	);
	assert.deepEqual(minimalOutput.output_config, { effort: "low" });

	const userId = JSON.parse(output.metadata.user_id);
	assert.equal(userId.device_id, state.device_id);
	assert.equal(userId.account_uuid, "acct-test");
	assert.equal(userId.session_id, "session-test-456");

	const streamingMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "Need tools." },
			{ type: "toolCall", id: "call_1", name: "Read", arguments: { path: "a" } },
			{ type: "toolCall", id: "call_2", name: "mcp__ask_user_question", arguments: { question: "?" } },
			{ type: "toolCall", id: "call_3", name: "Edit", arguments: { path: "a" } },
			{ type: "toolCall", id: "call_4", name: "mcp__init_experiment", arguments: { name: "x" } },
		],
		stopReason: "tool_use",
	};
	const messageUpdateResult = await messageUpdate(
		{ type: "message_update", message: streamingMessage, assistantMessageEvent: { type: "toolcall_delta" } },
		ctx,
	);
	assert.equal(messageUpdateResult, undefined);
	assert.equal(streamingMessage.content[1].name, "read");
	assert.equal(streamingMessage.content[2].name, "ask_user_question");
	assert.equal(streamingMessage.content[3].name, "edit");
	assert.equal(streamingMessage.content[4].name, "init_experiment");

	const restored = await messageEnd(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Need tools." },
					{ type: "toolCall", id: "call_1", name: "Read", arguments: { path: "a" } },
					{ type: "toolCall", id: "call_2", name: "mcp__ask_user_question", arguments: { question: "?" } },
					{ type: "toolCall", id: "call_3", name: "Edit", arguments: { path: "a" } },
					{ type: "toolCall", id: "call_4", name: "mcp__init_experiment", arguments: { name: "x" } },
				],
				stopReason: "tool_use",
			},
		},
		ctx,
	);
	assert.equal(restored.message.content[1].name, "read");
	assert.equal(restored.message.content[2].name, "ask_user_question");
	assert.equal(restored.message.content[3].name, "edit");
	assert.equal(restored.message.content[4].name, "init_experiment");

	const skipped = await beforeProviderRequest(
		{ type: "before_provider_request", payload: { model: "gpt-test", metadata: {} } },
		{ ...ctx, model: openaiModel },
	);
	assert.equal(skipped, undefined);

	console.log("ok anthropic-metadata-user-id");
} finally {
	rmSync(root, { recursive: true, force: true });
	delete process.env.PI_ANTHROPIC_METADATA_STATE_FILE;
	delete process.env.PI_METADATA_ACCOUNT_UUID;
	delete process.env.PI_CLAUDE_CODE_VERSION;
}
