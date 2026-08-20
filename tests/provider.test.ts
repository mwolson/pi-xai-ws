import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { registerXaiProvider, type XaiStreamSimple, XAI_RESPONSES_API } from "../src/provider.ts";

describe("xAI provider registration", () => {
    it("matches the Responses API in Pi 0.84.2's static xAI catalog", () => {
        const responsesModel = xaiProvider().getModels().find(
            (model) => model.api === XAI_RESPONSES_API,
        );
        assert.ok(responsesModel, "Pi's static xAI provider should include a Responses model");
        let registered: { api: string; streamSimple: unknown } | undefined;
        const streamSimple = (() => "stream") as unknown as XaiStreamSimple;

        const pi = {
            registerProvider: (_provider: string, config: unknown) => {
                registered = config as { api: string; streamSimple: unknown };
            },
        } as unknown as Parameters<typeof registerXaiProvider>[0];

        registerXaiProvider(pi, streamSimple);

        assert.equal(registered?.api, responsesModel.api);
        assert.equal(registered?.streamSimple, streamSimple);

        const extensionSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
        assert.match(extensionSource, /registerXaiProvider\(pi, streamXaiResponsesWs\)/);
        assert.doesNotMatch(extensionSource, /openai-completions/);
    });

});
