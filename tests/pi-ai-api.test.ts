import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
    assertSupportedPiVersion,
    buildBaseOptionsFn,
    convertResponsesMessagesFn,
    convertResponsesToolsFn,
    processResponsesStreamFn,
    resolveRequestToolsFn,
    resolvePiAiApiFile,
    resolvePiAiDistFile,
} from "../src/pi-ai-api.ts";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const piBin = join(repoRoot, "node_modules", ".bin", "pi");
const extensionPath = join(repoRoot, "src", "index.ts");
const marker = join("@earendil-works", "pi-ai", "dist", "api", "openai-responses-shared.js");

describe("pi-ai API compatibility loader", () => {
    it("finds dist/api from the host CLI path", () => {
        const apiPath = resolvePiAiApiFile("openai-responses-shared");
        assert.equal(existsSync(apiPath), true);
        assert.equal(apiPath.endsWith(join("dist", "api", "openai-responses-shared.js")), true);
    });

    it("follows a global bin symlink to a nested host pi-ai tree", () => {
        const layout = makeGlobalPiLayout();
        try {
            const symlinkRoots =
                createRequire(layout.binPi).resolve.paths("@earendil-works/pi-ai") ?? [];
            const foundFixtureViaSymlink = symlinkRoots
                .map((root) => join(root, marker))
                .find((path) => path.startsWith(layout.root) && existsSync(path));
            assert.equal(foundFixtureViaSymlink, undefined);

            const apiPath = resolvePiAiApiFile("openai-responses-shared", layout.binPi);
            assert.equal(apiPath, join(layout.piAiDist, "api", "openai-responses-shared.js"));
        } finally {
            rmSync(layout.root, { recursive: true, force: true });
        }
    });

    it("loads the Responses helpers used by the transport", () => {
        assert.equal(typeof processResponsesStreamFn, "function");
        assert.equal(typeof convertResponsesMessagesFn, "function");
        assert.equal(typeof convertResponsesToolsFn, "function");
        assert.equal(typeof buildBaseOptionsFn, "function");
    });

    it("still locates dist/api when argv1 is a compiled-binary path", () => {
        const apiPath = resolvePiAiApiFile("openai-responses-shared", "/$bunfs/root/pi");
        assert.equal(existsSync(apiPath), true);
        assert.equal(apiPath.endsWith(join("dist", "api", "openai-responses-shared.js")), true);
    });

    it("finds dist/utils helpers next to dist/api", () => {
        const layout = makeGlobalPiLayout();
        try {
            const transcriptPath = resolvePiAiDistFile("utils", "transcript", layout.binPi);
            assert.equal(
                transcriptPath,
                join(layout.piAiDist, "utils", "transcript.js"),
            );
        } finally {
            rmSync(layout.root, { recursive: true, force: true });
        }
    });

    it("reports a missing dist helper with its directory in the message", () => {
        const layout = makeGlobalPiLayout();
        try {
            assert.throws(
                () => resolvePiAiDistFile("utils", "absent", layout.binPi),
                /dist\/utils\/absent\.js/,
            );
        } finally {
            rmSync(layout.root, { recursive: true, force: true });
        }
    });

    it("refuses to load on a Pi older than the minimum", () => {
        for (const version of ["1.5.0", "1.5.2", "1.10.0", "2.0.0"]) {
            assert.doesNotThrow(() => assertSupportedPiVersion({ PI_AI_VERSION: version }));
        }
        assert.throws(
            () => assertSupportedPiVersion({ PI_AI_VERSION: "1.4.1" }),
            /requires Pi 1\.5\.0 or newer, and this is Pi 1\.4\.1/,
        );
        // Pi before 1.4.0 does not export its version.
        assert.throws(() => assertSupportedPiVersion({}), /requires Pi 1\.5\.0 or newer/);
    });

    it("keeps the fallback helpers on exports the minimum Pi has", () => {
        // Pi 1.5.0 exports these. A regenerated helper that needs anything newer
        // means raising MINIMUM_PI_VERSION and the README with it.
        const minimumHostExports = [
            "ToolCallArgumentsStream",
            "calculateCost",
            "clampThinkingLevel",
            "getSystemMessageText",
            "renderSystemMessageUpdate",
            "resolveTranscript",
            "resolveTranscriptTools",
        ];
        const fallbackDir = join(repoRoot, "src", "pi-ai-fallback");
        const hostImports = new Set<string>();
        for (const file of readdirSync(fallbackDir)) {
            const source = readFileSync(join(fallbackDir, file), "utf8");
            for (const match of source.matchAll(
                /import\s*\{([^}]*)\}\s*from\s*"@earendil-works\/pi-ai"/g,
            )) {
                for (const name of (match[1] ?? "").split(",")) {
                    const imported = name.trim().split(/\s+as\s+/)[0];
                    if (imported) {
                        hostImports.add(imported);
                    }
                }
            }
        }
        assert.deepEqual([...hostImports].sort(), minimumHostExports);
    });

    it("declares no tools when the transcript declares none", () => {
        assert.deepEqual(resolveRequestToolsFn({ messages: [] }), []);
    });

    it("loads the extension through Pi's jiti resolver", async () => {
        assert.equal(existsSync(piBin), true, "pi-coding-agent bin is required for this regression");
        const result = await runPiRpc([
            "--mode",
            "rpc",
            "--no-session",
            "--no-tools",
            "--no-extensions",
            "--extension",
            extensionPath,
        ]);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /Failed to load extension/);
        assert.doesNotMatch(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
        const response = result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as { id?: string; success?: boolean; type?: string })
            .find((record) => record.id === "t3-1");
        assert.ok(response);
        assert.equal(response.type, "response");
        assert.equal(response.success, true);
    });
});

function makeGlobalPiLayout(): { root: string; binPi: string; piAiDist: string } {
    // macOS tmpdir() sits behind the /var symlink, and the loader realpaths its seed.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-ai-layout-")));
    const agentRoot = join(
        root,
        "prefix",
        "lib",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
    );
    const cliJs = join(agentRoot, "dist", "bundle", "cli.js");
    const piAiDist = join(agentRoot, "node_modules", "@earendil-works", "pi-ai", "dist");
    const binDir = join(root, "prefix", "bin");
    const binPi = join(binDir, "pi");
    mkdirSync(dirname(cliJs), { recursive: true });
    mkdirSync(join(piAiDist, "api"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(cliJs, "export {}\n");
    writeFileSync(join(piAiDist, "api", "openai-responses-shared.js"), "export {}\n");
    mkdirSync(join(piAiDist, "utils"), { recursive: true });
    writeFileSync(join(piAiDist, "utils", "transcript.js"), "export {}\n");
    symlinkSync(cliJs, binPi);
    return { root, binPi, piAiDist };
}

function runPiRpc(
    args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(piBin, args, {
            cwd: repoRoot,
            env: {
                ...process.env,
                PI_XAI_WS_STORE: "0",
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            fail(new Error(`pi rpc timed out\n${stderr}`));
        }, 15_000);
        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(error);
        };
        child.once("error", (error) => fail(error));
        child.stdin.write('{"type":"get_state","id":"t3-1"}\n');
        child.stdin.end();
        child.once("close", (exitCode) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({ exitCode, stdout, stderr });
        });
    });
}
