import type { IncomingHttpHeaders } from "node:http";
import WebSocket from "ws";
import {
    resolveLivenessTimeoutMs,
    resolvePingIntervalMs,
    resolveWsIdleTimeoutMs,
    resolveWsMaxAgeMs,
} from "./config.ts";
import { SocketLiveness } from "./liveness.ts";
import {
    type ContinuationState,
    type ContinuationRequestContext,
    isContinuationRejection,
    nextContinuationState,
    planStoredRequest as planStoredRequestForChain,
    readStoredResponse,
} from "./continuation.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_INBOUND_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PENDING_SESSION_REQUESTS = 64;
const MAX_QUEUED_EVENTS = 4_096;
const MAX_TIMER_MS = 2_147_000_000;
const REQUEST_AGE_HEADROOM_DIVISOR = 4;
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 15_000;

const TERMINAL_TYPES = new Set([
    "response.completed",
    "response.incomplete",
    "response.failed",
    "error",
]);

const OUTPUT_EVENT_PREFIXES = [
    "response.content_part.",
    "response.custom_tool_call_input.",
    "response.function_call_arguments.",
    "response.output_item.",
    "response.output_text.",
    "response.reasoning",
    "response.refusal.",
];

export class XaiWsTransportError extends Error {
    readonly outputStarted: boolean;
    readonly kind: "connect" | "lifecycle" | "liveness" | "protocol" | "queue" | "socket";

    constructor(
        message: string,
        options: {
            kind?: "connect" | "lifecycle" | "liveness" | "protocol" | "queue" | "socket";
            outputStarted?: boolean;
        } = {},
    ) {
        super(message);
        this.name = "XaiWsTransportError";
        this.kind = options.kind ?? "socket";
        this.outputStarted = options.outputStarted ?? false;
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

export type XaiWsSessionEventsOptions = OpenXaiEventsOptions & {
    sessionId?: string;
    /** Project the finalized assistant response through Pi's wire converter. */
    projectStoredOutput?: () => readonly unknown[] | undefined;
    /** Opt in to `store: true` plus `previous_response_id` continuation. */
    storeResponses?: boolean;
};

export type XaiWsSessionPoolOptions = {
    idleTimeoutMs?: number;
    maxInboundFrameBytes?: number;
    maxPendingRequests?: number;
    maxQueuedBytes?: number;
    maxSocketAgeMs?: number;
};

export type XaiWsDebugCounters = {
    aborts: number;
    connectionsOpened: number;
    continuedRequests: number;
    continuationFallbacks: number;
    failures: number;
    fullRequests: number;
    idleCleanups: number;
    postOutputFailures: number;
    preOutputReplays: number;
    queueOverflows: number;
    requests: number;
    rotations: number;
};

export type XaiWsDebugState = {
    activeSessions: number;
    openSockets: number;
    sessions: number;
    counters: XaiWsDebugCounters;
};

type Deferred = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
};

type QueuedEvent = {
    bytes: number;
    event: Record<string, unknown>;
};

type PendingRequest = {
    completed: boolean;
    error?: Error;
    outputStarted: boolean;
    queue: QueuedEvent[];
    queuedBytes: number;
    socket: SocketState;
};

type SocketState = {
    ageTimer?: ReturnType<typeof setTimeout>;
    closed: boolean;
    error?: Error;
    expired: boolean;
    opened: boolean;
    openedAtMs: number;
    openDeferred: Deferred;
    response: { status: number; headers: Record<string, string> };
    socket: WebSocket;
    liveness: SocketLiveness;
};

function newDeferred(): Deferred {
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function newDebugCounters(): XaiWsDebugCounters {
    return {
        aborts: 0,
        connectionsOpened: 0,
        continuedRequests: 0,
        continuationFallbacks: 0,
        failures: 0,
        fullRequests: 0,
        idleCleanups: 0,
        postOutputFailures: 0,
        preOutputReplays: 0,
        queueOverflows: 0,
        requests: 0,
        rotations: 0,
    };
}

function debugLog(message: string): void {
    if (process.env.PI_XAI_WS_DEBUG === "1") {
        process.stderr.write(`[pi-xai-ws] ${message}\n`);
    }
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
    const envelopeType = payload.type;
    if (envelopeType !== "error" && envelopeType !== "api_error" && envelopeType !== undefined) {
        return payload;
    }
    const nested = isPlainEvent(payload.error) ? payload.error : undefined;
    let message: string | undefined;
    if (typeof payload.message === "string") {
        message = payload.message;
    } else if (typeof nested?.message === "string") {
        message = nested.message;
    } else if (nested) {
        message = JSON.stringify(nested);
    }
    if (message === undefined) {
        return payload;
    }
    const param = payload.param ?? nested?.param;
    return {
        type: "error",
        code: payload.code ?? nested?.code ?? payload.status,
        message,
        ...(param !== undefined ? { param } : {}),
    };
}

function isAbortError(error: Error | undefined): boolean {
    return error?.name === "AbortError" || error?.message === "Request was aborted";
}

function abortError(): Error {
    return Object.assign(new Error("Request was aborted"), { name: "AbortError" });
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw abortError();
    }
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (!signal) {
        return promise;
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<T>((_resolve, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        if (onAbort) {
            signal.removeEventListener("abort", onAbort);
        }
    }
}

function normalizeWireRecord(value: Record<string, unknown>): Record<string, unknown> {
    try {
        const serialized = JSON.stringify(value);
        if (typeof serialized !== "string") {
            throw new TypeError("not serializable");
        }
        const parsed: unknown = JSON.parse(serialized);
        if (isPlainEvent(parsed)) {
            return parsed;
        }
    } catch {
        // Fall through to the static, payload-safe error below.
    }
    throw new TypeError("xAI WebSocket payload must be a JSON-serializable object");
}

function fullContextPayload(value: Record<string, unknown>): Record<string, unknown> {
    const payload = normalizeWireRecord(value);
    payload.store = false;
    delete payload.previous_response_id;
    return payload;
}

function canonicalHeaders(headers: Record<string, string>): Array<[string, string]> {
    return Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), value] as [string, string])
        .sort(([leftName, leftValue], [rightName, rightValue]) => {
            if (leftName !== rightName) {
                return leftName.localeCompare(rightName);
            }
            return leftValue.localeCompare(rightValue);
        });
}

function transportIdentity(options: XaiWsSessionEventsOptions): string {
    return JSON.stringify({
        connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        headers: canonicalHeaders(options.headers),
        livenessTimeoutMs: options.livenessTimeoutMs ?? resolveLivenessTimeoutMs(),
        pingIntervalMs: options.pingIntervalMs ?? resolvePingIntervalMs(),
        url: options.url,
    });
}

function isModelOutputEvent(event: Record<string, unknown>): boolean {
    const type = typeof event.type === "string" ? event.type : "";
    return OUTPUT_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function eventErrorCode(event: Record<string, unknown>): string | undefined {
    if (event.type !== "error") {
        return undefined;
    }
    if (typeof event.code === "string") {
        return event.code;
    }
    if (isPlainEvent(event.error) && typeof event.error.code === "string") {
        return event.error.code;
    }
    return undefined;
}

function isConnectionLimitReached(event: Record<string, unknown>): boolean {
    return eventErrorCode(event) === "websocket_connection_limit_reached";
}

function socketDropError(error: unknown, outputStarted: boolean): XaiWsTransportError {
    if (error instanceof XaiWsTransportError) {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new XaiWsTransportError(message, { outputStarted });
}

function isReplayableTransportError(error: unknown): error is XaiWsTransportError {
    return error instanceof XaiWsTransportError &&
        !isAbortError(error) &&
        (error.kind === "connect" || error.kind === "liveness" || error.kind === "socket");
}

function isInboundPayloadLimitError(error: Error & { code?: string }): boolean {
    return error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ||
        /max payload size exceeded/i.test(error.message);
}

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

class XaiWsSocket {
    private currentRequest: PendingRequest | undefined;
    private waitResolve: (() => void) | undefined;
    private state: SocketState | undefined;
    private readonly options: {
        maxInboundFrameBytes: number;
        maxQueuedBytes: number;
        maxSocketAgeMs: number;
        onClosed: (reason: string) => void;
        onOpened: () => void;
        onQueueOverflow: () => void;
    };

    constructor(options: {
        maxInboundFrameBytes: number;
        maxQueuedBytes: number;
        maxSocketAgeMs: number;
        onClosed: (reason: string) => void;
        onOpened: () => void;
        onQueueOverflow: () => void;
    }) {
        this.options = options;
    }

    get isOpen(): boolean {
        return this.state?.opened === true && !this.state.expired && this.state.socket.readyState === WebSocket.OPEN;
    }

    get isExpired(): boolean {
        return this.state?.expired === true;
    }

    get shouldRotateBeforeRequest(): boolean {
        const openedAtMs = this.state?.openedAtMs ?? 0;
        if (openedAtMs === 0) {
            return false;
        }
        const requestAgeHeadroomMs = Math.floor(
            this.options.maxSocketAgeMs / REQUEST_AGE_HEADROOM_DIVISOR,
        );
        return Date.now() - openedAtMs >= this.options.maxSocketAgeMs - requestAgeHeadroomMs;
    }

    async *request(
        options: OpenXaiEventsOptions,
    ): AsyncGenerator<Record<string, unknown>> {
        const state = await this.ensureOpen(options);
        throwIfAborted(options.signal);
        if (!this.isOpen || this.state !== state) {
            throw new XaiWsTransportError("xAI WebSocket is not open", { kind: "connect" });
        }

        const pending: PendingRequest = {
            completed: false,
            outputStarted: false,
            queue: [],
            queuedBytes: 0,
            socket: state,
        };
        this.currentRequest = pending;
        const onAbort = () => {
            pending.error = abortError();
            pending.queue.length = 0;
            pending.queuedBytes = 0;
            this.close("abort", pending.error);
            this.wake();
        };
        if (options.signal?.aborted) {
            onAbort();
        } else {
            options.signal?.addEventListener("abort", onAbort, { once: true });
        }

        try {
            if (!pending.error) {
                try {
                    state.socket.send(JSON.stringify(options.createPayload));
                } catch (error) {
                    pending.error = socketDropError(error, pending.outputStarted);
                    this.close("send failure", pending.error);
                    this.wake();
                }
            }

            while (true) {
                if (pending.queue.length > 0) {
                    const queued = pending.queue.shift()!;
                    pending.queuedBytes -= queued.bytes;
                    const event = queued.event;
                    const type = typeof event.type === "string" ? event.type : "";
                    const terminal = isTerminalEventType(type);
                    if (terminal) {
                        pending.completed = true;
                    }
                    yield event;
                    if (terminal) {
                        return;
                    }
                    continue;
                }
                if (pending.error) {
                    throw pending.error;
                }
                await this.wait();
            }
        } finally {
            options.signal?.removeEventListener("abort", onAbort);
            if (this.currentRequest === pending) {
                this.currentRequest = undefined;
            }
            if (!pending.completed && !pending.error && this.state === state) {
                const error = new XaiWsTransportError("xAI WebSocket request ended before a terminal event", {
                    outputStarted: pending.outputStarted,
                });
                this.close("request ended", error);
            } else if (this.state === state && state.expired) {
                this.close("max age");
            }
        }
    }

    close(reason: string, error?: Error): void {
        const state = this.state;
        if (!state || state.closed) {
            return;
        }
        state.closed = true;
        this.state = undefined;
        if (state.ageTimer !== undefined) {
            clearTimeout(state.ageTimer);
            state.ageTimer = undefined;
        }
        state.liveness.stop();
        const closeError = error ?? new XaiWsTransportError(`xAI WebSocket closed: ${reason}`, {
            outputStarted: this.currentRequest?.outputStarted ?? false,
        });
        if (!state.opened) {
            state.openDeferred.reject(closeError);
        }
        if (this.currentRequest?.socket === state && !this.currentRequest.error) {
            this.currentRequest.error = closeError;
        }
        this.wake();
        state.socket.removeAllListeners();
        state.socket.on("error", () => {});
        state.socket.once("close", () => state.socket.removeAllListeners());
        try {
            if (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING) {
                state.socket.close(1000, reason.slice(0, 120));
            }
        } catch {
            // ignore
        }
        this.options.onClosed(reason);
        debugLog(`socket closed (${reason})`);
    }

    private async ensureOpen(options: OpenXaiEventsOptions): Promise<SocketState> {
        throwIfAborted(options.signal);
        if (this.state?.opened && !this.state.expired && this.state.socket.readyState === WebSocket.OPEN) {
            const state = this.state;
            try {
                await awaitWithAbort(
                    Promise.resolve().then(() => options.onOpen?.(state.response)),
                    options.signal,
                );
            } catch (error) {
                if (isAbortError(error instanceof Error ? error : undefined)) {
                    this.close("abort", error instanceof Error ? error : abortError());
                }
                throw error;
            }
            return state;
        }
        if (this.state && !this.state.opened) {
            const state = this.state;
            await awaitWithAbort(state.openDeferred.promise, options.signal);
            if (this.state !== state || !state.opened) {
                throw state.error ?? new XaiWsTransportError("xAI WebSocket failed to open", { kind: "connect" });
            }
            try {
                await awaitWithAbort(
                    Promise.resolve().then(() => options.onOpen?.(state.response)),
                    options.signal,
                );
            } catch (error) {
                if (isAbortError(error instanceof Error ? error : undefined)) {
                    this.close("abort", error instanceof Error ? error : abortError());
                }
                throw error;
            }
            return state;
        }
        if (this.state) {
            this.close("rotation");
        }

        const socket = new WebSocket(options.url, {
            headers: options.headers,
            handshakeTimeout: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
            maxPayload: this.options.maxInboundFrameBytes,
        });
        const openDeferred = newDeferred();
        const state: SocketState = {
            closed: false,
            expired: false,
            opened: false,
            openedAtMs: 0,
            openDeferred,
            response: { status: 101, headers: {} },
            socket,
            liveness: undefined as unknown as SocketLiveness,
        };
        state.liveness = new SocketLiveness(
            () => {
                if (this.state === state && socket.readyState === WebSocket.OPEN) {
                    socket.ping();
                }
            },
            (reason) => {
                const error = new XaiWsTransportError(reason, {
                    kind: "liveness",
                    outputStarted: this.currentRequest?.outputStarted ?? false,
                });
                if (this.currentRequest?.socket === state && !this.currentRequest.error) {
                    this.currentRequest.error = error;
                }
                this.close("liveness", error);
            },
            {
                livenessTimeoutMs: options.livenessTimeoutMs ?? resolveLivenessTimeoutMs(),
                pingIntervalMs: options.pingIntervalMs ?? resolvePingIntervalMs(),
            },
        );
        this.state = state;

        socket.on("upgrade", (response) => {
            if (this.state !== state || state.closed) {
                return;
            }
            state.response = {
                status: response.statusCode ?? 101,
                headers: flattenHeaders(response.headers),
            };
        });

        socket.once("open", () => {
            void (async () => {
                if (this.state !== state || state.closed) {
                    return;
                }
                try {
                    await awaitWithAbort(
                        Promise.resolve().then(() => options.onOpen?.(state.response)),
                        options.signal,
                    );
                    if (this.state !== state || state.closed) {
                        return;
                    }
                    state.opened = true;
                    state.openedAtMs = Date.now();
                    state.liveness.start();
                    const nodeSocket = socket as WebSocket & {
                        _socket?: {
                            setKeepAlive?: (enable?: boolean, initialDelay?: number) => unknown;
                            unref?: () => void;
                        };
                    };
                    nodeSocket._socket?.setKeepAlive?.(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
                    nodeSocket._socket?.unref?.();
                    state.ageTimer = setTimeout(() => {
                        if (this.state !== state || state.closed) {
                            return;
                        }
                        state.expired = true;
                        if (!this.currentRequest) {
                            this.close("max age");
                        }
                    }, this.options.maxSocketAgeMs);
                    state.ageTimer.unref?.();
                    openDeferred.resolve();
                    this.options.onOpened();
                    debugLog("socket opened");
                } catch (error) {
                    state.error = error instanceof Error ? error : new Error(String(error));
                    const reason = isAbortError(state.error) ? "abort" : "open callback failure";
                    this.close(reason, state.error);
                }
            })();
        });

        socket.on("message", (data) => {
            if (this.state !== state || state.closed) {
                return;
            }
            state.liveness.noteInbound();
            const frame = frameToUtf8(data);
            const frameBytes = Buffer.byteLength(frame);
            let parsed: unknown;
            try {
                parsed = JSON.parse(frame);
            } catch {
                const error = new XaiWsTransportError("xAI WebSocket sent invalid JSON", {
                    kind: "protocol",
                    outputStarted: this.currentRequest?.outputStarted ?? false,
                });
                this.failPending(error);
                this.close("protocol error", error);
                return;
            }
            if (!isPlainEvent(parsed)) {
                const error = new XaiWsTransportError("xAI WebSocket sent a non-object frame", {
                    kind: "protocol",
                    outputStarted: this.currentRequest?.outputStarted ?? false,
                });
                this.failPending(error);
                this.close("protocol error", error);
                return;
            }
            const event = normalizeEvent(parsed);
            const pending = this.currentRequest;
            if (!pending || pending.socket !== state) {
                return;
            }
            if (isModelOutputEvent(event)) {
                pending.outputStarted = true;
            }
            if (
                pending.queue.length >= MAX_QUEUED_EVENTS ||
                pending.queuedBytes + frameBytes > this.options.maxQueuedBytes
            ) {
                this.options.onQueueOverflow();
                const error = new XaiWsTransportError("xAI WebSocket event queue overflow", {
                    kind: "queue",
                    outputStarted: pending.outputStarted,
                });
                this.failPending(error);
                this.close("queue overflow", error);
                return;
            }
            pending.queue.push({ bytes: frameBytes, event });
            pending.queuedBytes += frameBytes;
            this.wake();
        });

        socket.on("pong", () => {
            if (this.state !== state || state.closed) {
                return;
            }
            state.liveness.noteInbound();
            this.wake();
        });

        socket.on("ping", () => {
            if (this.state !== state || state.closed) {
                return;
            }
            state.liveness.noteInbound();
        });

        socket.on("error", (error) => {
            if (this.state !== state || state.closed) {
                return;
            }
            const transport = new XaiWsTransportError(error.message, {
                kind: isInboundPayloadLimitError(error) ? "protocol" : "socket",
                outputStarted: this.currentRequest?.outputStarted ?? false,
            });
            state.error = transport;
            this.failPending(transport);
            this.close("socket error", transport);
            this.wake();
        });

        socket.on("close", (code, reasonBuf) => {
            if (this.state !== state || state.closed) {
                return;
            }
            const reason = reasonBuf.toString("utf8");
            const message = reason
                ? `xAI WebSocket closed (${code}): ${reason}`
                : `xAI WebSocket closed (${code})`;
            const error = state.error ?? new XaiWsTransportError(message, {
                outputStarted: this.currentRequest?.outputStarted ?? false,
            });
            state.error = error;
            state.closed = true;
            this.state = undefined;
            if (state.ageTimer !== undefined) {
                clearTimeout(state.ageTimer);
                state.ageTimer = undefined;
            }
            state.liveness.stop();
            if (!state.opened) {
                state.openDeferred.reject(error);
            }
            this.failPending(error);
            this.wake();
            this.options.onClosed("socket close");
        });

        try {
            await awaitWithAbort(openDeferred.promise, options.signal);
        } catch (error) {
            if (isAbortError(error instanceof Error ? error : undefined)) {
                this.close("abort", error instanceof Error ? error : abortError());
            }
            throw error;
        }
        if (this.state !== state || !state.opened) {
            throw state.error ?? new XaiWsTransportError("xAI WebSocket failed to open", { kind: "connect" });
        }
        return state;
    }

    private failPending(error: Error): void {
        if (this.currentRequest && !this.currentRequest.error) {
            this.currentRequest.error = error;
        }
        this.wake();
    }

    private wait(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.waitResolve = resolve;
        });
    }

    private wake(): void {
        this.waitResolve?.();
        this.waitResolve = undefined;
    }
}


class XaiWsSession {
    private active = false;
    private connection: XaiWsSocket | undefined;
    private continuationTransportKey: string | undefined;
    private durableChain: ContinuationState | undefined;
    private disposed = false;
    private idleTimer: ReturnType<typeof setTimeout> | undefined;
    private lastStoredTerminalConnection: XaiWsSocket | undefined;
    private pendingAcquires = 0;
    private releaseQueue: Promise<void> = Promise.resolve();
    private requestContext: ContinuationRequestContext | undefined;
    private resolveDisposed!: () => void;
    private socketChain: { connection: XaiWsSocket; state: ContinuationState } | undefined;
    private transportKey: string | undefined;
    private readonly disposedPromise: Promise<void>;
    private readonly sessionId: string | undefined;
    private readonly poolOptions: Required<XaiWsSessionPoolOptions>;
    private readonly counters: XaiWsDebugCounters;

    constructor(
        sessionId: string | undefined,
        poolOptions: Required<XaiWsSessionPoolOptions>,
        counters: XaiWsDebugCounters,
    ) {
        this.sessionId = sessionId;
        this.poolOptions = poolOptions;
        this.counters = counters;
        this.disposedPromise = new Promise<void>((resolve) => {
            this.resolveDisposed = resolve;
        });
    }

    get isActive(): boolean {
        return this.active;
    }

    get hasOpenSocket(): boolean {
        return this.connection?.isOpen === true;
    }

    get isUnused(): boolean {
        return (
            !this.active &&
            this.pendingAcquires === 0 &&
            !this.connection &&
            !this.durableChain &&
            !this.socketChain
        );
    }

    async *iterate(options: XaiWsSessionEventsOptions): AsyncGenerator<Record<string, unknown>> {
        const release = await this.acquire(options.signal);
        let clearStoredChainOnExit = false;
        try {
            this.throwIfDisposed();
            this.active = true;
            if (this.idleTimer !== undefined) {
                clearTimeout(this.idleTimer);
                this.idleTimer = undefined;
            }

            this.counters.requests += 1;
            const wirePayload = normalizeWireRecord(options.createPayload);
            const storeResponses = options.storeResponses === true;
            clearStoredChainOnExit = storeResponses;
            if (!storeResponses) {
                this.clearContinuation();
            }
            const nextTransportKey = transportIdentity(options);
            if (
                (this.socketChain || this.durableChain) &&
                this.continuationTransportKey !== nextTransportKey
            ) {
                this.clearContinuation();
                this.counters.continuationFallbacks += 1;
                debugLog("continuation reset after transport identity change");
            }
            if (this.transportKey !== undefined && this.transportKey !== nextTransportKey) {
                this.closeConnection("transport changed");
            }

            let continuationFallbackUsed = false;
            let forceFullContext = false;
            let responseReported = false;
            let transportReplayed = false;
            const onOpen: OpenXaiEventsOptions["onOpen"] = async (response) => {
                if (responseReported) {
                    return;
                }
                responseReported = true;
                await options.onOpen?.(response);
            };

            while (true) {
                this.throwIfDisposed();
                const connection = this.ensureConnection(options, nextTransportKey);
                const continuation = forceFullContext
                    ? undefined
                    : this.continuationForConnection(connection);
                const payload = storeResponses
                    ? this.planStoredRequest(wirePayload, continuation)
                    : fullContextPayload(wirePayload);
                const inputItems = Array.isArray(payload.input) ? payload.input.length : 0;
                if (typeof payload.previous_response_id === "string") {
                    debugLog(`request mode=continue input_items=${inputItems}`);
                    this.counters.continuedRequests += 1;
                } else {
                    debugLog(`request mode=full input_items=${inputItems}`);
                    this.counters.fullRequests += 1;
                }
                let outputStarted = false;
                let retryConnectionLimit = false;
                let retryContinuationFallback = false;
                try {
                    for await (const event of connection.request({
                        ...options,
                        createPayload: payload,
                        onOpen,
                    })) {
                        if (isModelOutputEvent(event)) {
                            outputStarted = true;
                        }
                        if (isConnectionLimitReached(event) && !transportReplayed && !outputStarted) {
                            transportReplayed = true;
                            this.counters.preOutputReplays += 1;
                            retryConnectionLimit = true;
                            break;
                        }
                        if (
                            storeResponses &&
                            typeof payload.previous_response_id === "string" &&
                            !continuationFallbackUsed &&
                            !outputStarted &&
                            isContinuationRejection(event)
                        ) {
                            continuationFallbackUsed = true;
                            this.counters.continuationFallbacks += 1;
                            retryContinuationFallback = true;
                            break;
                        }
                        const stored = storeResponses ? readStoredResponse(event) : undefined;
                        try {
                            yield event;
                        } finally {
                            if (stored) {
                                this.observeStoredTerminal(
                                    connection,
                                    stored,
                                    options.projectStoredOutput,
                                    nextTransportKey,
                                );
                                clearStoredChainOnExit = false;
                            }
                        }
                    }
                } catch (error) {
                    if (this.disposed) {
                        throw this.disposedError();
                    }
                    if (isAbortError(error instanceof Error ? error : undefined)) {
                        this.counters.aborts += 1;
                        this.closeConnection("abort");
                        throw error;
                    }
                    if (!(error instanceof XaiWsTransportError)) {
                        this.counters.failures += 1;
                        throw error;
                    }
                    if (
                        !transportReplayed &&
                        isReplayableTransportError(error) &&
                        !error.outputStarted
                    ) {
                        transportReplayed = true;
                        this.counters.preOutputReplays += 1;
                        this.closeConnection("pre-output reconnect");
                        continue;
                    }
                    if (error.outputStarted) {
                        this.counters.postOutputFailures += 1;
                    }
                    this.counters.failures += 1;
                    throw error;
                }

                if (retryConnectionLimit || retryContinuationFallback) {
                    this.throwIfDisposed();
                    this.closeConnection(retryContinuationFallback ? "continuation rejected" : "connection limit");
                    if (retryContinuationFallback) {
                        this.clearContinuation();
                        forceFullContext = true;
                    }
                    continue;
                }
                return;
            }
        } finally {
            if (clearStoredChainOnExit) {
                this.clearContinuation();
                debugLog("continuation cleared after request without stored terminal");
            }
            this.active = false;
            this.scheduleIdleCleanup();
            release();
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.resolveDisposed();
        if (this.idleTimer !== undefined) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
        this.closeConnection("dispose");
    }

    private async acquire(signal?: AbortSignal): Promise<() => void> {
        this.throwIfDisposed();
        if (this.pendingAcquires >= this.poolOptions.maxPendingRequests) {
            throw new XaiWsTransportError("xAI WebSocket session request queue is full", {
                kind: "queue",
            });
        }
        this.pendingAcquires += 1;
        const previous = this.releaseQueue;
        let release!: () => void;
        this.releaseQueue = new Promise<void>((resolve) => {
            release = resolve;
        });
        try {
            const acquired = await awaitWithAbort(
                Promise.race([
                    previous.then(() => true),
                    this.disposedPromise.then(() => false),
                ]),
                signal,
            );
            if (!acquired) {
                throw this.disposedError();
            }
        } catch (error) {
            void previous.then(release, release);
            if (isAbortError(error instanceof Error ? error : undefined)) {
                this.counters.aborts += 1;
            }
            throw error;
        } finally {
            this.pendingAcquires -= 1;
        }
        return release;
    }

    private disposedError(): XaiWsTransportError {
        return new XaiWsTransportError("xAI WebSocket session was disposed", {
            kind: "lifecycle",
        });
    }

    private throwIfDisposed(): void {
        if (this.disposed) {
            throw this.disposedError();
        }
    }

    private continuationForConnection(connection: XaiWsSocket): ContinuationState | undefined {
        if (this.socketChain?.connection === connection) {
            return this.socketChain.state;
        }
        return this.durableChain;
    }

    private planStoredRequest(
        base: Record<string, unknown>,
        continuation: ContinuationState | undefined,
    ): Record<string, unknown> {
        const plan = planStoredRequestForChain(base, continuation);
        if (plan.resetChain) {
            debugLog(`continuation reset covered_items=${continuation?.coveredItemCount ?? 0} full_items=${plan.context.fullInput.length}`);
            this.clearContinuation();
            this.counters.continuationFallbacks += 1;
        }
        this.requestContext = plan.context;
        return plan.payload;
    }

    private observeStoredTerminal(
        connection: XaiWsSocket,
        stored: { responseId: string },
        projectStoredOutput: (() => readonly unknown[] | undefined) | undefined,
        transportKey: string,
    ): void {
        const context = this.requestContext;
        this.requestContext = undefined;
        if (!context || !projectStoredOutput) {
            this.clearContinuation();
            return;
        }
        try {
            const projectedOutput = projectStoredOutput();
            if (!projectedOutput) {
                this.clearContinuation();
                return;
            }
            const next = nextContinuationState(context, stored, projectedOutput);
            // Later IDs on one socket can cycle back to an older ID, so only
            // the socket's first new ID is safe to promote across reconnects.
            // Keep this marker after close because close may race terminal
            // observation and clears the socket-local head.
            const firstStoredTerminalOnSocket = this.lastStoredTerminalConnection !== connection;
            const durableAdvanced = !this.durableChain || (
                firstStoredTerminalOnSocket &&
                this.durableChain.responseId !== next.responseId
            );
            this.lastStoredTerminalConnection = connection;
            this.socketChain = { connection, state: next };
            if (durableAdvanced) {
                this.durableChain = next;
            }
            this.continuationTransportKey = transportKey;
            debugLog(
                `continuation stored socket_covered_items=${next.coveredItemCount} durable_covered_items=${this.durableChain?.coveredItemCount ?? 0} projected_items=${projectedOutput.length} durable_advanced=${durableAdvanced}`,
            );
        } catch {
            this.clearContinuation();
        }
    }

    private clearContinuation(): void {
        this.continuationTransportKey = undefined;
        this.durableChain = undefined;
        this.lastStoredTerminalConnection = undefined;
        this.requestContext = undefined;
        this.socketChain = undefined;
    }

    private clearSocketContinuation(connection: XaiWsSocket): void {
        if (this.socketChain?.connection === connection) {
            this.socketChain = undefined;
        }
    }

    private ensureConnection(options: XaiWsSessionEventsOptions, transportKey: string): XaiWsSocket {
        this.throwIfDisposed();
        if (this.connection?.shouldRotateBeforeRequest) {
            this.closeConnection("request age");
        }
        if (this.connection && (!this.connection.isOpen || this.connection.isExpired)) {
            this.closeConnection(this.connection.isExpired ? "max age" : "unhealthy");
        }
        if (!this.connection) {
            let connection!: XaiWsSocket;
            connection = new XaiWsSocket({
                maxInboundFrameBytes: this.poolOptions.maxInboundFrameBytes,
                maxQueuedBytes: this.poolOptions.maxQueuedBytes,
                maxSocketAgeMs: this.poolOptions.maxSocketAgeMs,
                onClosed: (reason) => {
                    if (reason === "max age" || reason === "request age") {
                        this.counters.rotations += 1;
                    }
                    this.clearSocketContinuation(connection);
                    if (this.connection === connection) {
                        this.connection = undefined;
                        this.transportKey = undefined;
                    }
                },
                onOpened: () => {
                    this.counters.connectionsOpened += 1;
                },
                onQueueOverflow: () => {
                    this.counters.queueOverflows += 1;
                },
            });
            this.connection = connection;
            this.transportKey = transportKey;
        }
        return this.connection;
    }

    private closeConnection(reason: string): void {
        const connection = this.connection;
        if (!connection) {
            return;
        }
        this.connection = undefined;
        this.transportKey = undefined;
        this.clearSocketContinuation(connection);
        connection.close(reason);
    }

    private scheduleIdleCleanup(): void {
        if (
            this.disposed ||
            this.sessionId === undefined ||
            this.poolOptions.idleTimeoutMs <= 0 ||
            this.idleTimer !== undefined
        ) {
            return;
        }
        this.idleTimer = setTimeout(() => {
            this.idleTimer = undefined;
            if (this.active) {
                this.scheduleIdleCleanup();
                return;
            }
            this.counters.idleCleanups += 1;
            this.closeConnection("idle timeout");
            debugLog("idle socket closed");
        }, this.poolOptions.idleTimeoutMs);
        this.idleTimer.unref?.();
    }
}

export class XaiWsSessionPool {
    private readonly counters = newDebugCounters();
    private readonly options: Required<XaiWsSessionPoolOptions>;
    private readonly sessionsById = new Map<string, XaiWsSession>();

    constructor(options: XaiWsSessionPoolOptions = {}) {
        this.options = {
            idleTimeoutMs: Math.max(
                0,
                Math.min(Math.floor(options.idleTimeoutMs ?? resolveWsIdleTimeoutMs()), MAX_TIMER_MS),
            ),
            maxInboundFrameBytes: Math.max(
                1,
                Math.floor(options.maxInboundFrameBytes ?? DEFAULT_MAX_INBOUND_FRAME_BYTES),
            ),
            maxPendingRequests: Math.max(
                1,
                Math.floor(options.maxPendingRequests ?? DEFAULT_MAX_PENDING_SESSION_REQUESTS),
            ),
            maxQueuedBytes: Math.max(
                1,
                Math.floor(options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES),
            ),
            maxSocketAgeMs: Math.max(
                1,
                Math.min(Math.floor(options.maxSocketAgeMs ?? resolveWsMaxAgeMs()), MAX_TIMER_MS),
            ),
        };
    }

    async *iterate(options: XaiWsSessionEventsOptions): AsyncGenerator<Record<string, unknown>> {
        const sessionId = options.sessionId?.trim();
        if (!sessionId) {
            const session = this.createSession(undefined);
            try {
                yield* session.iterate({ ...options, sessionId: undefined, storeResponses: false });
            } finally {
                session.dispose();
            }
            return;
        }

        let session = this.sessionsById.get(sessionId);
        if (!session) {
            session = this.createSession(sessionId);
            this.sessionsById.set(sessionId, session);
        }
        try {
            yield* session.iterate({ ...options, sessionId });
        } finally {
            if (session.isUnused && this.sessionsById.get(sessionId) === session) {
                this.sessionsById.delete(sessionId);
                session.dispose();
            }
        }
    }

    closeAll(): void {
        for (const session of this.sessionsById.values()) {
            session.dispose();
        }
        this.sessionsById.clear();
    }

    inspect(): XaiWsDebugState {
        let activeSessions = 0;
        let openSockets = 0;
        for (const session of this.sessionsById.values()) {
            if (session.isActive) {
                activeSessions += 1;
            }
            if (session.hasOpenSocket) {
                openSockets += 1;
            }
        }
        return {
            activeSessions,
            counters: { ...this.counters },
            openSockets,
            sessions: this.sessionsById.size,
        };
    }

    private createSession(sessionId: string | undefined): XaiWsSession {
        return new XaiWsSession(sessionId, this.options, this.counters);
    }
}

export const defaultXaiWsSessionPool = new XaiWsSessionPool();

export async function* iterateXaiWsSessionEvents(
    options: XaiWsSessionEventsOptions,
): AsyncGenerator<Record<string, unknown>> {
    yield* defaultXaiWsSessionPool.iterate(options);
}

export async function* iterateXaiWsEvents(
    options: OpenXaiEventsOptions,
): AsyncGenerator<Record<string, unknown>> {
    let socket!: XaiWsSocket;
    socket = new XaiWsSocket({
        maxInboundFrameBytes: DEFAULT_MAX_INBOUND_FRAME_BYTES,
        maxQueuedBytes: DEFAULT_MAX_QUEUED_BYTES,
        maxSocketAgeMs: MAX_TIMER_MS,
        onClosed: () => {},
        onOpened: () => {},
        onQueueOverflow: () => {},
    });
    try {
        yield* socket.request({
            ...options,
            createPayload: fullContextPayload(options.createPayload),
        });
    } finally {
        socket.close("done");
    }
}
