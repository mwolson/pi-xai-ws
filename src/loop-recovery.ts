import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveLoopNoveltyThreshold, resolveLoopRecoveryPolicy, type LoopRecoveryPolicy } from "./config.ts";
import { isXaiChatModel } from "./models.ts";
import {
    RepetitionDetector,
    type RepetitionContentKind,
    type RepetitionDetection,
} from "./repetition-detector.ts";

const CLEAN_PREFIX_MAX_CHARS = 8_192;

export const LOOP_RECOVERY_CUSTOM_TYPE = "pi-xai-ws-loop-recovery";
export const LOOP_RECOVERY_MARKER = "[Repetitive output removed before context recovery.]";
export const LOOP_RECOVERY_NOTIFY =
    "Stopped repetitive Grok output; compacting context before recovery.";
export const LOOP_RECOVERY_TEXT =
    "The prior response was stopped because it became repetitive. Do not reconstruct or repeat the removed text. Continue the user's work from the next concrete action, using the compacted context and completed tool results.";
export const LOOP_RECOVERY_COMPACTION_INSTRUCTIONS =
    "Exclude repetitive or policy-shaped filler from the summary. Preserve the user's goal, completed tool work, repository state, constraints, decisions, and the next concrete action.";

type RecoveryDenialReason = "cooldown" | "disabled" | "in-progress" | "session-limit";

type RecoveryDecision = {
    automaticRecovery: boolean;
    denialReason?: RecoveryDenialReason;
};

export type LoopRecoveryPending = {
    automaticRecovery: boolean;
    cleanPrefix: string;
    contentIndex: number;
    contentKind: RepetitionContentKind;
    denialReason?: RecoveryDenialReason;
    detection: RepetitionDetection;
};

type ActiveBlock = {
    contentIndex: number;
    contentKind: RepetitionContentKind;
    detector: RepetitionDetector;
};

type SessionState = {
    activeBlock?: ActiveBlock;
    budgetTimes: number[];
    pending?: LoopRecoveryPending & { compactionStarted?: boolean };
    recoveryInProgress: boolean;
    recoveryTimes: number[];
};

export function registerLoopRecovery(pi: ExtensionAPI): void {
    const sessions = new Map<string, SessionState>();

    const clearSession = (_event: unknown, ctx: ExtensionContext) => {
        sessions.delete(sessionKey(ctx));
    };
    pi.on("session_start", clearSession);
    pi.on("session_shutdown", clearSession);
    pi.on("agent_start", (_event, ctx) => {
        const state = getState(sessions, ctx);
        state.activeBlock = undefined;
    });
    pi.on("turn_start", (_event, ctx) => {
        getState(sessions, ctx).activeBlock = undefined;
    });
    pi.on("message_start", (event, ctx) => {
        // A person intervening is the signal that the loop is over, so a real
        // user turn re-arms the budget and the cooldown. Hidden steers from this
        // or another extension, and the system-shaped compaction summary, carry a
        // customType or a non-user role and must not re-arm a session that no one
        // is watching.
        if (!isXaiChatModel(ctx.model) || !isHumanUserMessage(event.message)) {
            return;
        }
        const state = getState(sessions, ctx);
        state.budgetTimes = [];
        state.recoveryTimes = [];
    });

    pi.on("message_update", (event, ctx) => {
        if (!isXaiChatModel(ctx.model)) {
            return;
        }
        const state = getState(sessions, ctx);
        if (state.pending) {
            return;
        }
        const update = event.assistantMessageEvent;
        if (
            update.type === "toolcall_start" ||
            update.type === "toolcall_delta" ||
            update.type === "toolcall_end"
        ) {
            state.activeBlock = undefined;
            return;
        }
        if (update.type === "thinking_start" || update.type === "text_start") {
            // A start event for a block that is already streaming can only come
            // from an in-turn transport replay that replaced the partial
            // message. Drop the detector so the replacement stream is judged on
            // its own text instead of concatenated with the abandoned prefix.
            state.activeBlock = undefined;
            return;
        }
        if (update.type !== "thinking_delta" && update.type !== "text_delta") {
            return;
        }
        const contentKind: RepetitionContentKind =
            update.type === "thinking_delta" ? "thinking" : "text";
        if (
            !state.activeBlock ||
            state.activeBlock.contentIndex !== update.contentIndex ||
            state.activeBlock.contentKind !== contentKind
        ) {
            state.activeBlock = {
                contentIndex: update.contentIndex,
                contentKind,
                detector: new RepetitionDetector({
                    contentKind,
                    lowNoveltyThreshold: resolveLoopNoveltyThreshold(),
                }),
            };
        }
        const detection = state.activeBlock.detector.append(update.delta);
        if (!detection || event.message.role !== "assistant") {
            return;
        }
        const message = event.message as AssistantMessage;
        const blockText = readBlockText(message, update.contentIndex, contentKind);
        const now = Date.now();
        const policy = resolveLoopRecoveryPolicy();
        const recovery = decideAutomaticRecovery(state, policy, now);
        if (recovery.automaticRecovery) {
            state.budgetTimes.push(now);
            state.recoveryTimes.push(now);
        }
        state.pending = {
            automaticRecovery: recovery.automaticRecovery,
            cleanPrefix: blockText.slice(
                0,
                Math.min(detection.cleanPrefixLength, CLEAN_PREFIX_MAX_CHARS),
            ),
            contentIndex: update.contentIndex,
            contentKind,
            denialReason: recovery.denialReason,
            detection,
        };
        ctx.abort();
        notifyDetection(ctx, recovery, policy);
        debugDetection(detection, ctx);
    });

    pi.on("message_end", (event, ctx) => {
        const state = sessions.get(sessionKey(ctx));
        const pending = state?.pending;
        if (!pending || event.message.role !== "assistant") {
            return;
        }
        return {
            message: sanitizeRepetitiveAssistant(event.message, pending),
        };
    });

    pi.on("turn_end", (event, ctx) => {
        const key = sessionKey(ctx);
        const state = sessions.get(key);
        const pending = state?.pending;
        if (
            !state ||
            !pending ||
            pending.compactionStarted ||
            event.message.role !== "assistant"
        ) {
            return;
        }
        state.activeBlock = undefined;
        if (!pending.automaticRecovery) {
            state.pending = undefined;
            return;
        }
        pending.compactionStarted = true;
        state.recoveryInProgress = true;
        ctx.compact({
            customInstructions: LOOP_RECOVERY_COMPACTION_INSTRUCTIONS,
            onComplete: () => {
                if (sessions.get(key) !== state) {
                    return;
                }
                state.pending = undefined;
                state.recoveryInProgress = false;
                sendRecoveryMessage(pi, ctx);
            },
            onError: (error) => {
                if (sessions.get(key) !== state) {
                    return;
                }
                state.pending = undefined;
                state.recoveryInProgress = false;
                if (isNoopCompactionError(error)) {
                    sendRecoveryMessage(pi, ctx);
                    return;
                }
                if (ctx.hasUI) {
                    ctx.ui.notify(`Repetitive-output recovery failed: ${error.message}`, "error");
                }
            },
        });
    });
}

export function sanitizeRepetitiveAssistant(
    message: AssistantMessage,
    pending: LoopRecoveryPending,
): AssistantMessage {
    const content = message.content
        .slice(0, pending.contentIndex + 1)
        .map((block, index) => {
            if (index !== pending.contentIndex) {
                return block;
            }
            const clean = appendMarker(pending.cleanPrefix);
            if (pending.contentKind === "thinking") {
                return { thinking: clean, type: "thinking" } as const;
            }
            return { text: clean, type: "text" } as const;
        });
    return {
        ...message,
        content,
        responseId: undefined,
    };
}

function isHumanUserMessage(message: unknown): boolean {
    if (typeof message !== "object" || message === null) {
        return false;
    }
    const candidate = message as { customType?: unknown; role?: unknown };
    return candidate.role === "user" && candidate.customType === undefined;
}

function appendMarker(prefix: string): string {
    const trimmed = prefix.trimEnd();
    return trimmed.length === 0 ? LOOP_RECOVERY_MARKER : `${trimmed}\n\n${LOOP_RECOVERY_MARKER}`;
}

function decideAutomaticRecovery(
    state: SessionState,
    policy: LoopRecoveryPolicy,
    now: number,
): RecoveryDecision {
    state.recoveryTimes = state.recoveryTimes.filter(
        (time) => now - time < policy.cooldownMs,
    );
    state.budgetTimes = policy.budgetMs === 0
        ? state.budgetTimes
        : state.budgetTimes.filter((time) => now - time < policy.budgetMs);
    if (state.recoveryInProgress) {
        return { automaticRecovery: false, denialReason: "in-progress" };
    }
    if (policy.limit === 0) {
        return { automaticRecovery: false, denialReason: "disabled" };
    }
    if (state.recoveryTimes.length > 0) {
        return { automaticRecovery: false, denialReason: "cooldown" };
    }
    if (state.budgetTimes.length >= policy.limit) {
        return { automaticRecovery: false, denialReason: "session-limit" };
    }
    return { automaticRecovery: true };
}

function createState(): SessionState {
    return {
        budgetTimes: [],
        recoveryInProgress: false,
        recoveryTimes: [],
    };
}

function debugDetection(detection: RepetitionDetection, ctx: ExtensionContext): void {
    if (process.env.PI_XAI_WS_DEBUG !== "1") {
        return;
    }
    const model = typeof ctx.model?.id === "string" ? ctx.model.id : "unknown";
    process.stderr.write(
        `[pi-xai-ws] repetition detected kind=${detection.kind} period=${detection.repeatPeriod ?? 0} chars=${detection.characterCount} repeated_chars=${detection.repeatedCharacters} provider=xai model=${model}\n`,
    );
}

function getState(
    sessions: Map<string, SessionState>,
    ctx: ExtensionContext,
): SessionState {
    const key = sessionKey(ctx);
    let state = sessions.get(key);
    if (!state) {
        state = createState();
        sessions.set(key, state);
    }
    return state;
}

function isNoopCompactionError(error: Error): boolean {
    return error.message === "Already compacted" ||
        error.message === "Nothing to compact (session too small)";
}

function notifyDetection(
    ctx: ExtensionContext,
    recovery: RecoveryDecision,
    policy: LoopRecoveryPolicy,
): void {
    if (!ctx.hasUI) {
        return;
    }
    if (recovery.automaticRecovery) {
        ctx.ui.notify(LOOP_RECOVERY_NOTIFY, "warning");
        return;
    }
    let message = "Stopped repetitive Grok output. Automatic recovery is already in progress.";
    if (recovery.denialReason === "disabled") {
        message = "Stopped repetitive Grok output. Automatic recovery is disabled by configuration.";
    } else if (recovery.denialReason === "cooldown") {
        message = "Stopped repetitive Grok output. Automatic recovery is paused because another loop occurred recently.";
    } else if (recovery.denialReason === "session-limit") {
        message = policy.budgetMs === 0
            ? "Stopped repetitive Grok output. This session has reached its automatic recovery limit."
            : "Stopped repetitive Grok output. Automatic recovery is paused until an earlier recovery leaves the budget window, or until you send another message.";
    }
    ctx.ui.notify(message, "error");
}

function readBlockText(
    message: AssistantMessage,
    contentIndex: number,
    contentKind: RepetitionContentKind,
): string {
    const block = message.content[contentIndex];
    if (contentKind === "thinking" && block?.type === "thinking") {
        return block.thinking;
    }
    if (contentKind === "text" && block?.type === "text") {
        return block.text;
    }
    return "";
}

function sendRecoveryMessage(pi: ExtensionAPI, ctx: ExtensionContext): void {
    try {
        pi.sendMessage({
            content: LOOP_RECOVERY_TEXT,
            customType: LOOP_RECOVERY_CUSTOM_TYPE,
            display: false,
        }, {
            deliverAs: "steer",
            triggerTurn: true,
        });
    } catch (error) {
        if (ctx.hasUI) {
            const reason = error instanceof Error ? error.message : "unknown error";
            ctx.ui.notify(`Could not continue after repetitive-output recovery: ${reason}`, "error");
        }
    }
}

function sessionKey(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionId();
}
