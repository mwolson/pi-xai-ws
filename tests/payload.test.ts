import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context, Model } from "@earendil-works/pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import {
    buildResponseCreate,
    prepareResponseOptions,
} from "../src/payload.ts";

function responsesModel(): Model<"openai-responses"> {
    const model = xaiProvider().getModels().find(
        (candidate) => candidate.api === "openai-responses",
    );
    assert.ok(model);
    return model as Model<"openai-responses">;
}

function context(content = "hello"): Context {
    return {
        messages: [{ role: "user", content, timestamp: 1 }],
    };
}

describe("Responses payload tools", () => {
    const tool = {
        name: "bash",
        description: "run a shell command",
        parameters: { type: "object", properties: {} },
    };

    it("declares tools carried by a transcript system message", () => {
        // Tool declarations live on the leading system message. Reading
        // `Context.tools` there declared no tools at all, so Grok improvised
        // tool calls as prose instead of calling them.
        const transcript = {
            messages: [
                { role: "system", content: "You are a coding assistant.", toolsAdded: [tool] },
                { role: "user", content: "hello", timestamp: 1 },
            ],
        };
        const payload = buildResponseCreate(
            responsesModel(),
            transcript as unknown as Context,
            prepareResponseOptions(responsesModel(), context(), undefined, "api-key"),
        );

        const declared = payload.tools as Array<Record<string, unknown>> | undefined;
        assert.ok(Array.isArray(declared), "transcript tool declarations must reach the request");
        assert.equal(declared.length, 1);
        assert.equal(declared[0]?.name, "bash");
    });

    it("omits the tools field when the request declares none", () => {
        assert.equal(buildResponseCreate(responsesModel(), context()).tools, undefined);
    });
});

describe("Responses payload options", () => {
    it("derives Pi's context-aware output cap when maxTokens is omitted", () => {
        const model = responsesModel();
        const prepared = prepareResponseOptions(model, context(), undefined, "api-key");
        const payload = buildResponseCreate(model, context(), prepared);

        assert.ok(prepared.maxTokens !== undefined && prepared.maxTokens > 0);
        assert.ok(prepared.maxTokens <= model.maxTokens);
        assert.equal(payload.max_output_tokens, prepared.maxTokens);
    });

    it("clamps output near the context limit and preserves model sampling parameters", () => {
        const model: Model<"openai-responses"> = {
            ...responsesModel(),
            contextWindow: 4_100,
            maxTokens: 1_000,
            samplingParams: { top_p: 0.8 },
        };
        const prepared = prepareResponseOptions(
            model,
            context("near limit"),
            { samplingParams: { min_p: 0.1 } },
            "api-key",
        );
        const payload = buildResponseCreate(model, context("near limit"), prepared);

        assert.equal(prepared.maxTokens, 1);
        assert.equal(payload.max_output_tokens, 16);
        assert.equal(payload.top_p, 0.8);
        assert.equal(payload.min_p, 0.1);
    });
});
