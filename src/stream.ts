import {
    createAssistantMessageEventStream,
    type AssistantMessage,
    type Context,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { resolveWsUrl } from "./config.ts";
import { buildResponseCreate, resolveApiKey, upgradeHeaders } from "./payload.ts";
import { iterateXaiWsEvents } from "./ws-events.ts";

export function streamXaiResponsesWs(
    model: Model,
    context: Context,
    options?: SimpleStreamOptions,
) {
    const stream = createAssistantMessageEventStream();

    void (async () => {
        const output: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "pending",
            timestamp: Date.now(),
        };

        try {
            const apiKey = resolveApiKey(options);
            let payload = buildResponseCreate(model, context, options);
            const nextPayload = await options?.onPayload?.(payload, model);
            if (nextPayload !== undefined && nextPayload !== null && typeof nextPayload === "object") {
                payload = nextPayload as Record<string, unknown>;
            }

            stream.push({ type: "start", partial: output });

            await processResponsesStream(
                iterateXaiWsEvents({
                    url: resolveWsUrl(model.baseUrl),
                    headers: upgradeHeaders(apiKey, options),
                    createPayload: payload,
                    signal: options?.signal,
                    connectTimeoutMs: options?.websocketConnectTimeoutMs,
                    onOpen: (response) => options?.onResponse?.(response, model),
                }),
                output,
                stream,
                model,
            );

            if (options?.signal?.aborted) {
                throw new Error("Request was aborted");
            }
            if (output.stopReason === "pending") {
                throw new Error("xAI WebSocket stream ended without a stop reason");
            }
            if (output.stopReason === "error" || output.stopReason === "aborted") {
                throw new Error(output.errorMessage || "An unknown error occurred");
            }

            stream.push({
                type: "done",
                reason: output.stopReason,
                message: output,
            });
            stream.end();
        } catch (error) {
            for (const block of output.content) {
                delete (block as { index?: unknown }).index;
                delete (block as { partialJson?: unknown }).partialJson;
                delete (block as { customInput?: unknown }).customInput;
            }
            const aborted = options?.signal?.aborted === true ||
                (error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted"));
            output.stopReason = aborted ? "aborted" : "error";
            output.errorMessage = error instanceof Error ? error.message : String(error);
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    })();

    return stream;
}
