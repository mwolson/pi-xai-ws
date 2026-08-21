import {
    createAssistantMessageEventStream,
    type AssistantMessage,
    type Context,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { resolveWsUrl, storeResponsesEnabled } from "./config.ts";
import { normalizeXaiErrorMessage } from "./errors.ts";
import { processResponsesStreamFn } from "./pi-ai-api.ts";
import {
    buildResponseCreate,
    prepareResponseOptions,
    projectAssistantResponse,
    resolveApiKey,
    upgradeHeaders,
} from "./payload.ts";
import { iterateXaiWsSessionEvents } from "./ws-events.ts";

export function streamXaiResponsesWs(
    model: Model<"openai-responses">,
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
            const preparedOptions = prepareResponseOptions(model, context, options, apiKey);
            const storeResponses = storeResponsesEnabled() &&
                Boolean(preparedOptions.sessionId?.trim());
            let payload = buildResponseCreate(model, context, preparedOptions);
            const nextPayload = await preparedOptions.onPayload?.(payload, model);
            if (nextPayload !== undefined && nextPayload !== null && typeof nextPayload === "object") {
                payload = nextPayload as Record<string, unknown>;
            }
            payload = { ...payload, store: storeResponses };
            delete payload.previous_response_id;

            stream.push({ type: "start", partial: output });

            const events = iterateXaiWsSessionEvents({
                url: resolveWsUrl(model.baseUrl),
                headers: upgradeHeaders(apiKey, preparedOptions),
                createPayload: payload,
                sessionId: preparedOptions.sessionId,
                signal: preparedOptions.signal,
                connectTimeoutMs: preparedOptions.websocketConnectTimeoutMs,
                onOpen: (response) => preparedOptions.onResponse?.(response, model),
                projectStoredOutput: () => {
                    if (
                        output.stopReason === "pending" ||
                        output.stopReason === "error" ||
                        output.stopReason === "aborted"
                    ) {
                        return undefined;
                    }
                    return projectAssistantResponse(model, output);
                },
                storeResponses,
            });
            await processResponsesStreamFn(
                events as Parameters<typeof processResponsesStreamFn>[0],
                output,
                stream,
                model,
            );

            if (preparedOptions.signal?.aborted) {
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
            const errorMessage = error instanceof Error ? error.message : String(error);
            output.errorMessage = normalizeXaiErrorMessage(errorMessage);
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    })();

    return stream;
}
