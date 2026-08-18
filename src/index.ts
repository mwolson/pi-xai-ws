import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamXaiResponsesWs } from "./stream.ts";

export default function (pi: ExtensionAPI) {
    pi.registerProvider("xai", {
        api: "openai-completions",
        streamSimple: streamXaiResponsesWs,
    });
}
