import { DEFAULT_LIVENESS_TIMEOUT_MS, DEFAULT_PING_INTERVAL_MS } from "./liveness.ts";

export const DEFAULT_WS_URL = "wss://api.x.ai/v1/responses";
export const DEFAULT_WS_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_WS_MAX_AGE_MS = 24 * 60_000;

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

export function cacheAffinityEnabled(cacheRetention?: string): boolean {
    return cacheRetention !== "none";
}

function isXaiHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return host === "api.x.ai" || host.endsWith(".api.x.ai") || host === "x.ai" || host.endsWith(".x.ai");
}

export function resolveWsUrl(baseUrl?: string): string {
    const explicit = process.env.PI_XAI_WS_URL?.trim();
    if (explicit) {
        return explicit;
    }
    if (!baseUrl) {
        return DEFAULT_WS_URL;
    }
    let http: URL;
    try {
        http = new URL(baseUrl);
    } catch {
        throw new Error(`pi-xai-ws: invalid model.baseUrl ${baseUrl}`);
    }
    if (!isXaiHost(http.hostname)) {
        throw new Error(
            `pi-xai-ws: model.baseUrl ${baseUrl} is not api.x.ai. Set PI_XAI_WS_URL to the matching WebSocket endpoint.`,
        );
    }
    http.protocol = http.protocol === "http:" ? "ws:" : "wss:";
    const path = http.pathname.replace(/\/$/, "") || "/v1";
    http.pathname = path.endsWith("/responses") ? path : `${path}/responses`;
    http.search = "";
    http.hash = "";
    return http.toString();
}

export function resolvePingIntervalMs(): number {
    return readPositiveInt("PI_XAI_WS_PING_INTERVAL_MS", DEFAULT_PING_INTERVAL_MS);
}

export function resolveLivenessTimeoutMs(): number {
    return readPositiveInt("PI_XAI_WS_LIVENESS_TIMEOUT_MS", DEFAULT_LIVENESS_TIMEOUT_MS);
}

export function resolveWsIdleTimeoutMs(): number {
    return readPositiveInt("PI_XAI_WS_IDLE_TIMEOUT_MS", DEFAULT_WS_IDLE_TIMEOUT_MS);
}

export function resolveWsMaxAgeMs(): number {
    return readPositiveInt("PI_XAI_WS_MAX_AGE_MS", DEFAULT_WS_MAX_AGE_MS);
}
