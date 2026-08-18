import type { IncomingHttpHeaders } from "node:http";
import WebSocket from "ws";
import { resolveLivenessTimeoutMs, resolvePingIntervalMs } from "./config.ts";
import { SocketLiveness } from "./liveness.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const MAX_QUEUED_EVENTS = 4_096;

const TERMINAL_TYPES = new Set([
    "response.completed",
    "response.incomplete",
    "response.failed",
    "error",
]);

export class XaiWsLivenessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "XaiWsLivenessError";
    }
}

export type OpenXaiEventsOptions = {
    url: string;
    headers: Record<string, string>;
    createPayload: Record<string, unknown>;
    signal?: AbortSignal;
    pingIntervalMs?: number;
    livenessTimeoutMs?: number;
    connectTimeoutMs?: number;
    onOpen?: (response: { status: number; headers: Record<string, string> }) => void | Promise<void>;
};

export function frameToUtf8(data: WebSocket.RawData): string {
    if (typeof data === "string") {
        return data;
    }
    if (Buffer.isBuffer(data)) {
        return data.toString("utf8");
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data).toString("utf8");
    }
    return Buffer.from(data).toString("utf8");
}

export function isPlainEvent(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTerminalEventType(type: string): boolean {
    return TERMINAL_TYPES.has(type);
}

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) {
            continue;
        }
        out[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    return out;
}

function normalizeEvent(payload: Record<string, unknown>): Record<string, unknown> {
    if (payload.type === "error" && payload.message === undefined) {
        const nested = payload.error;
        if (nested && typeof nested === "object") {
            const error = nested as { code?: unknown; message?: unknown };
            return {
                type: "error",
                code: error.code ?? payload.status,
                message: error.message ?? JSON.stringify(nested),
            };
        }
    }
    return payload;
}

function isAbortError(error: Error | undefined): boolean {
    return error?.name === "AbortError" || error?.message === "Request was aborted";
}

export async function* iterateXaiWsEvents(
    options: OpenXaiEventsOptions,
): AsyncGenerator<Record<string, unknown>> {
    const pingIntervalMs = options.pingIntervalMs ?? resolvePingIntervalMs();
    const livenessTimeoutMs = options.livenessTimeoutMs ?? resolveLivenessTimeoutMs();
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    let settle: (() => void) | undefined;
    const wait = () =>
        new Promise<void>((resolve) => {
            settle = resolve;
        });
    const wake = () => {
        settle?.();
        settle = undefined;
    };

    const queue: Record<string, unknown>[] = [];
    let closed: Error | undefined;
    let finished = false;
    let sawTerminal = false;
    let upgradeStatus = 101;
    let upgradeHeaders: Record<string, string> = {};

    const ws = new WebSocket(options.url, {
        headers: options.headers,
        handshakeTimeout: connectTimeoutMs,
    });
    const liveness = new SocketLiveness(
        () => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        },
        (reason) => {
            closed = new XaiWsLivenessError(reason);
            try {
                ws.close(4000, "liveness");
            } catch {
                // ignore
            }
            wake();
        },
        { pingIntervalMs, livenessTimeoutMs },
    );

    const onAbort = () => {
        closed = Object.assign(new Error("Request was aborted"), { name: "AbortError" });
        try {
            ws.close(1000, "abort");
        } catch {
            // ignore
        }
        wake();
    };

    ws.on("upgrade", (response) => {
        upgradeStatus = response.statusCode ?? 101;
        upgradeHeaders = flattenHeaders(response.headers);
    });

    ws.once("open", () => {
        void (async () => {
            if (finished || isAbortError(closed)) {
                return;
            }
            try {
                await options.onOpen?.({ status: upgradeStatus, headers: upgradeHeaders });
                ws.send(JSON.stringify(options.createPayload));
                liveness.start();
            } catch (error) {
                closed = error instanceof Error ? error : new Error(String(error));
            }
            wake();
        })();
    });

    ws.on("message", (data) => {
        if (finished) {
            return;
        }
        liveness.noteInbound();
        try {
            const parsed = JSON.parse(frameToUtf8(data)) as unknown;
            if (!isPlainEvent(parsed)) {
                closed = new Error("xAI WebSocket sent a non-object frame");
            } else {
                const event = normalizeEvent(parsed);
                const type = typeof event.type === "string" ? event.type : "";
                if (isTerminalEventType(type)) {
                    sawTerminal = true;
                }
                if (queue.length >= MAX_QUEUED_EVENTS) {
                    closed = new Error("xAI WebSocket event queue overflow");
                } else {
                    queue.push(event);
                }
            }
        } catch {
            closed = new Error("xAI WebSocket sent invalid JSON");
        }
        wake();
    });

    ws.on("pong", () => {
        if (finished) {
            return;
        }
        liveness.noteInbound();
        wake();
    });

    ws.on("ping", () => {
        if (finished) {
            return;
        }
        liveness.noteInbound();
    });

    ws.on("error", (error) => {
        if (finished || isAbortError(closed)) {
            return;
        }
        closed = error;
        wake();
    });

    ws.on("close", (code, reasonBuf) => {
        if (finished) {
            return;
        }
        const reason = reasonBuf.toString("utf8");
        if (!finished && closed === undefined && !sawTerminal) {
            closed = new Error(
                reason ? `xAI WebSocket closed (${code}): ${reason}` : `xAI WebSocket closed (${code})`,
            );
        }
        wake();
    });

    if (options.signal?.aborted) {
        onAbort();
    } else {
        options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
        finished = true;
        liveness.stop();
        options.signal?.removeEventListener("abort", onAbort);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            try {
                ws.close(1000, "done");
            } catch {
                // ignore
            }
        }
    };

    try {
        while (!finished) {
            if (isAbortError(closed)) {
                throw closed;
            }
            if (queue.length > 0) {
                const event = queue.shift()!;
                const type = typeof event.type === "string" ? event.type : "";
                yield event;
                if (isTerminalEventType(type)) {
                    finished = true;
                    break;
                }
                continue;
            }
            if (closed) {
                throw closed;
            }
            await wait();
        }
    } finally {
        cleanup();
    }
}
