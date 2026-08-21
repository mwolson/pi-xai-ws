import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import type { OpenAIResponsesOptions } from "@earendil-works/pi-ai/api/openai-responses";
import {
    buildBaseOptionsFn,
    clampOpenAIPromptCacheKeyFn,
    convertResponsesMessagesFn,
    convertResponsesToolsFn,
} from "./pi-ai-api.ts";
import { cacheAffinityEnabled, storeResponsesEnabled } from "./config.ts";
import { sanitizeContextMessages } from "./history.ts";

const ASSISTANT_RESPONSE_ITEM_TYPES = new Set([
    "custom_tool_call",
    "function_call",
    "message",
    "reasoning",
]);
const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

export function resolveApiKey(options?: SimpleStreamOptions): string {
    if (options?.apiKey) {
        return options.apiKey;
    }
    const headers = options?.headers;
    if (headers) {
        for (const [name, value] of Object.entries(headers)) {
            if (name.toLowerCase() === "authorization" && value && value.trim().length > 0) {
                return value.replace(/^Bearer\s+/i, "").trim();
            }
        }
    }
    throw new Error("No API key for provider: xai");
}

export function prepareResponseOptions(
    model: Model<"openai-responses">,
    context: Context,
    options: SimpleStreamOptions | undefined,
    apiKey: string,
): OpenAIResponsesOptions {
    const base = buildBaseOptionsFn(model, context, options, apiKey) as StreamOptions;
    const clampedReasoning = options?.reasoning
        ? clampThinkingLevel(model, options.reasoning)
        : undefined;
    return {
        ...base,
        reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
    };
}

export function projectAssistantResponse(
    model: Model<"openai-responses">,
    message: AssistantMessage,
): readonly unknown[] {
    const projected = convertResponsesMessagesFn(
        model,
        sanitizeContextMessages({ messages: [message] }),
        OPENAI_TOOL_CALL_PROVIDERS,
    ).filter((item) =>
        typeof item === "object" &&
        item !== null &&
        ASSISTANT_RESPONSE_ITEM_TYPES.has((item as { type?: string }).type ?? "")
    );
    return JSON.parse(JSON.stringify(projected)) as readonly unknown[];
}

export function buildResponseCreate(
    model: Model<"openai-responses">,
    context: Context,
    options?: OpenAIResponsesOptions,
): Record<string, unknown> {
    const tools = context.tools ?? [];
    const payload: Record<string, unknown> = {
        type: "response.create",
        model: model.id,
        store: storeResponsesEnabled(),
        input: convertResponsesMessagesFn(
            model,
            sanitizeContextMessages(context),
            OPENAI_TOOL_CALL_PROVIDERS,
        ),
    };
    if (cacheAffinityEnabled(options?.cacheRetention)) {
        const cacheKey = clampOpenAIPromptCacheKeyFn(options?.sessionId);
        if (cacheKey) {
            payload.prompt_cache_key = cacheKey;
        }
    }

    if (options?.maxTokens) {
        payload.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
    }
    if (options?.temperature !== undefined) {
        payload.temperature = options.temperature;
    }
    if (options?.serviceTier !== undefined) {
        payload.service_tier = options.serviceTier;
    }
    if (tools.length > 0) {
        payload.tools = convertResponsesToolsFn(tools);
    }
    if (options?.toolChoice !== undefined) {
        payload.tool_choice = options.toolChoice;
    }

    if (model.reasoning) {
        payload.include = ["reasoning.encrypted_content"];
        if (options?.reasoningEffort || options?.reasoningSummary) {
            const effort = options.reasoningEffort
                ? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
                : "medium";
            payload.reasoning = {
                effort,
                summary: options.reasoningSummary || "auto",
            };
        } else if (model.thinkingLevelMap?.off !== null) {
            payload.reasoning = {
                effort: model.thinkingLevelMap?.off ?? "none",
            };
        }
    }

    if (options?.samplingParams) {
        Object.assign(payload, options.samplingParams);
    }

    return payload;
}

export function upgradeHeaders(apiKey: string, options?: StreamOptions): Record<string, string> {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
    };
    if (cacheAffinityEnabled(options?.cacheRetention) && options?.sessionId) {
        headers["x-grok-conv-id"] = options.sessionId;
    }
    if (options?.headers) {
        for (const [name, value] of Object.entries(options.headers)) {
            if (value === null || value.trim() === "") {
                continue;
            }
            if (name.toLowerCase() === "authorization") {
                continue;
            }
            headers[name] = value;
        }
    }
    return headers;
}
