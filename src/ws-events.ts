import WebSocket from "ws";
import { resolveLivenessTimeoutMs, resolvePingIntervalMs } from "./config.ts";
import { SocketLiveness } from "./liveness.ts";

const TERMINAL_TYPES = new Set([
    "response.completed",
    "response.incomplete",
    "response.failed",
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
};

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

export async function* iterateXaiWsEvents(
    options: OpenXaiEventsOptions,
): AsyncGenerator<Record<string, unknown>> {
    const pingIntervalMs = options.pingIntervalMs ?? resolvePingIntervalMs();
    const livenessTimeoutMs = options.livenessTimeoutMs ?? resolveLivenessTimeoutMs();

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

    const ws = new WebSocket(options.url, { headers: options.headers, handshakeTimeout: 15_000 });
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

    if (options.signal?.aborted) {
        onAbort();
    } else {
        options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    ws.once("open", () => {
        try {
            ws.send(JSON.stringify(options.createPayload));
            liveness.start();
        } catch (error) {
            closed = error instanceof Error ? error : new Error(String(error));
        }
        wake();
    });

    ws.on("message", (data) => {
        liveness.noteInbound();
        const text = typeof data === "string" ? data : data.toString("utf8");
        try {
            const parsed = JSON.parse(text) as unknown;
            if (parsed && typeof parsed === "object") {
                queue.push(normalizeEvent(parsed as Record<string, unknown>));
            } else {
                closed = new Error("xAI WebSocket sent a non-object frame");
            }
        } catch {
            closed = new Error("xAI WebSocket sent invalid JSON");
        }
        wake();
    });

    ws.on("pong", () => {
        liveness.noteInbound();
        wake();
    });

    ws.on("ping", () => {
        liveness.noteInbound();
    });

    ws.on("error", (error) => {
        closed = error;
        wake();
    });

    ws.on("close", (code, reasonBuf) => {
        const reason = reasonBuf.toString("utf8");
        if (!finished && closed === undefined) {
            closed = new Error(
                reason ? `xAI WebSocket closed (${code}): ${reason}` : `xAI WebSocket closed (${code})`,
            );
        }
        wake();
    });

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
            if (closed) {
                throw closed;
            }
            if (queue.length > 0) {
                const event = queue.shift()!;
                const type = typeof event.type === "string" ? event.type : "";
                yield event;
                if (TERMINAL_TYPES.has(type)) {
                    finished = true;
                    break;
                }
                if (type === "error") {
                    finished = true;
                    break;
                }
                continue;
            }
            await wait();
        }
        if (closed) {
            throw closed;
        }
    } finally {
        cleanup();
    }
}
