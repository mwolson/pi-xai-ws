import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { frameToUtf8, isPlainEvent, iterateXaiWsEvents } from "../src/ws-events.ts";

async function withWsServer(
    onConnection: (socket: WebSocket) => void,
    run: (url: string) => Promise<void>,
): Promise<void> {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", onConnection);
    await new Promise<void>((resolve) => {
        httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
        throw new Error("expected tcp listen address");
    }
    try {
        await run(`ws://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve) => {
            wss.close();
            httpServer.close(() => resolve());
        });
    }
}

async function collect(
    url: string,
    extras: Partial<Parameters<typeof iterateXaiWsEvents>[0]> = {},
): Promise<Record<string, unknown>[]> {
    const events: Record<string, unknown>[] = [];
    for await (const event of iterateXaiWsEvents({
        url,
        headers: {},
        createPayload: { type: "response.create", model: "grok-4.6" },
        ...extras,
    })) {
        events.push(event);
    }
    return events;
}

describe("frameToUtf8 / isPlainEvent", () => {
    it("joins Buffer fragments and rejects arrays", () => {
        assert.equal(frameToUtf8(Buffer.from('{"a":1}', "utf8")), '{"a":1}');
        assert.equal(
            frameToUtf8([Buffer.from("{\"a\":", "utf8"), Buffer.from("1}", "utf8")]),
            '{"a":1}',
        );
        assert.equal(frameToUtf8(new TextEncoder().encode('{"a":1}').buffer), '{"a":1}');
        assert.equal(isPlainEvent({ type: "error" }), true);
        assert.equal(isPlainEvent([]), false);
        assert.equal(isPlainEvent(null), false);
    });
});

describe("iterateXaiWsEvents", () => {
    it("treats response.completed plus an immediate close as success", async () => {
        await withWsServer(
            (socket) => {
                socket.on("message", () => {
                    socket.send(
                        JSON.stringify({
                            type: "response.completed",
                            response: { id: "resp_1", status: "completed", output: [] },
                        }),
                    );
                    socket.close(1000, "done");
                });
            },
            async (url) => {
                const events = await collect(url);
                assert.equal(events.length, 1);
                assert.equal(events[0]?.type, "response.completed");
            },
        );
    });

    it("throws when the socket closes with no terminal event", async () => {
        await withWsServer(
            (socket) => {
                socket.on("message", () => {
                    socket.close(1000, "empty");
                });
            },
            async (url) => {
                await assert.rejects(
                    () => collect(url),
                    /xAI WebSocket closed \(1000\): empty/,
                );
            },
        );
    });

    it("rejects a JSON array frame", async () => {
        await withWsServer(
            (socket) => {
                socket.on("message", () => {
                    socket.send("[]");
                });
            },
            async (url) => {
                await assert.rejects(() => collect(url), /non-object frame/);
            },
        );
    });

    it("aborts after the first event", async () => {
        const controller = new AbortController();
        await withWsServer(
            (socket) => {
                socket.on("message", () => {
                    for (const index of [1, 2, 3]) {
                        socket.send(
                            JSON.stringify({
                                type: "response.created",
                                response: { id: `resp_${index}` },
                            }),
                        );
                    }
                });
            },
            async (url) => {
                const iter = iterateXaiWsEvents({
                    url,
                    headers: {},
                    createPayload: { type: "response.create", model: "grok-4.6" },
                    signal: controller.signal,
                });
                const first = await iter.next();
                assert.equal(first.value?.type, "response.created");
                controller.abort();
                await assert.rejects(async () => {
                    await iter.next();
                }, /Request was aborted/);
            },
        );
    });

    it("normalizes a direct api_error envelope", async () => {
        await withWsServer(
            (socket) => {
                socket.on("message", () => {
                    socket.send(JSON.stringify({
                        code: "overloaded",
                        message: "capacity unavailable",
                        type: "api_error",
                    }));
                });
            },
            async (url) => {
                const events = await collect(url);
                assert.deepEqual(events, [{
                    code: "overloaded",
                    message: "capacity unavailable",
                    type: "error",
                }]);
            },
        );
    });

    it("aborts safely after the WebSocket handshake starts", async () => {
        const httpServer = createServer();
        const sockets = new Set<{ destroy: () => void }>();
        let upgradeSeen!: () => void;
        const upgrade = new Promise<void>((resolve) => {
            upgradeSeen = resolve;
        });
        httpServer.on("upgrade", (_request, socket) => {
            sockets.add(socket);
            socket.on("error", () => {});
            upgradeSeen();
        });
        await new Promise<void>((resolve) => {
            httpServer.listen(0, "127.0.0.1", resolve);
        });
        const address = httpServer.address();
        assert.ok(address && typeof address !== "string");
        const controller = new AbortController();
        try {
            const pending = collect(`ws://127.0.0.1:${address.port}`, {
                signal: controller.signal,
            });
            await upgrade;
            controller.abort();
            await assert.rejects(pending, /Request was aborted/);
            await new Promise<void>((resolve) => setImmediate(resolve));
        } finally {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        }
    });

    it("aborts while connecting", async () => {
        const controller = new AbortController();
        controller.abort();
        await withWsServer(
            () => {},
            async (url) => {
                await assert.rejects(
                    () => collect(url, { signal: controller.signal }),
                    /Request was aborted/,
                );
            },
        );
    });
});
