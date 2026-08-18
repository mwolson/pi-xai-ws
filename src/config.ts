import { DEFAULT_LIVENESS_TIMEOUT_MS, DEFAULT_PING_INTERVAL_MS } from "./liveness.ts";

export const DEFAULT_WS_URL = "wss://api.x.ai/v1/responses";

function readPositiveInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.floor(value);
}

export function resolveWsUrl(): string {
    return process.env.PI_XAI_WS_URL?.trim() || DEFAULT_WS_URL;
}

export function resolvePingIntervalMs(): number {
    return readPositiveInt("PI_XAI_WS_PING_INTERVAL_MS", DEFAULT_PING_INTERVAL_MS);
}

export function resolveLivenessTimeoutMs(): number {
    return readPositiveInt("PI_XAI_WS_LIVENESS_TIMEOUT_MS", DEFAULT_LIVENESS_TIMEOUT_MS);
}
