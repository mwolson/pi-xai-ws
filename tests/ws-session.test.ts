import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { describe, it } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { XaiWsSessionPool, type XaiWsSessionEventsOptions } from "../src/ws-events.ts";

type RequestRecord = {
    connection: number;
    payload: Record<string, unknown>;
};

type WsHarness = {
    connectionCount: () => number;
    requests: RequestRecord[];
    close: () => Promise<void>;
    url: string;
};

async function createHarness(
    onRequest: (socket: WebSocket, payload: Record<string, unknown>, requestNumber: number) => void,
): Promise<WsHarness> {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    const requests: RequestRecord[] = [];
    let connections = 0;
    const sockets = new Set<WebSocket>();

    wss.on("connection", (socket) => {
        const connection = ++connections;
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("message", (data) => {
            const payload = JSON.parse(data.toString()) as Record<string, unknown>;
            requests.push({ connection, payload });
            onRequest(socket, payload, requests.length);
        });
    });

    await new Promise<void>((resolve) => {
        httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
        throw new Error("expected tcp listen address");
    }

    return {
        connectionCount: () => connections,
        requests,
        close: async () => {
            for (const socket of sockets) {
                socket.close();
            }
            await new Promise<void>((resolve) => {
                wss.close(() => httpServer.close(() => resolve()));
            });
        },
        url: `ws://127.0.0.1:${address.port}`,
    };
}

function completed(socket: WebSocket, id: string): void {
    socket.send(JSON.stringify({
        response: { id, output: [], status: "completed" },
        type: "response.completed",
    }));
}

function requestOptions(
    url: string,
    input: unknown[],
    sessionId = "session-a",
    overrides: Record<string, unknown> = {},
): XaiWsSessionEventsOptions {
    return {
        createPayload: {
            input,
            max_output_tokens: 256,
            model: "grok-4.6",
            prompt_cache_key: "cache-key",
            reasoning: { effort: "high", summary: "auto" },
            store: false,
            tools: [{ name: "tool", type: "function" }],
            type: "response.create",
            ...overrides,
        },
        headers: {
            Authorization: "Bearer test-key",
            "x-grok-conv-id": sessionId,
        },
        sessionId,
        url,
    };
}

async function collect(
    pool: XaiWsSessionPool,
    options: XaiWsSessionEventsOptions,
): Promise<Record<string, unknown>[]> {
    const events: Record<string, unknown>[] = [];
    for await (const event of pool.iterate(options)) {
        events.push(event);
    }
    return events;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("XaiWsSessionPool", () => {
    it("reuses one physical connection while sending full context with storage disabled", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const secondInput = [
            ...firstInput,
            { role: "assistant", text: "answer" },
            { role: "user", text: "second" },
        ];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, requestOptions(harness.url, firstInput));
            await collect(pool, requestOptions(harness.url, secondInput));

            assert.equal(harness.connectionCount(), 1);
            assert.equal(harness.requests.length, 2);
            assert.deepEqual(harness.requests[0]?.payload.input, firstInput);
            assert.deepEqual(harness.requests[1]?.payload.input, secondInput);
            assert.equal(harness.requests[1]?.payload.store, false);
            assert.equal(harness.requests[1]?.payload.previous_response_id, undefined);
            assert.equal(harness.requests[1]?.payload.prompt_cache_key, "cache-key");
            assert.equal(pool.inspect().counters.fullRequests, 2);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("enables TCP keepalive on the WebSocket transport", async () => {
        const input = [{ role: "user", text: "keepalive" }];
        const harness = await createHarness((socket) => completed(socket, "response-1"));
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        const originalSetKeepAlive = Socket.prototype.setKeepAlive;
        const calls: Array<{ enable: boolean | undefined; initialDelay: number | undefined }> = [];
        Socket.prototype.setKeepAlive = function setKeepAlive(enable, initialDelay) {
            calls.push({ enable, initialDelay });
            return originalSetKeepAlive.call(this, enable, initialDelay);
        };
        try {
            await collect(pool, requestOptions(harness.url, input));

            assert.ok(calls.some((call) => call.enable === true && call.initialDelay === 15_000));
        } finally {
            Socket.prototype.setKeepAlive = originalSetKeepAlive;
            pool.closeAll();
            await harness.close();
        }
    });

    it("overrides hook-supplied storage and continuation fields", async () => {
        const input = [{ role: "user", text: "privacy" }];
        const harness = await createHarness((socket) => completed(socket, "response-1"));
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, requestOptions(harness.url, input, "session-a", {
                previous_response_id: "stored-response",
                store: true,
            }));

            assert.equal(harness.requests[0]?.payload.store, false);
            assert.equal(harness.requests[0]?.payload.previous_response_id, undefined);
            assert.deepEqual(harness.requests[0]?.payload.input, input);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("normalizes payload values to their JSON wire form once", async () => {
        let toJsonCalls = 0;
        const tools = ["same"];
        Object.defineProperty(tools, "toJSON", {
            enumerable: false,
            value: () => {
                toJsonCalls += 1;
                return ["wire", "tools"];
            },
        });
        const harness = await createHarness((socket) => completed(socket, "response-1"));
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, requestOptions(harness.url, [], "session-a", {
                instructions: new Date("2026-08-20T00:00:00.000Z"),
                tools,
            }));

            assert.equal(toJsonCalls, 1);
            assert.equal(harness.requests[0]?.payload.instructions, "2026-08-20T00:00:00.000Z");
            assert.deepEqual(harness.requests[0]?.payload.tools, ["wire", "tools"]);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("rejects payloads that cannot be serialized as a JSON object", async () => {
        const harness = await createHarness((socket) => completed(socket, "unexpected"));
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        try {
            await assert.rejects(
                () => collect(pool, requestOptions(harness.url, [], "session-a", { instructions: circular })),
                /JSON-serializable object/,
            );
            assert.equal(harness.connectionCount(), 0);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("reconnects when transport headers change", async () => {
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "first" }]));
            await collect(pool, {
                ...requestOptions(harness.url, [{ role: "user", text: "second" }]),
                headers: {
                    Authorization: "Bearer changed-key",
                    "x-grok-conv-id": "session-a",
                },
            });

            assert.equal(harness.connectionCount(), 2);
            assert.equal(harness.requests[1]?.connection, 2);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("does not replay malformed protocol frames", async () => {
        const harness = await createHarness((socket) => {
            socket.send("{");
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await assert.rejects(
                () => collect(pool, requestOptions(harness.url, [{ role: "user", text: "full" }])),
                /invalid JSON/,
            );

            assert.equal(harness.requests.length, 1);
            assert.equal(pool.inspect().counters.preOutputReplays, 0);
            assert.equal(pool.inspect().counters.failures, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("reconnects and replays full input once when the socket drops before output", async () => {
        const input = [{ role: "user", text: "full history" }];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            if (requestNumber === 1) {
                socket.close(1011, "before output");
            } else {
                completed(socket, "response-2");
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, requestOptions(harness.url, input));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(harness.requests.length, 2);
            assert.deepEqual(harness.requests[0]?.payload.input, input);
            assert.deepEqual(harness.requests[1]?.payload.input, input);
            assert.equal(harness.requests[1]?.payload.previous_response_id, undefined);
            assert.equal(pool.inspect().counters.preOutputReplays, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("does not replay a second time when the replacement socket drops", async () => {
        const harness = await createHarness((socket, _payload, requestNumber) => {
            socket.close(1011, `drop-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await assert.rejects(
                () => collect(pool, requestOptions(harness.url, [{ role: "user", text: "full" }])),
                /drop-2/,
            );

            assert.equal(harness.requests.length, 2);
            assert.equal(pool.inspect().counters.preOutputReplays, 1);
            assert.equal(pool.inspect().counters.failures, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("fails without replay after model output begins", async () => {
        const harness = await createHarness((socket) => {
            socket.send(JSON.stringify({
                delta: "partial",
                type: "response.output_text.delta",
            }));
            socket.close(1011, "after output");
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await assert.rejects(
                () => collect(pool, requestOptions(harness.url, [{ role: "user", text: "full" }])),
                /after output/,
            );

            assert.equal(harness.requests.length, 1);
            assert.equal(pool.inspect().counters.postOutputFailures, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("treats reasoning summary deltas as output and does not replay", async () => {
        const harness = await createHarness((socket) => {
            socket.send(JSON.stringify({
                delta: "partial reasoning",
                type: "response.reasoning_summary_text.delta",
            }));
            socket.close(1011, "after reasoning");
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await assert.rejects(
                () => collect(pool, requestOptions(harness.url, [{ role: "user", text: "full" }])),
                /after reasoning/,
            );

            assert.equal(harness.requests.length, 1);
            assert.equal(pool.inspect().counters.postOutputFailures, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("closes a session socket on abort", async () => {
        let requestSeen!: () => void;
        const seen = new Promise<void>((resolve) => {
            requestSeen = resolve;
        });
        const harness = await createHarness((_socket) => requestSeen());
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        const controller = new AbortController();
        try {
            const pending = collect(pool, {
                ...requestOptions(harness.url, [{ role: "user", text: "wait" }]),
                signal: controller.signal,
            });
            await seen;
            controller.abort();
            await assert.rejects(pending, /Request was aborted/);

            assert.equal(pool.inspect().openSockets, 0);
            assert.equal(pool.inspect().counters.aborts, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("aborts a response hook on a reused socket", async () => {
        let hookStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            hookStarted = resolve;
        });
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        const controller = new AbortController();
        try {
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "first" }]));
            const pending = collect(pool, {
                ...requestOptions(harness.url, [{ role: "user", text: "second" }]),
                onOpen: async () => {
                    hookStarted();
                    await new Promise<void>(() => {});
                },
                signal: controller.signal,
            });
            await started;
            controller.abort();
            await assert.rejects(
                Promise.race([
                    pending,
                    wait(200).then(() => {
                        throw new Error("response hook abort timed out");
                    }),
                ]),
                /Request was aborted/,
            );

            assert.equal(harness.requests.length, 1);
            assert.equal(pool.inspect().openSockets, 0);
            assert.equal(pool.inspect().counters.aborts, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("calls the response hook for every logical request on a reused socket", async () => {
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        const responseStatuses: number[] = [];
        const withHook = (text: string): XaiWsSessionEventsOptions => ({
            ...requestOptions(harness.url, [{ role: "user", text }]),
            onOpen: (response) => {
                responseStatuses.push(response.status);
            },
        });
        try {
            await collect(pool, withHook("first"));
            await collect(pool, withHook("second"));

            assert.equal(harness.connectionCount(), 1);
            assert.deepEqual(responseStatuses, [101, 101]);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("reconnects with full input when xAI reports the socket connection limit", async () => {
        const input = [{ role: "user", text: "full history" }];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            if (requestNumber === 1) {
                socket.send(JSON.stringify({
                    error: {
                        code: "websocket_connection_limit_reached",
                        message: "connection limit reached",
                        type: "invalid_request_error",
                    },
                    status: 400,
                    type: "error",
                }));
            } else {
                completed(socket, "response-2");
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, requestOptions(harness.url, input));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(harness.requests.length, 2);
            assert.deepEqual(harness.requests[1]?.payload.input, input);
            assert.equal(pool.inspect().counters.preOutputReplays, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("rejects a pre-aborted initial request without retaining an empty session", async () => {
        const harness = await createHarness((socket) => completed(socket, "unexpected"));
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        const controller = new AbortController();
        controller.abort();
        try {
            await assert.rejects(
                () => collect(pool, {
                    ...requestOptions(harness.url, [{ role: "user", text: "aborted" }]),
                    signal: controller.signal,
                }),
                /Request was aborted/,
            );

            assert.equal(harness.requests.length, 0);
            assert.equal(pool.inspect().sessions, 0);
            assert.equal(pool.inspect().counters.aborts, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("rejects an aborted queued request without closing the active socket", async () => {
        let firstSocket: WebSocket | undefined;
        let firstRequestSeen!: () => void;
        const firstRequest = new Promise<void>((resolve) => {
            firstRequestSeen = resolve;
        });
        const harness = await createHarness((socket, _payload, requestNumber) => {
            if (requestNumber === 1) {
                firstSocket = socket;
                firstRequestSeen();
            } else {
                completed(socket, "response-2");
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            const active = collect(pool, requestOptions(harness.url, [{ role: "user", text: "active" }]));
            await firstRequest;

            const controller = new AbortController();
            const queued = collect(pool, {
                ...requestOptions(harness.url, [{ role: "user", text: "queued" }]),
                signal: controller.signal,
            });
            controller.abort();
            await assert.rejects(
                Promise.race([
                    queued,
                    wait(200).then(() => {
                        throw new Error("queued abort timed out");
                    }),
                ]),
                /Request was aborted/,
            );

            completed(firstSocket!, "response-1");
            await active;
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "next" }]));

            assert.equal(harness.connectionCount(), 1);
            assert.equal(harness.requests.length, 2);
            assert.equal(pool.inspect().counters.aborts, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("bounds the same-session request backlog", async () => {
        let firstSocket: WebSocket | undefined;
        let firstRequestSeen!: () => void;
        const firstRequest = new Promise<void>((resolve) => {
            firstRequestSeen = resolve;
        });
        const harness = await createHarness((socket, _payload, requestNumber) => {
            if (requestNumber === 1) {
                firstSocket = socket;
                firstRequestSeen();
            } else {
                completed(socket, `response-${requestNumber}`);
            }
        });
        const pool = new XaiWsSessionPool({
            idleTimeoutMs: 10_000,
            maxPendingRequests: 1,
            maxSocketAgeMs: 10_000,
        });
        try {
            const active = collect(pool, requestOptions(harness.url, [{ role: "user", text: "active" }]));
            await firstRequest;
            const queued = collect(pool, requestOptions(harness.url, [{ role: "user", text: "queued" }]));
            await wait(0);

            await assert.rejects(
                () => collect(pool, requestOptions(harness.url, [{ role: "user", text: "excess" }])),
                /session request queue is full/,
            );

            completed(firstSocket!, "response-1");
            await active;
            await queued;
            assert.equal(harness.requests.length, 2);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("does not reconnect an active request after the pool is closed", async () => {
        let requestSeen!: () => void;
        const seen = new Promise<void>((resolve) => {
            requestSeen = resolve;
        });
        const harness = await createHarness(() => requestSeen());
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            const pending = collect(pool, requestOptions(harness.url, [{ role: "user", text: "active" }]));
            await seen;
            pool.closeAll();
            await assert.rejects(
                Promise.race([
                    pending,
                    wait(200).then(() => {
                        throw new Error("pool disposal timed out");
                    }),
                ]),
                /session was disposed/,
            );

            assert.equal(harness.connectionCount(), 1);
            assert.equal(harness.requests.length, 1);
            assert.equal(pool.inspect().sessions, 0);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("prunes an empty idle session after a pre-aborted reconnect", async () => {
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 25, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "first" }]));
            await wait(60);

            assert.equal(pool.inspect().openSockets, 0);
            assert.equal(pool.inspect().sessions, 1);

            const controller = new AbortController();
            controller.abort();
            await assert.rejects(
                () => collect(pool, {
                    ...requestOptions(harness.url, [{ role: "user", text: "aborted" }]),
                    signal: controller.signal,
                }),
                /Request was aborted/,
            );
            assert.equal(pool.inspect().sessions, 0);

            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "second" }]));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(pool.inspect().counters.idleCleanups, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("rotates before the configured maximum socket age", async () => {
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 25 });
        try {
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "first" }]));
            await wait(60);
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "second" }]));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(pool.inspect().counters.rotations, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("rotates before sending when a socket is near its maximum age", async () => {
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 100 });
        try {
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "first" }]));
            await wait(80);
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "second" }]));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(harness.requests[1]?.connection, 2);
            assert.equal(pool.inspect().counters.rotations, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("closes a socket that reaches maximum age during an active request", async () => {
        const harness = await createHarness((socket, _payload, requestNumber) => {
            setTimeout(() => completed(socket, `response-${requestNumber}`), 30);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10 });
        try {
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "first" }]));

            assert.equal(pool.inspect().openSockets, 0);
            assert.equal(pool.inspect().counters.rotations, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("fails when buffered event bytes exceed the queue bound", async () => {
        const harness = await createHarness((socket) => {
            socket.send(JSON.stringify({ padding: "a".repeat(100), type: "response.created" }));
            socket.send(JSON.stringify({ padding: "b".repeat(300), type: "response.created" }));
        });
        const pool = new XaiWsSessionPool({
            idleTimeoutMs: 10_000,
            maxQueuedBytes: 256,
            maxSocketAgeMs: 10_000,
        });
        try {
            await assert.rejects(
                () => collect(pool, requestOptions(harness.url, [])),
                /event queue overflow/,
            );
            assert.equal(pool.inspect().counters.queueOverflows, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("rejects inbound frames above the socket payload bound", async () => {
        const harness = await createHarness((socket) => {
            socket.send(JSON.stringify({ padding: "x".repeat(500), type: "response.created" }));
        });
        const pool = new XaiWsSessionPool({
            idleTimeoutMs: 10_000,
            maxInboundFrameBytes: 128,
            maxQueuedBytes: 1_024,
            maxSocketAgeMs: 10_000,
        });
        try {
            await assert.rejects(
                () => collect(pool, requestOptions(harness.url, [])),
                /payload size|larger than/i,
            );
            assert.equal(harness.connectionCount(), 1);
            assert.equal(harness.requests.length, 1);
            assert.equal(pool.inspect().counters.preOutputReplays, 0);
            assert.equal(pool.inspect().counters.failures, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("does not reuse a connection across session IDs", async () => {
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "first" }], "session-a"));
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "other" }], "session-b"));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(harness.requests[1]?.payload.previous_response_id, undefined);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });
});

describe("XaiWsSessionPool stored-response continuation", () => {
    function storedOptions(
        url: string,
        input: unknown[],
        projectedOutput: readonly unknown[],
        sessionId = "session-a",
        overrides: Record<string, unknown> = {},
    ): XaiWsSessionEventsOptions {
        return {
            ...requestOptions(url, input, sessionId, { store: true, ...overrides }),
            projectStoredOutput: () => projectedOutput,
            storeResponses: true,
        };
    }

    it("is off by default even when the payload asks for storage", async () => {
        const input = [{ role: "user", text: "private" }];
        const harness = await createHarness((socket) => completed(socket, "response-1"));
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, requestOptions(harness.url, input, "session-a", { store: true }));

            assert.equal(harness.requests[0]?.payload.store, false);
            assert.equal(harness.requests[0]?.payload.previous_response_id, undefined);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("does not store a request without a reusable Pi session id", async () => {
        const input = [{ role: "user", text: "request owned" }];
        const harness = await createHarness((socket) => completed(socket, "response-1"));
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            const options = storedOptions(harness.url, input, []);
            options.sessionId = undefined;
            await collect(pool, options);

            assert.equal(harness.requests[0]?.payload.store, false);
            assert.equal(harness.requests[0]?.payload.previous_response_id, undefined);
            assert.deepEqual(harness.requests[0]?.payload.input, input);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("sends full context once, then only new items with the response reference", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const firstOutput = [{ role: "assistant", text: "answer" }];
        const secondInput = [...firstInput, ...firstOutput, { role: "user", text: "second" }];
        const secondOutput = [{ role: "assistant", text: "another answer" }];
        const thirdInput = [...secondInput, ...secondOutput, { role: "user", text: "third" }];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, firstOutput));
            await collect(pool, storedOptions(harness.url, secondInput, secondOutput));
            await collect(pool, storedOptions(harness.url, thirdInput, []));

            assert.equal(harness.connectionCount(), 1);
            assert.deepEqual(harness.requests[0]?.payload.input, firstInput);
            assert.equal(harness.requests[0]?.payload.store, true);
            assert.equal(harness.requests[0]?.payload.previous_response_id, undefined);
            assert.deepEqual(harness.requests[1]?.payload.input, [{ role: "user", text: "second" }]);
            assert.equal(harness.requests[1]?.payload.previous_response_id, "response-1");
            assert.deepEqual(harness.requests[2]?.payload.input, [{ role: "user", text: "third" }]);
            assert.equal(harness.requests[2]?.payload.previous_response_id, "response-2");
            assert.equal(pool.inspect().counters.continuedRequests, 2);
            assert.equal(pool.inspect().counters.fullRequests, 1);
            assert.equal(pool.inspect().counters.continuationFallbacks, 0);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("recovers from a repeated socket-local response id using the durable checkpoint suffix", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const firstOutput = [{ type: "function_call", call_id: "call-1", name: "tool" }];
        const firstToolResult = { type: "function_call_output", call_id: "call-1", output: "one" };
        const secondInput = [...firstInput, ...firstOutput, firstToolResult];
        const secondOutput = [{ type: "function_call", call_id: "call-2", name: "tool" }];
        const secondToolResult = { type: "function_call_output", call_id: "call-2", output: "two" };
        const thirdInput = [...secondInput, ...secondOutput, secondToolResult];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            if (requestNumber === 3) {
                socket.close(1011, "before output");
            } else {
                completed(socket, requestNumber < 4 ? "response-repeated" : "response-recovered");
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, firstOutput));
            await collect(pool, storedOptions(harness.url, secondInput, secondOutput));
            await collect(pool, storedOptions(harness.url, thirdInput, []));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(harness.requests.length, 4);
            assert.deepEqual(harness.requests[1]?.payload.input, [firstToolResult]);
            assert.deepEqual(harness.requests[2]?.payload.input, [secondToolResult]);
            assert.equal(harness.requests[2]?.payload.previous_response_id, "response-repeated");
            assert.deepEqual(harness.requests[3]?.payload.input, [
                firstToolResult,
                ...secondOutput,
                secondToolResult,
            ]);
            assert.equal(harness.requests[3]?.payload.previous_response_id, "response-repeated");
            assert.equal(pool.inspect().counters.preOutputReplays, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("keeps the first safe checkpoint through response ID cycles and socket boundaries", async () => {
        const user1 = { role: "user", text: "U1" };
        const assistant1 = { role: "assistant", text: "A1" };
        const user2 = { role: "user", text: "U2" };
        const assistant2 = { role: "assistant", text: "A2" };
        const user3 = { role: "user", text: "U3" };
        const assistant3 = { role: "assistant", text: "A3" };
        const user4 = { role: "user", text: "U4" };
        const assistant4 = { role: "assistant", text: "A4" };
        const user5 = { role: "user", text: "U5" };
        const assistant5 = { role: "assistant", text: "A5" };
        const user6 = { role: "user", text: "U6" };
        const assistant6 = { role: "assistant", text: "A6" };
        const user7 = { role: "user", text: "U7" };
        const input1 = [user1];
        const input2 = [...input1, assistant1, user2];
        const input3 = [...input2, assistant2, user3];
        const input4 = [...input3, assistant3, user4];
        const input5 = [...input4, assistant4, user5];
        const input6 = [...input5, assistant5, user6];
        const input7 = [...input6, assistant6, user7];
        const responseIds = new Map([
            [1, "response-a"],
            [2, "response-b"],
            [3, "response-a"],
            [5, "response-c"],
            [6, "response-d"],
            [7, "response-c"],
            [9, "response-e"],
        ]);
        const harness = await createHarness((socket, _payload, requestNumber) => {
            if (requestNumber === 4 || requestNumber === 8) {
                socket.close(1011, "before output");
                return;
            }
            completed(socket, responseIds.get(requestNumber)!);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, input1, [assistant1]));
            await collect(pool, storedOptions(harness.url, input2, [assistant2]));
            await collect(pool, storedOptions(harness.url, input3, [assistant3]));
            await collect(pool, storedOptions(harness.url, input4, [assistant4]));
            await collect(pool, storedOptions(harness.url, input5, [assistant5]));
            await collect(pool, storedOptions(harness.url, input6, [assistant6]));
            await collect(pool, storedOptions(harness.url, input7, []));

            assert.equal(harness.connectionCount(), 3);
            assert.equal(harness.requests.length, 9);
            assert.equal(harness.requests[2]?.payload.previous_response_id, "response-b");
            assert.deepEqual(harness.requests[2]?.payload.input, [user3]);
            assert.equal(harness.requests[3]?.payload.previous_response_id, "response-a");
            assert.deepEqual(harness.requests[3]?.payload.input, [user4]);
            assert.equal(harness.requests[4]?.payload.previous_response_id, "response-a");
            assert.deepEqual(harness.requests[4]?.payload.input, [
                user2,
                assistant2,
                user3,
                assistant3,
                user4,
            ]);
            assert.equal(harness.requests[7]?.payload.previous_response_id, "response-c");
            assert.deepEqual(harness.requests[7]?.payload.input, [user7]);
            assert.equal(harness.requests[8]?.payload.previous_response_id, "response-c");
            assert.deepEqual(harness.requests[8]?.payload.input, [
                user5,
                assistant5,
                user6,
                assistant6,
                user7,
            ]);
            assert.equal(pool.inspect().counters.preOutputReplays, 2);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("retains the safe checkpoint when a later stored terminal closes immediately", async () => {
        const user1 = { role: "user", text: "U1" };
        const assistant1 = { role: "assistant", text: "A1" };
        const user2 = { role: "user", text: "U2" };
        const assistant2 = { role: "assistant", text: "A2" };
        const user3 = { role: "user", text: "U3" };
        const assistant3 = { role: "assistant", text: "A3" };
        const user4 = { role: "user", text: "U4" };
        const input1 = [user1];
        const input2 = [...input1, assistant1, user2];
        const input3 = [...input2, assistant2, user3];
        const input4 = [...input3, assistant3, user4];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            const responseId = requestNumber === 1 ? "response-a" : "response-b";
            completed(socket, responseId);
            if (requestNumber === 3) {
                socket.close(1000, "done");
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, input1, [assistant1]));
            await collect(pool, storedOptions(harness.url, input2, [assistant2]));
            await collect(pool, storedOptions(harness.url, input3, [assistant3]));
            await wait(10);
            await collect(pool, storedOptions(harness.url, input4, []));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(harness.requests[3]?.payload.previous_response_id, "response-a");
            assert.deepEqual(harness.requests[3]?.payload.input, [
                user2,
                assistant2,
                user3,
                assistant3,
                user4,
            ]);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("uses Pi's projected output instead of counting server-only response items", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const projectedOutput = [
            { type: "reasoning", encrypted_content: "blob" },
            { type: "message", text: "answer" },
        ];
        const secondInput = [...firstInput, ...projectedOutput, { role: "user", text: "second" }];
        const serverOutput = [
            { type: "reasoning", summary: [] },
            { type: "web_search_call", status: "completed" },
            { type: "message", status: "completed" },
        ];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            if (requestNumber === 1) {
                socket.send(JSON.stringify({
                    response: { id: "response-1", output: serverOutput, status: "completed" },
                    type: "response.completed",
                }));
            } else {
                completed(socket, "response-2");
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, projectedOutput));
            await collect(pool, storedOptions(harness.url, secondInput, []));

            assert.equal(harness.requests[1]?.payload.previous_response_id, "response-1");
            assert.deepEqual(harness.requests[1]?.payload.input, [{ role: "user", text: "second" }]);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("advances the chain from an incomplete response", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const secondInput = [
            ...firstInput,
            { type: "message", text: "partial answer" },
            { role: "user", text: "second" },
        ];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            if (requestNumber === 1) {
                socket.send(JSON.stringify({
                    response: {
                        id: "response-partial",
                        output: [{ type: "message" }],
                        status: "incomplete",
                    },
                    type: "response.incomplete",
                }));
            } else {
                completed(socket, "response-2");
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, [{ type: "message", text: "partial answer" }]));
            await collect(pool, storedOptions(harness.url, secondInput, []));

            assert.equal(harness.requests[1]?.payload.previous_response_id, "response-partial");
            assert.deepEqual(harness.requests[1]?.payload.input, [{ role: "user", text: "second" }]);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("clears the chain when a stored request ends without a reusable terminal", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const firstOutput = [{ role: "assistant", text: "answer" }];
        const secondInput = [...firstInput, ...firstOutput, { role: "user", text: "second" }];
        const thirdInput = [
            ...secondInput,
            { role: "assistant", text: "failed partial answer" },
            { role: "user", text: "third" },
        ];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            if (requestNumber === 2) {
                socket.send(JSON.stringify({
                    response: { id: "response-failed", status: "failed" },
                    type: "response.failed",
                }));
            } else {
                completed(socket, `response-${requestNumber}`);
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, firstOutput));
            await collect(pool, storedOptions(harness.url, secondInput, []));
            await collect(pool, storedOptions(harness.url, thirdInput, []));

            assert.equal(harness.requests[1]?.payload.previous_response_id, "response-1");
            assert.equal(harness.requests[2]?.payload.previous_response_id, undefined);
            assert.deepEqual(harness.requests[2]?.payload.input, thirdInput);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("retries full context without the reference when xAI rejects it", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const secondInput = [
            ...firstInput,
            { role: "assistant", text: "answer" },
            { role: "user", text: "second" },
        ];
        const harness = await createHarness((socket, payload, requestNumber) => {
            if (requestNumber === 2 && typeof payload.previous_response_id === "string") {
                socket.send(JSON.stringify({
                    error: {
                        code: "invalid_request_error",
                        message: "Invalid parameter.",
                        param: "previous_response_id",
                    },
                    type: "api_error",
                }));
            } else {
                completed(socket, `response-${requestNumber}`);
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, [{ role: "assistant", text: "answer" }]));
            await collect(pool, storedOptions(harness.url, secondInput, []));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(harness.requests.length, 3);
            assert.deepEqual(harness.requests[2]?.payload.input, secondInput);
            assert.equal(harness.requests[2]?.payload.previous_response_id, undefined);
            assert.equal(harness.requests[2]?.payload.store, true);
            assert.equal(pool.inspect().counters.continuationFallbacks, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("forgets a missing live xAI response id and retries full context once", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const firstOutput = [{ role: "assistant", text: "answer" }];
        const secondInput = [...firstInput, ...firstOutput, { role: "user", text: "second" }];
        const harness = await createHarness((socket, payload, requestNumber) => {
            if (requestNumber === 2 && typeof payload.previous_response_id === "string") {
                socket.send(JSON.stringify({
                    message: `gRPC error: Response with id=${payload.previous_response_id} not found`,
                }));
            } else {
                completed(socket, `response-${requestNumber}`);
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, firstOutput));
            await collect(pool, storedOptions(harness.url, secondInput, []));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(harness.requests.length, 3);
            assert.equal(harness.requests[1]?.payload.previous_response_id, "response-1");
            assert.equal(harness.requests[2]?.payload.previous_response_id, undefined);
            assert.deepEqual(harness.requests[2]?.payload.input, secondInput);
            assert.equal(pool.inspect().counters.continuationFallbacks, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("still falls back to full context after a connection-limit replay", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const firstOutput = [{ role: "assistant", text: "answer" }];
        const secondInput = [...firstInput, ...firstOutput, { role: "user", text: "second" }];
        const harness = await createHarness((socket, payload, requestNumber) => {
            if (requestNumber === 2) {
                socket.send(JSON.stringify({
                    code: "websocket_connection_limit_reached",
                    message: "connection limit reached",
                    type: "error",
                }));
            } else if (requestNumber === 3 && typeof payload.previous_response_id === "string") {
                socket.send(JSON.stringify({
                    code: "previous_response_not_found",
                    message: "Previous response id was not found.",
                    type: "error",
                }));
            } else {
                completed(socket, `response-${requestNumber}`);
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, firstOutput));
            await collect(pool, storedOptions(harness.url, secondInput, []));

            assert.equal(harness.connectionCount(), 3);
            assert.equal(harness.requests.length, 4);
            assert.equal(harness.requests[1]?.payload.previous_response_id, "response-1");
            assert.equal(harness.requests[2]?.payload.previous_response_id, "response-1");
            assert.equal(harness.requests[3]?.payload.previous_response_id, undefined);
            assert.deepEqual(harness.requests[3]?.payload.input, secondInput);
            assert.equal(pool.inspect().counters.preOutputReplays, 1);
            assert.equal(pool.inspect().counters.continuationFallbacks, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("does not replenish the transport replay after a reference fallback", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const firstOutput = [{ role: "assistant", text: "answer" }];
        const secondInput = [...firstInput, ...firstOutput, { role: "user", text: "second" }];
        const harness = await createHarness((socket, payload, requestNumber) => {
            if (requestNumber === 2) {
                socket.send(JSON.stringify({
                    code: "websocket_connection_limit_reached",
                    message: "connection limit reached",
                    type: "error",
                }));
            } else if (requestNumber === 3 && typeof payload.previous_response_id === "string") {
                socket.send(JSON.stringify({
                    message: `gRPC error: Response with id=${payload.previous_response_id} not found`,
                }));
            } else if (requestNumber === 4) {
                socket.close(1011, "before output");
            } else {
                completed(socket, `response-${requestNumber}`);
            }
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, firstOutput));
            await assert.rejects(
                () => collect(pool, storedOptions(harness.url, secondInput, [])),
                /closed/i,
            );

            assert.equal(harness.connectionCount(), 3);
            assert.equal(harness.requests.length, 4);
            assert.equal(harness.requests[2]?.payload.previous_response_id, "response-1");
            assert.equal(harness.requests[3]?.payload.previous_response_id, undefined);
            assert.deepEqual(harness.requests[3]?.payload.input, secondInput);
            assert.equal(pool.inspect().counters.preOutputReplays, 1);
            assert.equal(pool.inspect().counters.continuationFallbacks, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("falls back to full context once when history was rewritten", async () => {
        const firstInput = [{ role: "user", text: "original" }];
        const compactedInput = [
            { role: "user", text: "summary of earlier context" },
            { role: "user", text: "second" },
        ];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, [{ role: "assistant", text: "original answer" }]));
            await collect(pool, storedOptions(harness.url, compactedInput, [{ role: "assistant", text: "ok" }]));

            assert.deepEqual(harness.requests[1]?.payload.input, compactedInput);
            assert.equal(harness.requests[1]?.payload.previous_response_id, undefined);
            assert.equal(pool.inspect().counters.continuationFallbacks, 1);

            const thirdInput = [...compactedInput, { role: "assistant", text: "ok" }, { role: "user", text: "third" }];
            await collect(pool, storedOptions(harness.url, thirdInput, []));
            assert.deepEqual(harness.requests[2]?.payload.input, [{ role: "user", text: "third" }]);
            assert.equal(harness.requests[2]?.payload.previous_response_id, "response-2");
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("clears the chain when the transport identity changes", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const firstOutput = [{ role: "assistant", text: "answer" }];
        const secondInput = [...firstInput, ...firstOutput, { role: "user", text: "second" }];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, firstOutput));
            const changed = storedOptions(harness.url, secondInput, []);
            changed.headers = { ...changed.headers, Authorization: "Bearer another-account" };
            await collect(pool, changed);

            assert.equal(harness.connectionCount(), 2);
            assert.equal(harness.requests[1]?.payload.previous_response_id, undefined);
            assert.deepEqual(harness.requests[1]?.payload.input, secondInput);
            assert.equal(pool.inspect().counters.continuationFallbacks, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("retains stored checkpoints after an idle socket closes and a reconnect is pre-aborted", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const firstOutput = [{ role: "assistant", text: "answer" }];
        const secondInput = [...firstInput, ...firstOutput, { role: "user", text: "second" }];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 20, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, firstOutput));
            await wait(60);

            assert.equal(pool.inspect().openSockets, 0);
            assert.equal(pool.inspect().sessions, 1);

            const controller = new AbortController();
            controller.abort();
            await assert.rejects(
                () => collect(pool, {
                    ...storedOptions(harness.url, secondInput, []),
                    signal: controller.signal,
                }),
                /Request was aborted/,
            );

            assert.equal(harness.requests.length, 1);
            assert.equal(pool.inspect().sessions, 1);

            await collect(pool, storedOptions(harness.url, secondInput, []));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(harness.requests[1]?.payload.previous_response_id, "response-1");
            assert.deepEqual(harness.requests[1]?.payload.input, [
                { role: "user", text: "second" },
            ]);
            assert.equal(pool.inspect().counters.idleCleanups, 1);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("removes a pre-aborted new session without touching retained checkpoints", async () => {
        const firstInput = [{ role: "user", text: "first" }];
        const firstOutput = [{ role: "assistant", text: "answer" }];
        const secondInput = [...firstInput, ...firstOutput, { role: "user", text: "second" }];
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, storedOptions(harness.url, firstInput, firstOutput, "session-a"));
            await collect(pool, storedOptions(harness.url, [{ role: "user", text: "other" }], [], "session-b"));

            const controller = new AbortController();
            controller.abort();
            await assert.rejects(
                () => collect(pool, {
                    ...storedOptions(harness.url, [{ role: "user", text: "aborted" }], [], "session-c"),
                    signal: controller.signal,
                }),
                /Request was aborted/,
            );

            assert.equal(pool.inspect().sessions, 2);

            await collect(pool, storedOptions(harness.url, secondInput, [], "session-a"));

            assert.equal(harness.requests.length, 3);
            assert.equal(harness.requests[2]?.payload.previous_response_id, "response-1");
            assert.deepEqual(harness.requests[2]?.payload.input, [
                { role: "user", text: "second" },
            ]);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("retains stored checkpoints across more than eight sessions", async () => {
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 10_000 });
        try {
            for (let index = 0; index < 9; index += 1) {
                await collect(pool, storedOptions(
                    harness.url,
                    [{ role: "user", text: `first-${index}` }],
                    [{ role: "assistant", text: `answer-${index}` }],
                    `session-${index}`,
                ));
            }

            assert.equal(pool.inspect().sessions, 9);

            await collect(pool, storedOptions(
                harness.url,
                [
                    { role: "user", text: "first-0" },
                    { role: "assistant", text: "answer-0" },
                    { role: "user", text: "second" },
                ],
                [],
                "session-0",
            ));

            assert.equal(harness.requests[9]?.payload.previous_response_id, "response-1");
            assert.deepEqual(harness.requests[9]?.payload.input, [
                { role: "user", text: "second" },
            ]);
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });

    it("replans from the durable checkpoint after age rotation with repeated IDs", async () => {
        const user1 = { role: "user", text: "U1" };
        const assistant1 = { role: "assistant", text: "A1" };
        const user2 = { role: "user", text: "U2" };
        const assistant2 = { role: "assistant", text: "A2" };
        const user3 = { role: "user", text: "U3" };
        const input1 = [user1];
        const input2 = [...input1, assistant1, user2];
        const input3 = [...input2, assistant2, user3];
        const harness = await createHarness((socket) => {
            completed(socket, "response-repeated");
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 10_000, maxSocketAgeMs: 25 });
        try {
            await collect(pool, storedOptions(harness.url, input1, [assistant1]));
            await collect(pool, storedOptions(harness.url, input2, [assistant2]));
            await wait(60);
            await collect(pool, storedOptions(harness.url, input3, []));

            assert.equal(harness.connectionCount(), 2);
            assert.equal(pool.inspect().counters.rotations, 1);
            assert.equal(harness.requests[2]?.connection, 2);
            assert.deepEqual(harness.requests[2]?.payload.input, [user2, assistant2, user3]);
            assert.equal(harness.requests[2]?.payload.previous_response_id, "response-repeated");
        } finally {
            pool.closeAll();
            await harness.close();
        }
    });
});
