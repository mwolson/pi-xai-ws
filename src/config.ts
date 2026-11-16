import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LIVENESS_TIMEOUT_MS, DEFAULT_PING_INTERVAL_MS } from "./liveness.ts";

export const DEFAULT_WS_URL = "wss://api.x.ai/v1/responses";
export const DEFAULT_LOOP_NOVELTY_THRESHOLD = 0.85;
export const DEFAULT_LOOP_RECOVERY_LIMIT = 2;
export const DEFAULT_LOOP_RECOVERY_COOLDOWN_MS = 10 * 60_000;
export const DEFAULT_LOOP_RECOVERY_BUDGET_MS = 30 * 60_000;
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_WS_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_WS_MAX_AGE_MS = 24 * 60_000;
export const XAI_WS_CONFIG_FILENAME = "pi-xai-ws.json";

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

function ratio(value: unknown): number | undefined {
    if (typeof value === "string" && value.trim() !== "") {
        value = Number(value);
    }
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
        ? value
        : undefined;
}

export function cacheAffinityEnabled(cacheRetention?: string): boolean {
    return cacheRetention !== "none";
}

/**
 * Stored-response continuation (`store: true` plus `previous_response_id`)
 * lets xAI retain Responses state server-side so later calls send only new
 * input items. Off by default: retention is a privacy tradeoff the caller
 * must opt into explicitly.
 */
export function storeResponsesEnabled(configPath?: string): boolean {
    const envValue = process.env.PI_XAI_WS_STORE;
    if (envValue !== undefined) {
        const normalized = envValue.trim().toLowerCase();
        return normalized === "1" || normalized === "true";
    }
    return readGlobalConfig(configPath)?.storeResponses === true;
}

export function resolveLoopNoveltyThreshold(configPath?: string): number {
    const envValue = ratio(process.env.PI_XAI_WS_LOOP_NOVELTY_THRESHOLD);
    if (envValue !== undefined) {
        return envValue;
    }
    const configured = readGlobalConfig(configPath)?.loopNoveltyThreshold;
    return ratio(configured) ?? DEFAULT_LOOP_NOVELTY_THRESHOLD;
}

/**
 * Automatic-recovery budget for repetitive Grok output.
 *
 * `limit` caps how many automatic recoveries may be granted inside `budgetMs`.
 * `cooldownMs` is the minimum gap between two of them. A `limit` of zero keeps
 * detection and abort but never compacts or steers. A `budgetMs` of zero keeps
 * a spent budget spent for the life of the session.
 *
 * The limit binds only when `budgetMs` exceeds `limit x cooldownMs`, because a
 * shorter window cannot hold more recoveries than the limit at the cooldown
 * rate. The default equals `(limit + 1) x cooldownMs`, leaving one spare
 * cooldown inside the window.
 */
export type LoopRecoveryPolicy = {
    budgetMs: number;
    cooldownMs: number;
    limit: number;
};

/**
 * Resolves the automatic-recovery budget. Environment values win over the
 * global package config, and invalid values fall through to the next source.
 *
 * The default budget is a rolling window: each recovery ages out individually
 * after `budgetMs`.
 */
export function resolveLoopRecoveryPolicy(configPath?: string): LoopRecoveryPolicy {
    const configured = readGlobalConfig(configPath);
    return {
        budgetMs: nonNegativeInteger(process.env.PI_XAI_WS_LOOP_RECOVERY_BUDGET_MS) ??
            nonNegativeInteger(configured?.loopRecoveryBudgetMs) ??
            DEFAULT_LOOP_RECOVERY_BUDGET_MS,
        cooldownMs: positiveInteger(process.env.PI_XAI_WS_LOOP_RECOVERY_COOLDOWN_MS) ??
            positiveInteger(configured?.loopRecoveryCooldownMs) ??
            DEFAULT_LOOP_RECOVERY_COOLDOWN_MS,
        limit: nonNegativeInteger(process.env.PI_XAI_WS_LOOP_RECOVERY_LIMIT) ??
            nonNegativeInteger(configured?.loopRecoveryLimit) ??
            DEFAULT_LOOP_RECOVERY_LIMIT,
    };
}

/**
 * Optional preemptive stored-context cutoff. Unset by default so SuperGrok
 * stored continuation stays on until xAI rejects a response as too large.
 * Same-socket `store: false` continuation is still rejected on that path.
 */
export function resolveMaxStoredContextTokens(configPath?: string): number | undefined {
    const envValue = positiveInteger(process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS);
    if (envValue !== undefined) {
        return envValue;
    }
    return positiveInteger(readGlobalConfig(configPath)?.maxStoredContextTokens);
}

export function resolveMaxRequestImageBytes(configPath?: string): number {
    const envValue = positiveInteger(process.env.PI_XAI_WS_MAX_REQUEST_IMAGE_BYTES);
    if (envValue !== undefined) {
        return envValue;
    }
    const configured = readGlobalConfig(configPath)?.maxRequestImageBytes;
    return positiveInteger(configured) ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES;
}

function readGlobalConfig(configPath?: string): Record<string, unknown> | undefined {
    let resolvedConfigPath: string | undefined;
    try {
        resolvedConfigPath = configPath ?? join(getAgentDir(), XAI_WS_CONFIG_FILENAME);
        const parsed: unknown = JSON.parse(readFileSync(resolvedConfigPath, "utf8"));
        return isPlainRecord(parsed) ? parsed : undefined;
    } catch (error) {
        if (!isMissingFileError(error) && process.env.PI_XAI_WS_DEBUG === "1") {
            const configLabel = resolvedConfigPath ?? "global config";
            process.stderr.write(`[pi-xai-ws] could not read ${configLabel}; using safe defaults\n`);
        }
        return undefined;
    }
}

function positiveInteger(value: unknown): number | undefined {
    if (typeof value === "string" && value.trim() !== "") {
        value = Number(value);
    }
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
    if (typeof value === "string" && value.trim() !== "") {
        value = Number(value);
    }
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
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

export function resolveRequestLiveness(streamTimeoutMs?: number): {
    pingIntervalMs: number;
    livenessTimeoutMs: number;
} {
    const configuredPingIntervalMs = resolvePingIntervalMs();
    const normalizedStreamTimeoutMs = positiveInteger(streamTimeoutMs);
    if (normalizedStreamTimeoutMs === undefined) {
        return {
            pingIntervalMs: configuredPingIntervalMs,
            livenessTimeoutMs: resolveLivenessTimeoutMs(),
        };
    }
    const pingIntervalMs = Math.min(
        configuredPingIntervalMs,
        Math.max(1, Math.floor(normalizedStreamTimeoutMs / 2)),
    );
    const explicitLivenessTimeoutMs = positiveInteger(
        process.env.PI_XAI_WS_LIVENESS_TIMEOUT_MS,
    );
    return {
        pingIntervalMs,
        livenessTimeoutMs:
            explicitLivenessTimeoutMs ?? Math.max(1, normalizedStreamTimeoutMs - pingIntervalMs),
    };
}

export function resolveWsIdleTimeoutMs(): number {
    return readPositiveInt("PI_XAI_WS_IDLE_TIMEOUT_MS", DEFAULT_WS_IDLE_TIMEOUT_MS);
}

export function resolveWsMaxAgeMs(): number {
    return readPositiveInt("PI_XAI_WS_MAX_AGE_MS", DEFAULT_WS_MAX_AGE_MS);
}

/**
 * One in-turn replay after a replayable socket failure when only
 * reasoning blocks have streamed. On by default; `PI_XAI_WS_REASONING_REPLAY=0`
 * or `=false` disables it for troubleshooting.
 */
export function reasoningReplayEnabled(): boolean {
    const raw = process.env.PI_XAI_WS_REASONING_REPLAY?.trim().toLowerCase();
    return raw !== "0" && raw !== "false";
}
