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
