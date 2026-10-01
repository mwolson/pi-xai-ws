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
                    user,
                    first,
                    { role: "user", content: "ok; remind me", timestamp: 2 },
                ],
                tools: [{
                    name: "bulk",
                    description: bulkyDescription,
                    parameters: { type: "object", properties: {} },
                }] as Context["tools"],
            });

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
