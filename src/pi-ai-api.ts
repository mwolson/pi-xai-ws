import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import type {
    convertResponsesMessages,
    convertResponsesTools,
    processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";

const require = createRequire(import.meta.url);

/**
 * Pi 0.84+ jiti aliases `@earendil-works/pi-ai` to `dist/compat.js`.
 * Specifiers such as `@earendil-works/pi-ai/api/openai-responses-shared`
 * then resolve to `dist/compat.js/api/...` and abort extension load. Pi
 * treats that as a fatal startup error, so every session dies.
 *
 * `@earendil-works/pi-ai/compat` is an exact alias / export. Resolve that
 * file, then load sibling `dist/api/*.js` by filesystem path so neither
 * jiti nor the package "exports" map can rewrite the subpath. Use
 * `import.meta.resolve` rather than `require.resolve`: the exports map
 * has only an `import` condition.
 */
function loadPiAiApiModule(name: string): Record<string, unknown> {
    const compatUrl = import.meta.resolve("@earendil-works/pi-ai/compat");
    const apiPath = fileURLToPath(new URL(`./api/${name}.js`, compatUrl));
    return require(apiPath) as Record<string, unknown>;
}

const responsesShared = loadPiAiApiModule("openai-responses-shared");
const promptCache = loadPiAiApiModule("openai-prompt-cache");

export const processResponsesStreamFn = responsesShared[
    "processResponsesStream"
] as typeof processResponsesStream;
export const convertResponsesMessagesFn = responsesShared[
    "convertResponsesMessages"
] as typeof convertResponsesMessages;
export const convertResponsesToolsFn = responsesShared[
    "convertResponsesTools"
] as typeof convertResponsesTools;
export const clampOpenAIPromptCacheKeyFn = promptCache[
    "clampOpenAIPromptCacheKey"
] as typeof clampOpenAIPromptCacheKey;
