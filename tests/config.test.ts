import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { cacheAffinityEnabled, resolveWsUrl, storeResponsesEnabled } from "../src/config.ts";

function withConfigPath(run: (configPath: string) => void): void {
    const tmpRoot = join(process.cwd(), "tmp");
    mkdirSync(tmpRoot, { recursive: true });
    const configDir = mkdtempSync(join(tmpRoot, "pi-xai-ws-config-"));
    try {
        run(join(configDir, "pi-xai-ws.json"));
    } finally {
        rmSync(configDir, { force: true, recursive: true });
    }
}

describe("storeResponsesEnabled", () => {
    it("is off without a config file and accepts only boolean true", () => {
        const previous = process.env.PI_XAI_WS_STORE;
        try {
            delete process.env.PI_XAI_WS_STORE;
            withConfigPath((configPath) => {
                assert.equal(storeResponsesEnabled(configPath), false);
                writeFileSync(configPath, JSON.stringify({ storeResponses: false }));
                assert.equal(storeResponsesEnabled(configPath), false);
                for (const invalid of [
                    { storeResponses: "true" },
                    { storeResponses: 1 },
                    {},
                    [],
                    true,
                ]) {
                    writeFileSync(configPath, JSON.stringify(invalid));
                    assert.equal(storeResponsesEnabled(configPath), false);
                }
                writeFileSync(configPath, "not json");
                assert.equal(storeResponsesEnabled(configPath), false);
                writeFileSync(configPath, JSON.stringify({ storeResponses: true }));
                assert.equal(storeResponsesEnabled(configPath), true);
            });
        } finally {
            if (previous === undefined) {
                delete process.env.PI_XAI_WS_STORE;
            } else {
                process.env.PI_XAI_WS_STORE = previous;
            }
        }
    });

    it("reads the default path from Pi's global agent directory", () => {
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousStore = process.env.PI_XAI_WS_STORE;
        try {
            delete process.env.PI_XAI_WS_STORE;
            withConfigPath((configPath) => {
                process.env.PI_CODING_AGENT_DIR = dirname(configPath);
                writeFileSync(configPath, JSON.stringify({ storeResponses: true }));
                assert.equal(storeResponsesEnabled(), true);
            });
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
            if (previousStore === undefined) {
                delete process.env.PI_XAI_WS_STORE;
            } else {
                process.env.PI_XAI_WS_STORE = previousStore;
            }
        }
    });

    it("lets an explicit environment value override the config file", () => {
        const previous = process.env.PI_XAI_WS_STORE;
        try {
            withConfigPath((configPath) => {
                writeFileSync(configPath, JSON.stringify({ storeResponses: true }));
                for (const value of ["", "0", "false", "no", "on", "yes"]) {
                    process.env.PI_XAI_WS_STORE = value;
                    assert.equal(storeResponsesEnabled(configPath), false);
                }
                for (const value of ["1", " 1 ", "true", "TRUE"]) {
                    process.env.PI_XAI_WS_STORE = value;
                    assert.equal(storeResponsesEnabled(configPath), true);
                }
            });
        } finally {
            if (previous === undefined) {
                delete process.env.PI_XAI_WS_STORE;
            } else {
                process.env.PI_XAI_WS_STORE = previous;
            }
        }
    });
});

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
