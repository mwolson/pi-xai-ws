import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheAffinityEnabled, resolveWsUrl } from "../src/config.ts";

describe("cacheAffinityEnabled", () => {
    it("is on unless retention is none", () => {
        assert.equal(cacheAffinityEnabled(undefined), true);
        assert.equal(cacheAffinityEnabled("short"), true);
        assert.equal(cacheAffinityEnabled("none"), false);
    });
});

describe("resolveWsUrl", () => {
    it("derives the official socket from api.x.ai and refuses a proxy host", () => {
        const previous = process.env.PI_XAI_WS_URL;
        delete process.env.PI_XAI_WS_URL;
        try {
            assert.equal(resolveWsUrl(), "wss://api.x.ai/v1/responses");
            assert.equal(resolveWsUrl("https://api.x.ai/v1"), "wss://api.x.ai/v1/responses");
            assert.throws(
                () => resolveWsUrl("https://proxy.example/v1"),
                /Set PI_XAI_WS_URL/,
            );
        } finally {
            if (previous === undefined) {
                delete process.env.PI_XAI_WS_URL;
            } else {
                process.env.PI_XAI_WS_URL = previous;
            }
        }
    });

    it("lets an explicit URL override a non-xAI baseUrl", () => {
        const previous = process.env.PI_XAI_WS_URL;
        process.env.PI_XAI_WS_URL = "wss://proxy.example/v1/responses";
        try {
            assert.equal(resolveWsUrl("https://proxy.example/v1"), "wss://proxy.example/v1/responses");
        } finally {
            if (previous === undefined) {
                delete process.env.PI_XAI_WS_URL;
            } else {
                process.env.PI_XAI_WS_URL = previous;
            }
        }
    });
});
