import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerXaiProvider } from "./provider.ts";
import { streamXaiResponsesWs } from "./stream.ts";

export default function (pi: ExtensionAPI) {
    registerXaiProvider(pi, streamXaiResponsesWs);
}
