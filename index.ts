import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXTENSION_NAME = "anthropic-metadata-user-id";
const STATE_FILE = process.env.PI_ANTHROPIC_METADATA_STATE_FILE || join(
	homedir(),
	".pi",
	"agent",
	"extensions",
	EXTENSION_NAME,
	"state.json",
);
const ACCOUNT_UUID = process.env.PI_METADATA_ACCOUNT_UUID ?? "";

const CLAUDE_CODE_NPM_LATEST_URL = "https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest";
const FALLBACK_CLAUDE_CODE_VERSION = "2.1.170";
const VERSION_FETCH_TIMEOUT_MS = Number(process.env.PI_CLAUDE_CODE_VERSION_FETCH_TIMEOUT_MS ?? "1500");
const USER_AGENT_HEADER = "user-agent";
const SESSION_ID_HEADER = "X-Claude-Code-Session-Id";
const MCP_TOOL_PREFIX = "mcp__";
const PI_NATIVE_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const FALLBACK_THINKING_EFFORT = "low";
const THINKING_EFFORT_BY_LEVEL: Record<string, string> = {
	off: "low",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

interface DeviceState {
	version: 1;
	device_id: string;
	source: "crypto.randomBytes(32)";
	created_at: string;
}

interface ProviderRequestConfig {
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
}

interface ProviderModel {
	api?: string;
	provider?: string;
}

function createDeviceId(): string {
	return randomBytes(32).toString("hex");
}

function isDeviceId(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function readDeviceState(path: string): DeviceState {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DeviceState>;
	if (parsed.version !== 1 || !isDeviceId(parsed.device_id)) {
		throw new Error(`Invalid ${EXTENSION_NAME} state file: ${path}`);
	}
	return parsed as DeviceState;
}

function writeDeviceState(path: string, deviceId: string): void {
	const state: DeviceState = {
		version: 1,
		device_id: deviceId,
		source: "crypto.randomBytes(32)",
		created_at: new Date().toISOString(),
	};

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
}

function loadOrCreateDeviceId(): string {
	if (existsSync(STATE_FILE)) {
		return readDeviceState(STATE_FILE).device_id;
	}

	const deviceId = createDeviceId();
	try {
		writeDeviceState(STATE_FILE, deviceId);
	} catch (err) {
		if ((err as { code?: string }).code === "EEXIST") {
			return readDeviceState(STATE_FILE).device_id;
		}
		throw err;
	}
	return deviceId;
}

const DEVICE_ID = loadOrCreateDeviceId();
const toolNameMap = new Map<string, string>();
const registeredHeaderState = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isVersion(value: unknown): value is string {
	return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

async function resolveClaudeCodeVersion(): Promise<string> {
	if (isVersion(process.env.PI_CLAUDE_CODE_VERSION)) {
		return process.env.PI_CLAUDE_CODE_VERSION;
	}

	if (typeof fetch !== "function") {
		return FALLBACK_CLAUDE_CODE_VERSION;
	}

	const timeoutMs = Number.isFinite(VERSION_FETCH_TIMEOUT_MS) && VERSION_FETCH_TIMEOUT_MS > 0
		? VERSION_FETCH_TIMEOUT_MS
		: 1500;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(CLAUDE_CODE_NPM_LATEST_URL, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return FALLBACK_CLAUDE_CODE_VERSION;

		const body = await response.json() as { version?: unknown };
		return isVersion(body.version) ? body.version : FALLBACK_CLAUDE_CODE_VERSION;
	} catch {
		return FALLBACK_CLAUDE_CODE_VERSION;
	} finally {
		clearTimeout(timeout);
	}
}

function buildUserAgent(version: string): string {
	return `claude-cli/${version} (external, cli)`;
}

function isAnthropicMessagesModel(model: unknown): model is ProviderModel {
	return isRecord(model) && model.api === "anthropic-messages" && typeof model.provider === "string";
}

function rememberToolName(providerName: string, originalName: string): string {
	if (providerName !== originalName) {
		toolNameMap.set(providerName, originalName);
	}
	return providerName;
}

function capitalizeNativeToolName(name: string): string {
	if (name.length === 0) return name;
	return `${name[0].toUpperCase()}${name.slice(1)}`;
}

function rewriteToolNameForProvider(name: string): string {
	if (PI_NATIVE_TOOL_NAMES.has(name)) {
		return rememberToolName(capitalizeNativeToolName(name), name);
	}

	if (name.startsWith(MCP_TOOL_PREFIX)) {
		toolNameMap.set(name, name);
		return name;
	}

	return rememberToolName(`${MCP_TOOL_PREFIX}${name}`, name);
}

function restoreToolName(name: string): string {
	const exact = toolNameMap.get(name);
	if (exact) return exact;
	if (name.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);

	const nativeName = name.toLowerCase();
	if (PI_NATIVE_TOOL_NAMES.has(nativeName)) return nativeName;

	return name;
}

function rewriteRecordName(
	record: Record<string, unknown>,
	rewrite: (name: string) => string,
): Record<string, unknown> {
	if (typeof record.name !== "string") return record;

	const nextName = rewrite(record.name);
	return nextName === record.name ? record : { ...record, name: nextName };
}

function rewriteToolDefinitionsForProvider(tools: unknown): unknown {
	if (!Array.isArray(tools)) return tools;
	return tools.map((tool) => isRecord(tool) ? rewriteRecordName(tool, rewriteToolNameForProvider) : tool);
}

function rewriteToolChoiceForProvider(toolChoice: unknown): unknown {
	if (!isRecord(toolChoice)) return toolChoice;
	return rewriteRecordName(toolChoice, rewriteToolNameForProvider);
}

function rewriteAnthropicMessageToolUseNamesForProvider(message: unknown): unknown {
	if (!isRecord(message) || !Array.isArray(message.content)) return message;

	let changed = false;
	const content = message.content.map((block) => {
		if (!isRecord(block) || block.type !== "tool_use") return block;
		const nextBlock = rewriteRecordName(block, rewriteToolNameForProvider);
		if (nextBlock !== block) changed = true;
		return nextBlock;
	});

	return changed ? { ...message, content } : message;
}

function getSelectedThinkingEffort(pi: ExtensionAPI): string {
	const thinkingLevel = pi.getThinkingLevel();
	return THINKING_EFFORT_BY_LEVEL[thinkingLevel] ?? FALLBACK_THINKING_EFFORT;
}

function rewritePayloadForProvider(payload: Record<string, unknown>, thinkingEffort: string): Record<string, unknown> {
	const next: Record<string, unknown> = {
		...payload,
		thinking: { type: "adaptive" },
		output_config: { effort: thinkingEffort },
	};

	if (Array.isArray(payload.tools)) {
		next.tools = rewriteToolDefinitionsForProvider(payload.tools);
	}

	if (isRecord(payload.tool_choice)) {
		next.tool_choice = rewriteToolChoiceForProvider(payload.tool_choice);
	}

	if (Array.isArray(payload.messages)) {
		next.messages = payload.messages.map(rewriteAnthropicMessageToolUseNamesForProvider);
	}

	return next;
}

function isToolCallBlock(block: unknown): block is Record<string, unknown> {
	return isRecord(block) && (block.type === "toolCall" || block.type === "tool_use");
}

function restoreAgentMessageToolCallNames(message: unknown): unknown | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;

	let changed = false;
	const content = message.content.map((block) => {
		if (!isToolCallBlock(block)) return block;
		const nextBlock = rewriteRecordName(block, restoreToolName);
		if (nextBlock !== block) changed = true;
		return nextBlock;
	});

	return changed ? { ...message, content } : undefined;
}

function restoreAgentMessageToolCallNamesInPlace(message: unknown): boolean {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return false;

	let changed = false;
	for (const block of message.content) {
		if (!isToolCallBlock(block) || typeof block.name !== "string") continue;

		const nextName = restoreToolName(block.name);
		if (nextName === block.name) continue;

		block.name = nextName;
		changed = true;
	}
	return changed;
}

function readProviderRequestConfig(ctx: ExtensionContext, provider: string): ProviderRequestConfig | undefined {
	const registry = ctx.modelRegistry as unknown as {
		providerRequestConfigs?: Map<string, ProviderRequestConfig>;
	};
	const configs = registry.providerRequestConfigs;
	return configs instanceof Map ? configs.get(provider) : undefined;
}

async function resolveProviderRequestConfig(ctx: ExtensionContext, provider: string): Promise<ProviderRequestConfig> {
	const existing = readProviderRequestConfig(ctx, provider);
	if (existing?.apiKey !== undefined) return existing;

	const registry = ctx.modelRegistry as unknown as {
		getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	};
	const apiKey = await registry.getApiKeyForProvider?.call(ctx.modelRegistry, provider);
	return {
		...existing,
		apiKey: apiKey ?? existing?.apiKey,
	};
}

function buildClaudeCodeHeaders(
	existingHeaders: Record<string, string> | undefined,
	userAgent: string,
	sessionId: string,
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(existingHeaders ?? {})) {
		const normalized = key.toLowerCase();
		if (normalized === USER_AGENT_HEADER || normalized === SESSION_ID_HEADER.toLowerCase()) continue;
		headers[key] = value;
	}

	headers[USER_AGENT_HEADER] = userAgent;
	headers[SESSION_ID_HEADER] = sessionId;
	return headers;
}

async function syncClaudeCodeHeaders(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	model: unknown,
	userAgent: string,
): Promise<void> {
	if (!isAnthropicMessagesModel(model)) return;

	const provider = model.provider;
	const sessionId = ctx.sessionManager.getSessionId();
	const existing = await resolveProviderRequestConfig(ctx, provider);
	const headers = buildClaudeCodeHeaders(existing.headers, userAgent, sessionId);
	const cacheKey = JSON.stringify({ apiKey: existing.apiKey, authHeader: existing.authHeader, headers });

	if (registeredHeaderState.get(provider) === cacheKey) return;

	const config: ProviderRequestConfig = { headers };
	if (existing.apiKey !== undefined) config.apiKey = existing.apiKey;
	if (existing.authHeader !== undefined) config.authHeader = existing.authHeader;

	pi.registerProvider(provider, config);
	registeredHeaderState.set(provider, cacheKey);
}

export default async function (pi: ExtensionAPI) {
	const claudeCodeVersion = await resolveClaudeCodeVersion();
	const userAgent = buildUserAgent(claudeCodeVersion);

	pi.on("session_start", async (_event, ctx) => {
		await syncClaudeCodeHeaders(pi, ctx, ctx.model, userAgent);
	});

	pi.on("model_select", async (event, ctx) => {
		await syncClaudeCodeHeaders(pi, ctx, event.model, userAgent);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await syncClaudeCodeHeaders(pi, ctx, ctx.model, userAgent);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.api !== "anthropic-messages") return;
		if (!isRecord(event.payload)) return;

		const existingMetadata = isRecord(event.payload.metadata) ? event.payload.metadata : {};
		const sessionId = ctx.sessionManager.getSessionId();
		const payload = rewritePayloadForProvider(event.payload, getSelectedThinkingEffort(pi));

		return {
			...payload,
			metadata: {
				...existingMetadata,
				user_id: JSON.stringify({
					device_id: DEVICE_ID,
					account_uuid: ACCOUNT_UUID,
					session_id: sessionId,
				}),
			},
		};
	});

	pi.on("message_update", (event, _ctx) => {
		restoreAgentMessageToolCallNamesInPlace(event.message);
	});

	pi.on("message_end", (event, _ctx) => {
		const message = restoreAgentMessageToolCallNames(event.message);
		return message ? { message: message as typeof event.message } : undefined;
	});
}
