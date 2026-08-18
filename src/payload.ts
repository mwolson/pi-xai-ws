import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import {
    convertResponsesMessages,
    convertResponsesTools,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

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

export function buildResponseCreate(
    model: Model,
    context: Context,
    options?: SimpleStreamOptions,
): Record<string, unknown> {
    const tools = context.tools ?? [];
    const payload: Record<string, unknown> = {
        type: "response.create",
        model: model.id,
        store: false,
        input: convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS),
        prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId),
    };

    if (options?.maxTokens) {
        payload.max_output_tokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
        payload.temperature = options.temperature;
    }
    if (tools.length > 0) {
        payload.tools = convertResponsesTools(tools);
    }

    if (model.reasoning) {
        payload.include = ["reasoning.encrypted_content"];
        const requested = options?.reasoning;
        if (requested && requested !== "off") {
            const clamped = clampThinkingLevel(model, requested);
            if (clamped !== "off") {
                const mapped = model.thinkingLevelMap?.[clamped];
                payload.reasoning = {
                    effort: mapped ?? clamped,
                    summary: "auto",
                };
            }
        }
    }

    if (options?.samplingParams) {
        Object.assign(payload, options.samplingParams);
    }

    return payload;
}

export function upgradeHeaders(apiKey: string, options?: SimpleStreamOptions): Record<string, string> {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
    };
    if (options?.sessionId) {
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
