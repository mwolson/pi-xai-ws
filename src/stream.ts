import {
    createAssistantMessageEventStream,
    type AssistantMessage,
    type Context,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
    reasoningReplayEnabled,
    resolveMaxRequestImageBytes,
    resolveMaxStoredContextTokens,
    resolveRequestLiveness,
    resolveWsUrl,
    storeResponsesEnabled,
} from "./config.ts";
import { isStoredResponseTooLargeMessage } from "./continuation.ts";
import { normalizeXaiErrorMessage } from "./errors.ts";
import { limitContextImageBytes, sanitizeContextMessages } from "./history.ts";
import { processResponsesStreamFn } from "./pi-ai-api.ts";
import {
    buildResponseCreate,
    prepareResponseOptions,
    projectAssistantResponse,
    resolveApiKey,
    upgradeHeaders,
} from "./payload.ts";
import {
    estimateStoredRequestTokens,
    hasStoredResponseTooLarge,
    markStoredResponseTooLarge,
    setStoredContextSafetyActive,
} from "./stored-context.ts";
import {
    isReasoningOnlyOutputEvent,
    isReplayableTransportError,
    iterateXaiWsSessionEvents,
    normalizeWireRecordWithSize,
} from "./ws-events.ts";

function freshUsage(): AssistantMessage["usage"] {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

/**
 * Pi consumes `partial` events as snapshots of one mutated AssistantMessage,
 * so clearing the partial before an in-turn replay keeps the final message and
 * the streaming view consistent without ending the stream.
 */
function resetPartialForReplay(output: AssistantMessage): void {
    output.content = [];
    output.responseId = undefined;
    output.stopReason = "pending";
    output.errorMessage = undefined;
    (output as { rawStopReason?: unknown }).rawStopReason = undefined;
    output.usage = freshUsage();
}

/**
 * Tracks whether every raw event observed so far in the current attempt is
 * safe to re-emit on a replay: no text, tool calls, refusals, or provider-tool
 * lifecycle activity, only reasoning-family events. Provider-tool events are
 * observable through provider-stream hooks even when they add no content
 * block, so they must disqualify the replay on their own.
 */
class ReplayEligibility {
    private reasoningOnly = true;

    observe(event: Record<string, unknown>): void {
        if (!isReasoningOnlyOutputEvent(event)) {
            this.reasoningOnly = false;
        }
    }

    get eligible(): boolean {
        return this.reasoningOnly;
    }
}

/**
 * A replayable transport failure after only reasoning blocks streamed can be
 * recovered inside the same Pi turn: reasoning has no committed text or tool
 * calls, and Pi rebuilds the partial message from snapshots. One silent
 * reconnect here avoids a visible turn error and Pi's much slower outer retry
 * when it succeeds. Anything the user or hooks could already have observed
 * beyond reasoning disqualifies the replay and leaves recovery to Pi.
 */
function isReasoningOnlyReplayable(
    error: unknown,
    output: AssistantMessage,
    eligibility: ReplayEligibility,
    signal?: AbortSignal,
): boolean {
    return signal?.aborted !== true &&
        eligibility.eligible &&
        isReplayableTransportError(error) &&
        error.outputStarted &&
        output.content.length > 0 &&
        output.content.every((block) => block.type === "thinking");
}

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
            usage: freshUsage(),
            stopReason: "pending",
            timestamp: Date.now(),
        };

        try {
            const apiKey = resolveApiKey(options);
            const sessionId = typeof options?.sessionId === "string" ? options.sessionId.trim() : "";
            const providerContext = limitContextImageBytes(
                sanitizeContextMessages(context),
                resolveMaxRequestImageBytes(),
                sessionId || undefined,
            );
            const preparedOptions = prepareResponseOptions(model, providerContext, options, apiKey);
            const storageConfigured = storeResponsesEnabled() &&
                Boolean(preparedOptions.sessionId?.trim());
            let payload = buildResponseCreate(model, providerContext, preparedOptions);
            const nextPayload = await preparedOptions.onPayload?.(payload, model);
            if (nextPayload !== undefined && nextPayload !== null && typeof nextPayload === "object") {
                payload = nextPayload as Record<string, unknown>;
            }

            let payloadNormalized = false;
            let storeResponses = false;
            if (storageConfigured) {
                const normalized = normalizeWireRecordWithSize(payload);
                payload = normalized.payload;
                payloadNormalized = true;
                const maxStoredContextTokens = resolveMaxStoredContextTokens();
                const rejectedStore = hasStoredResponseTooLarge(
                    preparedOptions.sessionId,
                    providerContext.messages,
                );
                let overThreshold = false;
                if (maxStoredContextTokens !== undefined) {
                    const contextTokens = estimateStoredRequestTokens(
                        providerContext.messages,
                        normalized.tokenEstimate,
                    );
                    overThreshold = contextTokens >= maxStoredContextTokens;
                    if (overThreshold && process.env.PI_XAI_WS_DEBUG === "1") {
                        process.stderr.write(
                            `[pi-xai-ws] storage disabled for oversized context context_tokens=${contextTokens} threshold=${maxStoredContextTokens} rejected=${rejectedStore}\n`,
                        );
                    }
                }
                storeResponses = !overThreshold && !rejectedStore;
            }
            setStoredContextSafetyActive(
                preparedOptions.sessionId,
                storageConfigured && !storeResponses,
            );
            if (payloadNormalized) {
                payload.store = storeResponses;
            } else {
                payload = { ...payload, store: storeResponses };
            }
            delete payload.previous_response_id;

            stream.push({ type: "start", partial: output });

            const requestLiveness = resolveRequestLiveness(preparedOptions.timeoutMs);
            if (process.env.PI_XAI_WS_DEBUG === "1") {
                process.stderr.write(
                    `[pi-xai-ws] timeouts connect_ms=${preparedOptions.websocketConnectTimeoutMs ?? "default"} ping_ms=${requestLiveness.pingIntervalMs} idle_after_ping_ms=${requestLiveness.livenessTimeoutMs}\n`,
                );
            }
            let reasoningOnlyReplays = 0;
            let responseReported = false;
            while (true) {
                const eligibility = new ReplayEligibility();
                const events = iterateXaiWsSessionEvents({
                    url: resolveWsUrl(model.baseUrl),
                    headers: upgradeHeaders(apiKey, preparedOptions),
                    createPayload: payload,
                    sessionId: preparedOptions.sessionId,
                    signal: preparedOptions.signal,
                    connectTimeoutMs: preparedOptions.websocketConnectTimeoutMs,
                    livenessTimeoutMs: requestLiveness.livenessTimeoutMs,
                    pingIntervalMs: requestLiveness.pingIntervalMs,
                    onOpen: async (response) => {
                        if (responseReported) {
                            return;
                        }
                        responseReported = true;
                        await preparedOptions.onResponse?.(response, model);
                    },
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
                try {
                    await processResponsesStreamFn(
                        events as Parameters<typeof processResponsesStreamFn>[0],
                        output,
                        stream,
                        model,
                        {
                            onProviderStreamEvent: async (event, eventModel) => {
                                eligibility.observe(event as Record<string, unknown>);
                                await preparedOptions.onProviderStreamEvent?.(event, eventModel);
                            },
                        },
                    );
                } catch (error) {
                    if (
                        reasoningOnlyReplays < 1 &&
                        reasoningReplayEnabled() &&
                        isReasoningOnlyReplayable(error, output, eligibility, preparedOptions.signal)
                    ) {
                        reasoningOnlyReplays += 1;
                        if (process.env.PI_XAI_WS_DEBUG === "1") {
                            const reason = error instanceof Error ? error.message : String(error);
                            process.stderr.write(
                                `[pi-xai-ws] reasoning-only replay after transport failure: ${reason}\n`,
                            );
                        }
                        resetPartialForReplay(output);
                        continue;
                    }
                    throw error;
                }
                break;
            }

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
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (
                !aborted &&
                output.content.length > 0 &&
                isStoredResponseTooLargeMessage(errorMessage)
            ) {
                markStoredResponseTooLarge(
                    typeof options?.sessionId === "string" ? options.sessionId : undefined,
                );
                output.stopReason = output.content.some((block) => block.type === "toolCall")
                    ? "toolUse"
                    : "stop";
                output.errorMessage = undefined;
                stream.push({
                    type: "done",
                    reason: output.stopReason,
                    message: output,
                });
                stream.end();
                return;
            }
            output.stopReason = aborted ? "aborted" : "error";
            output.errorMessage = normalizeXaiErrorMessage(
                errorMessage,
                isReplayableTransportError(error),
            );
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    })();

    return stream;
}
