import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTranscriptTools } from "@earendil-works/pi-ai";
import type { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import type { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type {
    convertResponsesMessages,
    convertResponsesTools,
    processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import { clampOpenAIPromptCacheKey as fallbackClampOpenAIPromptCacheKey } from "./pi-ai-fallback/openai-prompt-cache.ts";
import {
    convertResponsesMessages as fallbackConvertResponsesMessages,
    convertResponsesTools as fallbackConvertResponsesTools,
    processResponsesStream as fallbackProcessResponsesStream,
} from "./pi-ai-fallback/openai-responses-shared.ts";
import { buildBaseOptions as fallbackBuildBaseOptions } from "./pi-ai-fallback/simple-options.ts";

const nativeRequire = createRequire(import.meta.url);

/**
 * Pi loads extensions as CJS and only aliases `@earendil-works/pi-ai` plus
 * `/compat`. The `/api/*` helpers this transport needs are not on that
 * surface, and their package exports have no `require` condition, so a
 * normal import aborts every session. Load `dist/api/<name>.js` from the
 * host CLI's node_modules instead. Realpath `process.argv[1]` so a `bin/pi`
 * symlink still reaches a nested pi-ai tree.
 *
 * Compiled bun/sea binaries have no on-disk `dist/api`. Those hosts fall
 * back to `src/pi-ai-fallback/`, which statically imports the aliased
 * `@earendil-works/pi-ai` compat surface. Do not `createRequire` that
 * specifier: native require bypasses Pi's alias and virtual modules.
 */
export function resolvePiAiApiFile(name: string, fromPath = process.argv[1]): string {
    return resolvePiAiDistFile("api", name, fromPath);
}

/**
 * Resolve any file under the host CLI's `@earendil-works/pi-ai/dist/<directory>`
 * tree. Pi aliases only `@earendil-works/pi-ai` and `/compat` for extensions, and
 * the package's `exports` map has no `require` condition, so every helper this
 * transport needs is loaded from disk instead of imported.
 */
export function resolvePiAiDistFile(
    directory: string,
    name: string,
    fromPath = process.argv[1],
): string {
    const fileName = `${name}.js`;
    const seen = new Set<string>();
    for (const seed of cliSeeds(fromPath)) {
        if (seen.has(seed)) {
            continue;
        }
        seen.add(seed);
        try {
            const roots = createRequire(seed).resolve.paths("@earendil-works/pi-ai") ?? [];
            for (const root of roots) {
                const apiPath = join(root, "@earendil-works", "pi-ai", "dist", directory, fileName);
                if (existsSync(apiPath)) {
                    return apiPath;
                }
            }
        } catch {
            // fromPath is not always a module filename.
        }
    }
    throw new Error(
        `Unable to locate @earendil-works/pi-ai dist/${directory}/${fileName}` +
            ` (argv1=${process.argv[1] ?? ""}; fromPath=${fromPath ?? ""})`,
    );
}

function isCompiledBinaryPath(path: string): boolean {
    return path.includes("/$bunfs/") || path.startsWith("/$bunfs");
}

function cliSeeds(fromPath: string | undefined): string[] {
    const seeds: string[] = [];
    if (fromPath && !isCompiledBinaryPath(fromPath)) {
        try {
            seeds.push(realpathSync(fromPath));
        } catch {
            // Keep the unresolved path below.
        }
        if (seeds[0] !== fromPath) {
            seeds.push(fromPath);
        }
    }
    // node --test does not pass the Pi CLI as argv[1].
    seeds.push(fileURLToPath(import.meta.url));
    return seeds;
}

function loadPiAiApiModule(name: string): Record<string, unknown> | undefined {
    try {
        return nativeRequire(resolvePiAiApiFile(name)) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

const responsesShared = loadPiAiApiModule("openai-responses-shared");
const promptCache = loadPiAiApiModule("openai-prompt-cache");
const simpleOptions = loadPiAiApiModule("simple-options");

export const processResponsesStreamFn = (responsesShared?.["processResponsesStream"] ??
    fallbackProcessResponsesStream) as typeof processResponsesStream;
export const convertResponsesMessagesFn = (responsesShared?.["convertResponsesMessages"] ??
    fallbackConvertResponsesMessages) as typeof convertResponsesMessages;
export const convertResponsesToolsFn = (responsesShared?.["convertResponsesTools"] ??
    fallbackConvertResponsesTools) as typeof convertResponsesTools;
export const clampOpenAIPromptCacheKeyFn = (promptCache?.["clampOpenAIPromptCacheKey"] ??
    fallbackClampOpenAIPromptCacheKey) as typeof clampOpenAIPromptCacheKey;
export const buildBaseOptionsFn = (simpleOptions?.["buildBaseOptions"] ??
    fallbackBuildBaseOptions) as typeof buildBaseOptions;

/**
 * `resolveTranscriptTools(messages, supportsToolAdditions)` from the aliased
 * `@earendil-works/pi-ai` compat surface. Compiled binaries expose it there
 * even when `dist/utils` is not on disk.
 */
type TranscriptToolsResolver = (
    messages: readonly unknown[],
    supportsToolAdditions: boolean,
) => { requestTools?: readonly unknown[] } | undefined;

/**
 * Tools the request must declare.
 *
 * Provider-facing context is a branded transcript whose messages carry the
 * system prompt and the tool declarations. Reading `Context.tools` there
 * silently declares no tools at all, which makes Grok improvise tool calls as
 * prose instead of calling them.
 */
export function resolveRequestToolsFn(context: { messages?: readonly unknown[] }): readonly unknown[] {
    // The transport declares one complete tool list at the top level, so it
    // never anchors later additions at an individual message.
    const resolved = (resolveTranscriptTools as TranscriptToolsResolver)(context.messages ?? [], false);
    return resolved?.requestTools ?? [];
}
