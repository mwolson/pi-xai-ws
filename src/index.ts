import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEmptyThinkingNudge } from "./empty-thinking.ts";
import { registerImageOmissionTracking } from "./history.ts";
import { registerLoopRecovery } from "./loop-recovery.ts";
import { registerXaiProvider } from "./provider.ts";
import { registerStoredContextSafety } from "./stored-context.ts";
import { streamXaiResponsesWs } from "./stream.ts";
import { registerXaiWsShutdown } from "./ws-events.ts";

export default function (pi: ExtensionAPI) {
    registerXaiProvider(pi, streamXaiResponsesWs);
    registerStoredContextSafety(pi);
    registerImageOmissionTracking(pi);
    registerEmptyThinkingNudge(pi);
    registerLoopRecovery(pi);
    registerXaiWsShutdown(pi);
}
