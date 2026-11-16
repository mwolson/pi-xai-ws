import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type {
    AssistantMessage,
    Context,
    Model,
    SimpleStreamOptions,
    ToolResultMessage,
} from "@earendil-works/pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { WebSocketServer, type WebSocket } from "ws";
import { streamXaiResponsesWs } from "../src/stream.ts";
import {
    defaultXaiWsSessionPool,
    XaiWsTransportError,
} from "../src/ws-events.ts";

const previousStore = process.env.PI_XAI_WS_STORE;
const previousThreshold = process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS;
const previousUrl = process.env.PI_XAI_WS_URL;
const previousReplay = process.env.PI_XAI_WS_REASONING_REPLAY;

afterEach(() => {
    defaultXaiWsSessionPool.closeAll();
    if (previousStore === undefined) {
        delete process.env.PI_XAI_WS_STORE;
    } else {
        process.env.PI_XAI_WS_STORE = previousStore;
    }
    if (previousThreshold === undefined) {
        delete process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS;
    } else {
        process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS = previousThreshold;
    }
    if (previousUrl === undefined) {
        delete process.env.PI_XAI_WS_URL;
    } else {
        process.env.PI_XAI_WS_URL = previousUrl;
    }
    if (previousReplay === undefined) {
        delete process.env.PI_XAI_WS_REASONING_REPLAY;
    } else {
        process.env.PI_XAI_WS_REASONING_REPLAY = previousReplay;
    }
});

function responsesModel(): Model<"openai-responses"> {
    const model = xaiProvider().getModels().find(
        (candidate) => candidate.api === "openai-responses",
    );
    assert.ok(model);
    return { ...model, id: "grok-4.7" } as Model<"openai-responses">;
}

async function collectMessage(
    model: Model<"openai-responses">,
    context: Context,
    options: Partial<SimpleStreamOptions> = {},
): Promise<AssistantMessage> {
    let message: AssistantMessage | undefined;
    for await (const event of streamXaiResponsesWs(model, context, {
        apiKey: "test-key",
        sessionId: "stream-continuation-session",
        ...options,
    })) {
        if (event.type === "done") {
            message = event.message;
        }
        if (event.type === "error") {
            throw new Error(event.error.errorMessage ?? "stream failed");
        }
    }
    assert.ok(message);
    return message;
}

function send(socket: WebSocket, event: Record<string, unknown>): void {
    socket.send(JSON.stringify(event));
}

describe("stream stored-response continuation", () => {
    it("passes Pi's stream timeout through as the WebSocket liveness budget", async () => {
        const originalIterate = defaultXaiWsSessionPool.iterate;
        let capturedOptions: Parameters<typeof defaultXaiWsSessionPool.iterate>[0] | undefined;
        defaultXaiWsSessionPool.iterate = async function* (options) {
            capturedOptions = options;
            yield {
                response: { id: "response-liveness", output: [], status: "completed" },
                type: "response.completed",
            };
        };

        try {
            await collectMessage(
                responsesModel(),
                { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                { timeoutMs: 300_000 },
            );
            assert.equal(capturedOptions?.pingIntervalMs, 15_000);
            assert.equal(capturedOptions?.livenessTimeoutMs, 285_000);
        } finally {
            defaultXaiWsSessionPool.iterate = originalIterate;
        }
    });

    it("marks exhausted socket transport failures for Pi's outer retry", async () => {
        const originalIterate = defaultXaiWsSessionPool.iterate;
        defaultXaiWsSessionPool.iterate = async function* () {
            throw new XaiWsTransportError("read ECONNRESET", {
                kind: "socket",
                outputStarted: true,
            });
        };

        try {
            await assert.rejects(
                () => collectMessage(
                    responsesModel(),
                    { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                ),
                /WebSocket error: read ECONNRESET/,
            );
        } finally {
            defaultXaiWsSessionPool.iterate = originalIterate;
        }
    });

    it("clears an existing continuation before a trailing tool result crosses the storage threshold", async () => {
        const requests: Array<Record<string, unknown>> = [];
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        assert.ok(address && typeof address === "object");
        process.env.PI_XAI_WS_STORE = "1";
        process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS = "220000";
        process.env.PI_XAI_WS_URL = `ws://127.0.0.1:${address.port}`;
        server.on("connection", (socket) => {
            socket.on("message", (frame) => {
                requests.push(JSON.parse(frame.toString()) as Record<string, unknown>);
                send(socket, {
                    response: { id: "response-safe", output: [], status: "completed" },
                    type: "response.completed",
                });
            });
        });

        try {
            const model = responsesModel();
            const user = { role: "user" as const, content: "first", timestamp: 1 };
            const first = await collectMessage(model, { messages: [user] });
            first.usage.input = 210_000;
            first.usage.totalTokens = 210_000;
            const largeToolResult: ToolResultMessage = {
                role: "toolResult",
                toolCallId: "call-safe",
                toolName: "read",
                content: [{ type: "text", text: "x".repeat(160_000) }],
                isError: false,
                timestamp: 2,
            };
            const second = await collectMessage(model, {
                messages: [user, first, largeToolResult],
            });
            await collectMessage(model, {
                messages: [
                    user,
                    first,
                    largeToolResult,
                    second,
                    { role: "user", content: "continue", timestamp: 3 },
                ],
            });

            assert.equal(requests.length, 3);
            assert.equal(requests[0]?.store, true);
            assert.equal(requests[1]?.store, false);
            assert.equal(requests[1]?.previous_response_id, undefined);
            assert.equal(requests[2]?.store, false);
            assert.equal(requests[2]?.previous_response_id, undefined);
        } finally {
            defaultXaiWsSessionPool.closeAll();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("keeps stored continuation for large usage when no token threshold is configured", async () => {
        const requests: Array<Record<string, unknown>> = [];
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        assert.ok(address && typeof address === "object");
        process.env.PI_XAI_WS_STORE = "1";
        delete process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS;
        process.env.PI_XAI_WS_URL = `ws://127.0.0.1:${address.port}`;
        server.on("connection", (socket) => {
            socket.on("message", (frame) => {
                requests.push(JSON.parse(frame.toString()) as Record<string, unknown>);
                send(socket, {
                    response: { id: "response-large", output: [], status: "completed" },
                    type: "response.completed",
                });
            });
        });

        try {
            const model = responsesModel();
            const user = { role: "user" as const, content: "first", timestamp: 1 };
            const first = await collectMessage(model, { messages: [user] });
            first.usage.input = 470_000;
            first.usage.cacheRead = 12_000;
            first.usage.totalTokens = 485_000;
            await collectMessage(model, {
                messages: [
                    user,
                    first,
                    { role: "user", content: "continue", timestamp: 2 },
                ],
            });

            assert.equal(requests.length, 2);
            assert.equal(requests[0]?.store, true);
            assert.equal(requests[1]?.store, true);
            assert.equal(requests[1]?.previous_response_id, "response-large");
        } finally {
            defaultXaiWsSessionPool.closeAll();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("keeps continuation when unsliced payload JSON exceeds the storage threshold", async () => {
        const requests: Array<Record<string, unknown>> = [];
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        assert.ok(address && typeof address === "object");
        process.env.PI_XAI_WS_STORE = "1";
        process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS = "220000";
        process.env.PI_XAI_WS_URL = `ws://127.0.0.1:${address.port}`;
        server.on("connection", (socket) => {
            socket.on("message", (frame) => {
                requests.push(JSON.parse(frame.toString()) as Record<string, unknown>);
                send(socket, {
                    response: { id: "response-live", output: [], status: "completed" },
                    type: "response.completed",
                });
            });
        });

        try {
            const model = responsesModel();
            const user = { role: "user" as const, content: "first", timestamp: 1 };
            const first = await collectMessage(model, { messages: [user] });
            first.usage.input = 190_148;
            first.usage.cacheRead = 512;
            first.usage.totalTokens = 190_660;
            const bulkyDescription = "x".repeat(900_000);
            await collectMessage(model, {
                messages: [
                    {
                        role: "system",
                        content: "",
                        toolsAdded: [{
                            name: "bulk",
                            description: bulkyDescription,
                            parameters: { type: "object", properties: {} },
                        }],
                    },
                    user,
                    first,
                    { role: "user", content: "ok; remind me", timestamp: 2 },
                ],
            } as unknown as Context);

            assert.equal(requests.length, 2);
            assert.equal(requests[0]?.store, true);
            assert.equal(requests[1]?.store, true);
            assert.equal(requests[1]?.previous_response_id, "response-live");
            const secondTools = requests[1]?.tools;
            assert.ok(Array.isArray(secondTools));
            assert.ok(
                JSON.stringify(secondTools).includes(bulkyDescription),
                "second request should serialize the oversized tool description",
            );
        } finally {
            defaultXaiWsSessionPool.closeAll();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("re-enables storage after Pi converts a compaction summary to a user message", async () => {
        const requests: Array<Record<string, unknown>> = [];
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        assert.ok(address && typeof address === "object");
        process.env.PI_XAI_WS_STORE = "1";
        process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS = "220000";
        process.env.PI_XAI_WS_URL = `ws://127.0.0.1:${address.port}`;
        server.on("connection", (socket) => {
            socket.on("message", (frame) => {
                requests.push(JSON.parse(frame.toString()) as Record<string, unknown>);
                send(socket, {
                    response: { id: "response-compacted", output: [], status: "completed" },
                    type: "response.completed",
                });
            });
        });

        const staleAssistant: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "retained answer" }],
            api: "openai-responses",
            provider: "xai",
            model: "grok-4.7",
            usage: {
                input: 250_000,
                output: 100,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 250_100,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 90,
        };

        try {
            const model = responsesModel();
            await collectMessage(model, {
                messages: [
                    { role: "user", content: "before compaction", timestamp: 1 },
                    staleAssistant,
                    { role: "user", content: "continue", timestamp: 2 },
                ],
            });
            const summary = "The conversation history before this point was compacted into the following summary:\n\n<summary>\nsmall summary\n</summary>";
            await collectMessage(model, {
                messages: [
                    { role: "user", content: [{ type: "text", text: summary }], timestamp: 100 },
                    staleAssistant,
                    { role: "user", content: "after compaction", timestamp: 110 },
                ],
            });

            assert.equal(requests[0]?.store, false);
            assert.equal(requests[1]?.store, true);
            assert.equal(requests[1]?.previous_response_id, undefined);
        } finally {
            defaultXaiWsSessionPool.closeAll();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("prevents a payload hook from restoring storage after a safety downgrade", async () => {
        const requests: Array<Record<string, unknown>> = [];
        let toJsonCalls = 0;
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        assert.ok(address && typeof address === "object");
        process.env.PI_XAI_WS_STORE = "1";
        process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS = "1";
        process.env.PI_XAI_WS_URL = `ws://127.0.0.1:${address.port}`;
        server.on("connection", (socket) => {
            socket.on("message", (frame) => {
                requests.push(JSON.parse(frame.toString()) as Record<string, unknown>);
                send(socket, {
                    response: { id: "response-hook", output: [], status: "completed" },
                    type: "response.completed",
                });
            });
        });

        try {
            await collectMessage(
                responsesModel(),
                { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                {
                    onPayload: (payload) => ({
                        ...payload as Record<string, unknown>,
                        previous_response_id: "response-forced",
                        probe: {
                            toJSON: () => {
                                toJsonCalls += 1;
                                return "normalized";
                            },
                        },
                        store: true,
                    }),
                },
            );

            assert.equal(requests[0]?.store, false);
            assert.equal(requests[0]?.previous_response_id, undefined);
            assert.equal(toJsonCalls, 1);
        } finally {
            defaultXaiWsSessionPool.closeAll();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("does not pre-normalize or estimate payloads when stored responses are off", async () => {
        let toJsonCalls = 0;
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        assert.ok(address && typeof address === "object");
        process.env.PI_XAI_WS_STORE = "0";
        process.env.PI_XAI_WS_URL = `ws://127.0.0.1:${address.port}`;
        server.on("connection", (socket) => {
            socket.on("message", () => {
                send(socket, {
                    response: { id: "response-default-off", output: [], status: "completed" },
                    type: "response.completed",
                });
            });
        });

        try {
            await collectMessage(
                responsesModel(),
                { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                {
                    onPayload: (payload) => ({
                        ...payload as Record<string, unknown>,
                        probe: {
                            toJSON: () => {
                                toJsonCalls += 1;
                                return "normalized";
                            },
                        },
                    }),
                },
            );

            assert.equal(toJsonCalls, 1);
        } finally {
            defaultXaiWsSessionPool.closeAll();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("forwards parsed provider events to Pi's stream event hook", async () => {
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        assert.ok(address && typeof address === "object");
        process.env.PI_XAI_WS_STORE = "0";
        process.env.PI_XAI_WS_URL = `ws://127.0.0.1:${address.port}`;
        server.on("connection", (socket) => {
            socket.on("message", () => {
                send(socket, {
                    response: { id: "response-provider-events" },
                    type: "response.created",
                });
                send(socket, {
                    response: { id: "response-provider-events", output: [], status: "completed" },
                    type: "response.completed",
                });
            });
        });

        const seen: string[] = [];
        try {
            await collectMessage(
                responsesModel(),
                { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                {
                    onProviderStreamEvent: (event) => {
                        seen.push((event as { type: string }).type);
                    },
                },
            );

            assert.deepEqual(seen, ["response.created", "response.completed"]);
        } finally {
            defaultXaiWsSessionPool.closeAll();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("projects real response events before slicing the next Pi payload", async () => {
        const requests: Array<Record<string, unknown>> = [];
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        assert.ok(address && typeof address === "object");
        process.env.PI_XAI_WS_STORE = "1";
        process.env.PI_XAI_WS_URL = `ws://127.0.0.1:${address.port}`;

        const reasoning = {
            encrypted_content: "encrypted-reasoning",
            id: "rs_1",
            status: "completed",
            summary: [{ text: "checked the command", type: "summary_text" }],
            type: "reasoning",
        };
        const functionCall = {
            arguments: JSON.stringify({ command: "echo ok" }),
            call_id: "call_1",
            id: "fc_1",
            name: "bash",
            status: "completed",
            type: "function_call",
        };
        server.on("connection", (socket) => {
            socket.on("message", (frame) => {
                const payload = JSON.parse(frame.toString()) as Record<string, unknown>;
                requests.push(payload);
                if (requests.length === 1) {
                    send(socket, { response: { id: "response-1" }, type: "response.created" });
                    send(socket, { item: reasoning, output_index: 0, type: "response.output_item.added" });
                    send(socket, { item: reasoning, output_index: 0, type: "response.output_item.done" });
                    send(socket, { item: functionCall, output_index: 1, type: "response.output_item.added" });
                    send(socket, { item: functionCall, output_index: 1, type: "response.output_item.done" });
                    send(socket, {
                        response: {
                            id: "response-1",
                            output: [
                                reasoning,
                                { id: "ws_1", status: "completed", type: "web_search_call" },
                                functionCall,
                            ],
                            status: "completed",
                        },
                        type: "response.completed",
                    });
                } else {
                    send(socket, {
                        response: { id: "response-1", output: [], status: "completed" },
                        type: "response.completed",
                    });
                }
            });
        });

        try {
            const model = responsesModel();
            const user = { role: "user" as const, content: "run the command", timestamp: 1 };
            const first = await collectMessage(model, { messages: [user] });
            const toolCall = first.content.find((block) => block.type === "toolCall");
            assert.ok(toolCall);
            const toolResult: ToolResultMessage = {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [{ type: "text", text: "ok" }],
                isError: false,
                timestamp: 2,
            };

            await collectMessage(model, { messages: [user, first, toolResult] });

            assert.equal(requests.length, 2);
            assert.equal(requests[0]?.store, true);
            assert.equal(requests[0]?.previous_response_id, undefined);
            assert.equal(requests[1]?.previous_response_id, "response-1");
            assert.deepEqual(requests[1]?.input, [{
                call_id: "call_1",
                output: "ok",
                type: "function_call_output",
            }]);
        } finally {
            defaultXaiWsSessionPool.closeAll();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});

describe("stream reasoning-only replay", () => {
    function reasoningAttempt(fail: boolean): Array<Record<string, unknown>> {
        const events: Array<Record<string, unknown>> = [
            { type: "response.created", response: { id: fail ? "resp-fail" : "resp-ok" } },
            {
                item: { id: `rs-${fail ? "1" : "2"}`, type: "reasoning" },
                output_index: 0,
                type: "response.output_item.added",
            },
        ];
        if (fail) {
            events.push({
                delta: "attempt one thinking",
                output_index: 0,
                type: "response.reasoning_text.delta",
            });
            return events;
        }
        events.push(
            {
                delta: "attempt two thinking",
                output_index: 0,
                type: "response.reasoning_text.delta",
            },
            {
                item: { id: "msg-1", type: "message" },
                output_index: 1,
                type: "response.output_item.added",
            },
            {
                delta: "final answer",
                output_index: 1,
                type: "response.output_text.delta",
            },
            {
                response: { id: "resp-ok", output: [], status: "completed" },
                type: "response.completed",
            },
        );
        return events;
    }

    function stubIterate(
        script: (call: number) => { events: Array<Record<string, unknown>>; error?: Error },
    ): {
        calls: () => number;
        restore: () => void;
    } {
        const originalIterate = defaultXaiWsSessionPool.iterate;
        let callCount = 0;
        defaultXaiWsSessionPool.iterate = async function* () {
            callCount += 1;
            const step = script(callCount);
            for (const event of step.events) {
                yield event;
            }
            if (step.error) {
                throw step.error;
            }
        };
        return {
            calls: () => callCount,
            restore: () => {
                defaultXaiWsSessionPool.iterate = originalIterate;
            },
        };
    }

    const socketDrop = (): XaiWsTransportError =>
        new XaiWsTransportError("xAI WebSocket closed (1006)", {
            kind: "socket",
            outputStarted: true,
        });

    it("replays once when only reasoning streamed and recovers", async () => {
        process.env.PI_XAI_WS_STORE = "0";
        process.env.PI_XAI_WS_REASONING_REPLAY = "1";
        const stub = stubIterate((call) =>
            call === 1
                ? { events: reasoningAttempt(true), error: socketDrop() }
                : { events: reasoningAttempt(false) },
        );
        try {
            const message = await collectMessage(
                responsesModel(),
                { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                { sessionId: "stream-replay-recover" },
            );

            assert.equal(stub.calls(), 2);
            assert.equal(message.responseId, "resp-ok");
            assert.notEqual(message.stopReason, "error");
            const thinking = message.content.filter((block) => block.type === "thinking");
            const texts = message.content.filter((block) => block.type === "text");
            assert.equal(thinking.length, 1);
            assert.deepEqual(thinking[0], { type: "thinking", thinking: "attempt two thinking" });
            assert.equal(texts.length, 1);
            assert.deepEqual(texts[0], { type: "text", text: "final answer" });
        } finally {
            stub.restore();
        }
    });

    it("does not replay after text streamed", async () => {
        process.env.PI_XAI_WS_STORE = "0";
        const stub = stubIterate((call) => {
            if (call > 1) {
                return { events: reasoningAttempt(false) };
            }
            return {
                events: [
                    ...reasoningAttempt(true),
                    {
                        item: { id: "msg-early", type: "message" },
                        output_index: 1,
                        type: "response.output_item.added",
                    },
                    {
                        delta: "committed text",
                        output_index: 1,
                        type: "response.output_text.delta",
                    },
                ],
                error: socketDrop(),
            };
        });
        try {
            await assert.rejects(
                () => collectMessage(
                    responsesModel(),
                    { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                    { sessionId: "stream-replay-after-text" },
                ),
                /WebSocket error: xAI WebSocket closed \(1006\)/,
            );
            assert.equal(stub.calls(), 1);
        } finally {
            stub.restore();
        }
    });

    it("does not replay when no model output started", async () => {
        process.env.PI_XAI_WS_STORE = "0";
        const stub = stubIterate(() => ({
            events: [],
            error: new XaiWsTransportError("xAI WebSocket closed (1006)", {
                kind: "socket",
                outputStarted: false,
            }),
        }));
        try {
            await assert.rejects(
                () => collectMessage(
                    responsesModel(),
                    { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                    { sessionId: "stream-replay-pre-output" },
                ),
                /WebSocket error: xAI WebSocket closed \(1006\)/,
            );
            assert.equal(stub.calls(), 1);
        } finally {
            stub.restore();
        }
    });

    it("replays at most once", async () => {
        process.env.PI_XAI_WS_STORE = "0";
        let callCount = 0;
        const originalIterate = defaultXaiWsSessionPool.iterate;
        defaultXaiWsSessionPool.iterate = async function* () {
            callCount += 1;
            for (const event of reasoningAttempt(true)) {
                yield event;
            }
            throw new XaiWsTransportError("xAI WebSocket closed (1006)", {
                kind: "socket",
                outputStarted: true,
            });
        };
        try {
            await assert.rejects(
                () => collectMessage(
                    responsesModel(),
                    { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                    { sessionId: "stream-replay-bounded" },
                ),
                /WebSocket error: xAI WebSocket closed \(1006\)/,
            );
            assert.equal(callCount, 2);
        } finally {
            defaultXaiWsSessionPool.iterate = originalIterate;
        }
    });

    it("respects PI_XAI_WS_REASONING_REPLAY=0", async () => {
        process.env.PI_XAI_WS_STORE = "0";
        process.env.PI_XAI_WS_REASONING_REPLAY = "0";
        let callCount = 0;
        const originalIterate = defaultXaiWsSessionPool.iterate;
        defaultXaiWsSessionPool.iterate = async function* () {
            callCount += 1;
            for (const event of reasoningAttempt(true)) {
                yield event;
            }
            throw new XaiWsTransportError("xAI WebSocket closed (1006)", {
                kind: "socket",
                outputStarted: true,
            });
        };
        try {
            await assert.rejects(
                () => collectMessage(
                    responsesModel(),
                    { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                    { sessionId: "stream-replay-disabled" },
                ),
                /WebSocket error: xAI WebSocket closed \(1006\)/,
            );
            assert.equal(callCount, 1);
        } finally {
            defaultXaiWsSessionPool.iterate = originalIterate;
        }
    });

    it("does not replay after provider-tool activity", async () => {
        process.env.PI_XAI_WS_STORE = "0";
        process.env.PI_XAI_WS_REASONING_REPLAY = "1";
        const stub = stubIterate((call) => {
            if (call > 1) {
                return { events: reasoningAttempt(false) };
            }
            return {
                events: [
                    ...reasoningAttempt(true),
                    { type: "response.web_search_call.in_progress" },
                ],
                error: socketDrop(),
            };
        });
        try {
            await assert.rejects(
                () => collectMessage(
                    responsesModel(),
                    { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                    { sessionId: "stream-replay-provider-tool" },
                ),
                /WebSocket error: xAI WebSocket closed \(1006\)/,
            );
            assert.equal(stub.calls(), 1);
        } finally {
            stub.restore();
        }
    });

    it("does not replay when the request aborted during the failure", async () => {
        process.env.PI_XAI_WS_STORE = "0";
        process.env.PI_XAI_WS_REASONING_REPLAY = "1";
        let callCount = 0;
        const controller = new AbortController();
        const originalIterate = defaultXaiWsSessionPool.iterate;
        defaultXaiWsSessionPool.iterate = async function* () {
            callCount += 1;
            for (const event of reasoningAttempt(true)) {
                yield event;
            }
            controller.abort();
            throw socketDrop();
        };
        try {
            await assert.rejects(
                () => collectMessage(
                    responsesModel(),
                    { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                    { sessionId: "stream-replay-aborted", signal: controller.signal },
                ),
                /WebSocket error: xAI WebSocket closed \(1006\)/,
            );
            assert.equal(callCount, 1);
        } finally {
            defaultXaiWsSessionPool.iterate = originalIterate;
        }
    });

    it("resends full local history without stored continuation when replaying in stored mode", async () => {
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const requests: Array<Record<string, unknown>> = [];
        let connections = 0;
        server.on("connection", (socket) => {
            connections += 1;
            socket.on("message", (frame) => {
                requests.push(JSON.parse(frame.toString()) as Record<string, unknown>);
                if (connections === 1) {
                    send(socket, {
                        type: "response.created",
                        response: { id: "resp-stored-drop" },
                    });
                    send(socket, {
                        item: { id: "rs-stored-drop", type: "reasoning" },
                        output_index: 0,
                        type: "response.output_item.added",
                    });
                    send(socket, {
                        delta: "stored thinking before the drop",
                        output_index: 0,
                        type: "response.reasoning_text.delta",
                    });
                    socket.terminate();
                    return;
                }
                send(socket, {
                    response: { id: "resp-stored-recovered", output: [], status: "completed" },
                    type: "response.completed",
                });
            });
        });
        process.env.PI_XAI_WS_STORE = "1";
        process.env.PI_XAI_WS_REASONING_REPLAY = "1";
        process.env.PI_XAI_WS_URL = `ws://127.0.0.1:${address.port}`;

        try {
            const message = await collectMessage(
                responsesModel(),
                { messages: [{ role: "user", content: "stored replay", timestamp: 1 }] },
                { sessionId: "stream-replay-stored-mode" },
            );

            assert.equal(connections, 2);
            assert.notEqual(message.stopReason, "error");
            assert.equal(requests.length, 2);
            assert.equal(requests[0]?.store, true);
            assert.equal(requests[1]?.store, true);
            assert.equal(requests[1]?.previous_response_id, undefined);
            const secondInput = requests[1]?.input as Array<Record<string, unknown>>;
            assert.ok(Array.isArray(secondInput));
            assert.ok(secondInput.some((item) => item.role === "user"));
        } finally {
            defaultXaiWsSessionPool.closeAll();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("recovers from an abrupt mid-reasoning socket drop on a real socket", async () => {
        process.env.PI_XAI_WS_REASONING_REPLAY = "1";
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        assert.ok(address && typeof address === "object");
        let connections = 0;
        server.on("connection", (socket) => {
            connections += 1;
            socket.once("message", () => {
                if (connections === 1) {
                    send(socket, {
                        type: "response.created",
                        response: { id: "resp-dropped" },
                    });
                    send(socket, {
                        item: { id: "rs-drop", type: "reasoning" },
                        output_index: 0,
                        type: "response.output_item.added",
                    });
                    send(socket, {
                        delta: "thinking before the drop",
                        output_index: 0,
                        type: "response.reasoning_text.delta",
                    });
                    socket.terminate();
                    return;
                }
                send(socket, {
                    type: "response.created",
                    response: { id: "resp-recovered" },
                });
                send(socket, {
                    item: { id: "rs-recovered", type: "reasoning" },
                    output_index: 0,
                    type: "response.output_item.added",
                });
                send(socket, {
                    delta: "thinking after reconnect",
                    output_index: 0,
                    type: "response.reasoning_text.delta",
                });
                send(socket, {
                    item: { id: "msg-recovered", type: "message" },
                    output_index: 1,
                    type: "response.output_item.added",
                });
                send(socket, {
                    delta: "recovered answer",
                    output_index: 1,
                    type: "response.output_text.delta",
                });
                send(socket, {
                    response: { id: "resp-recovered", output: [], status: "completed" },
                    type: "response.completed",
                });
            });
        });
        process.env.PI_XAI_WS_STORE = "0";
        process.env.PI_XAI_WS_URL = `ws://127.0.0.1:${address.port}`;

        try {
            const message = await collectMessage(
                responsesModel(),
                { messages: [{ role: "user", content: "first", timestamp: 1 }] },
                { sessionId: "stream-replay-real-socket" },
            );

            assert.equal(connections, 2);
            assert.equal(message.responseId, "resp-recovered");
            assert.notEqual(message.stopReason, "error");
            const thinking = message.content.filter((block) => block.type === "thinking");
            const texts = message.content.filter((block) => block.type === "text");
            assert.equal(thinking.length, 1);
            assert.deepEqual(thinking[0], { type: "thinking", thinking: "thinking after reconnect" });
            assert.equal(texts.length, 1);
            assert.deepEqual(texts[0], { type: "text", text: "recovered answer" });
        } finally {
            defaultXaiWsSessionPool.closeAll();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
