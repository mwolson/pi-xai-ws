import type {
    AssistantMessageEventStream,
    Context,
    Model,
    SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const XAI_RESPONSES_API = "openai-responses" as const;

type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];
export type XaiProviderConfig = ProviderConfig & {
    api: typeof XAI_RESPONSES_API;
};

export type XaiStreamSimple = (
    model: Model<typeof XAI_RESPONSES_API>,
    context: Context,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function registerXaiProvider(
    pi: Pick<ExtensionAPI, "registerProvider">,
    streamSimple: XaiStreamSimple,
): void {
    const config = {
        api: XAI_RESPONSES_API,
        streamSimple: streamSimple as NonNullable<ProviderConfig["streamSimple"]>,
    } satisfies ProviderConfig;
    pi.registerProvider("xai", config);
}
