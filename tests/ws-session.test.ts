import assert from "node:assert/strict";
import { createServer } from "node:http";
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

    it("removes idle sessions and opens a new socket after cleanup", async () => {
        const harness = await createHarness((socket, _payload, requestNumber) => {
            completed(socket, `response-${requestNumber}`);
        });
        const pool = new XaiWsSessionPool({ idleTimeoutMs: 25, maxSocketAgeMs: 10_000 });
        try {
            await collect(pool, requestOptions(harness.url, [{ role: "user", text: "first" }]));
            await wait(60);
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
