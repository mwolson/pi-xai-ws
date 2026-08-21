import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { WebSocketServer, type WebSocket } from "ws";
import { streamXaiResponsesWs } from "../src/stream.ts";
import { defaultXaiWsSessionPool } from "../src/ws-events.ts";

const previousStore = process.env.PI_XAI_WS_STORE;
const previousUrl = process.env.PI_XAI_WS_URL;

afterEach(() => {
    defaultXaiWsSessionPool.closeAll();
    if (previousStore === undefined) {
        delete process.env.PI_XAI_WS_STORE;
    } else {
        process.env.PI_XAI_WS_STORE = previousStore;
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
    return { ...model, id: "grok-4.6" } as Model<"openai-responses">;
}

async function collectMessage(
    model: Model<"openai-responses">,
    context: Context,
): Promise<AssistantMessage> {
    let message: AssistantMessage | undefined;
    for await (const event of streamXaiResponsesWs(model, context, {
        apiKey: "test-key",
        sessionId: "stream-continuation-session",
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
