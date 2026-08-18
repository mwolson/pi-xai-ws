import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isResponsesThinkingSignature, sanitizeContextMessages } from "../src/history.ts";

describe("isResponsesThinkingSignature", () => {
    it("accepts a Responses reasoning item", () => {
        assert.equal(
            isResponsesThinkingSignature(JSON.stringify({ type: "reasoning", id: "rs_1" })),
            true,
        );
    });

    it("rejects Completions field names", () => {
        assert.equal(isResponsesThinkingSignature("reasoning_content"), false);
        assert.equal(isResponsesThinkingSignature("reasoning"), false);
        assert.equal(isResponsesThinkingSignature("reasoning_text"), false);
    });

    it("rejects arrays and invalid JSON", () => {
        assert.equal(isResponsesThinkingSignature("[]"), false);
        assert.equal(isResponsesThinkingSignature("{"), false);
    });
});

describe("sanitizeContextMessages", () => {
    it("strips Completions thinking signatures and keeps Responses ones", () => {
        const responsesSignature = JSON.stringify({ type: "reasoning", id: "rs_1" });
        const context = {
            systemPrompt: "sys",
            messages: [
                { role: "user", content: "hi" },
                {
                    role: "assistant",
                    api: "openai-completions",
                    provider: "xai",
                    model: "grok-4.6",
                    content: [
                        { type: "thinking", thinking: "old", thinkingSignature: "reasoning_content" },
                        { type: "thinking", thinking: "new", thinkingSignature: responsesSignature },
                        { type: "text", text: "hello" },
                    ],
                },
            ],
        };

        const sanitized = sanitizeContextMessages(context);
        const assistant = sanitized.messages[1] as {
            content: Array<{ type: string; thinkingSignature?: string }>;
        };

        assert.equal(assistant.content[0].thinkingSignature, undefined);
        assert.equal(assistant.content[1].thinkingSignature, responsesSignature);
        assert.equal(
            (context.messages[1] as { content: Array<{ thinkingSignature?: string }> }).content[0]
                .thinkingSignature,
            "reasoning_content",
        );
    });
});
