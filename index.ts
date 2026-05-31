import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

interface DeviceState {
	version: 1;
	device_id: string;
	source: "crypto.randomBytes(32)";
	created_at: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.api !== "anthropic-messages") return;
		if (!isRecord(event.payload)) return;

		const existingMetadata = isRecord(event.payload.metadata) ? event.payload.metadata : {};

		return {
			...event.payload,
			metadata: {
				...existingMetadata,
				user_id: JSON.stringify({
					device_id: DEVICE_ID,
					account_uuid: ACCOUNT_UUID,
					session_id: ctx.sessionManager.getSessionId(),
				}),
			},
		};
	});
}
