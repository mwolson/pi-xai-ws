import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { XAI_RESPONSES_API } from "../src/provider.ts";

describe("Pi's current xAI catalog", () => {
    it("keeps grok-4.6 on the Responses API", async () => {
        const response = await fetch("https://pi.dev/api/models/providers/xai", {
            signal: AbortSignal.timeout(10_000),
        });
        assert.equal(response.ok, true, `Pi catalog returned HTTP ${response.status}`);
        const catalog = await response.json() as Record<string, { api?: string; provider?: string }>;
        assert.equal(catalog["grok-4.6"]?.provider, "xai");
        assert.equal(catalog["grok-4.6"]?.api, XAI_RESPONSES_API);
    });
});
