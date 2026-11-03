import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    LOOP_RECOVERY_COMPACTION_INSTRUCTIONS,
    LOOP_RECOVERY_CUSTOM_TYPE,
    LOOP_RECOVERY_MARKER,
    LOOP_RECOVERY_NOTIFY,
    LOOP_RECOVERY_TEXT,
    registerLoopRecovery,
    sanitizeRepetitiveAssistant,
    type LoopRecoveryPending,
} from "../src/loop-recovery.ts";

const WINDOW_LIMIT_NOTIFY =
    "Stopped repetitive Grok output. Automatic recovery is paused until an earlier recovery leaves the budget window, or until you send another message.";

describe("sanitizeRepetitiveAssistant", () => {
    it("keeps a bounded unsigned prefix and drops later content", () => {
        const message = assistantMessage(1, [
            { thinking: "safe prefix repeated repeated", thinkingSignature: "secret", type: "thinking" },
            { text: "must not survive", textSignature: "signed", type: "text" },
        ]);
        message.responseId = "response-private";
        const pending: LoopRecoveryPending = {
            automaticRecovery: true,
            cleanPrefix: "safe prefix",
            contentIndex: 0,
            contentKind: "thinking",
            detection: {
                characterCount: 1_200,
                cleanPrefixLength: 11,
                kind: "exact",
                repeatPeriod: 500,
                repeatedCharacters: 1_000,
            },
        };

        const sanitized = sanitizeRepetitiveAssistant(message, pending);

        assert.deepEqual(sanitized.content, [{
            thinking: `safe prefix\n\n${LOOP_RECOVERY_MARKER}`,
            type: "thinking",
        }]);
        assert.equal(sanitized.responseId, undefined);
    });
});

describe("registerLoopRecovery", () => {
    it("aborts once, sanitizes, compacts, and queues one hidden recovery turn", () => {
        const harness = setupRecovery();
        const message = streamLoop(harness, 1);

        assert.equal(harness.aborts.length, 1);
        assert.deepEqual(harness.notifications[0], [LOOP_RECOVERY_NOTIFY, "warning"]);

        const replacement = emitFirst(harness.handlers, "message_end", { message }, harness.ctx) as {
            message: AssistantMessage;
        };
        const replacementBlock = replacement.message.content[0];
        const originalBlock = message.content[0];
        assert.ok(replacementBlock?.type === "thinking");
        assert.ok(originalBlock?.type === "thinking");
        assert.ok(replacementBlock.thinking.includes(LOOP_RECOVERY_MARKER));
        assert.ok(replacementBlock.thinking.length < originalBlock.thinking.length);

        emitFirst(harness.handlers, "turn_end", { message: replacement.message }, harness.ctx);
        assert.equal(harness.compactions.length, 1);
        assert.equal(
            harness.compactions[0]?.customInstructions,
            LOOP_RECOVERY_COMPACTION_INSTRUCTIONS,
        );
        assert.equal(harness.messages.length, 0);

        harness.compactions[0]?.onComplete?.({});
        assert.deepEqual(harness.messages, [{
            content: LOOP_RECOVERY_TEXT,
            customType: LOOP_RECOVERY_CUSTOM_TYPE,
            deliverAs: "steer",
            display: false,
            triggerTurn: true,
        }]);
    });

    it("settles without another compaction when a second loop occurs soon", () => {
        const harness = setupRecovery();
        const first = streamLoop(harness, 1);
        const firstReplacement = emitFirst(
            harness.handlers,
            "message_end",
            { message: first },
            harness.ctx,
        ) as { message: AssistantMessage };
        emitFirst(harness.handlers, "turn_end", { message: firstReplacement.message }, harness.ctx);
        harness.compactions[0]?.onComplete?.({});

        const second = streamLoop(harness, 2);
        const secondReplacement = emitFirst(
            harness.handlers,
            "message_end",
            { message: second },
            harness.ctx,
        ) as { message: AssistantMessage };
        emitFirst(harness.handlers, "turn_end", { message: secondReplacement.message }, harness.ctx);

        assert.equal(harness.aborts.length, 2);
        assert.equal(harness.compactions.length, 1);
        assert.deepEqual(harness.notifications.at(-1), [
            "Stopped repetitive Grok output. Automatic recovery is paused because another loop occurred recently.",
            "error",
        ]);
    });

    it("reports the rolling-window limit separately from the cooldown", () => {
        const originalNow = Date.now;
        let now = 1_000_000;
        Date.now = () => now;
        try {
            const harness = setupRecovery();
            for (let timestamp = 1; timestamp <= 2; timestamp += 1) {
                const message = streamLoop(harness, timestamp);
                const replacement = emitFirst(
                    harness.handlers,
                    "message_end",
                    { message },
                    harness.ctx,
                ) as { message: AssistantMessage };
                emitFirst(
                    harness.handlers,
                    "turn_end",
                    { message: replacement.message },
                    harness.ctx,
                );
                harness.compactions.at(-1)?.onComplete?.({});
                now += 11 * 60_000;
            }

            const third = streamLoop(harness, 3);
            const replacement = emitFirst(
                harness.handlers,
                "message_end",
                { message: third },
                harness.ctx,
            ) as { message: AssistantMessage };
            emitFirst(harness.handlers, "turn_end", { message: replacement.message }, harness.ctx);

            assert.equal(harness.compactions.length, 2);
            assert.deepEqual(harness.notifications.at(-1), [
                WINDOW_LIMIT_NOTIFY,
                "error",
            ]);
        } finally {
            Date.now = originalNow;
        }
    });

    it("keeps a spent budget spent for the session when the budget window is zero", () => {
        const previous = process.env.PI_XAI_WS_LOOP_RECOVERY_BUDGET_MS;
        process.env.PI_XAI_WS_LOOP_RECOVERY_BUDGET_MS = "0";
        try {
            withClock((advance) => {
                const harness = setupRecovery();
                recoverTwice(harness, advance);

                advance(24 * 60 * 60_000);
                emitReplacement(harness, 3);
                assert.equal(harness.compactions.length, 2);
                assert.deepEqual(harness.notifications.at(-1), [
                    "Stopped repetitive Grok output. This session has reached its automatic recovery limit.",
                    "error",
                ]);
            });
        } finally {
            restoreEnv("PI_XAI_WS_LOOP_RECOVERY_BUDGET_MS", previous);
        }
    });

    it("honors loopRecoveryLimit and reports disabled automatic recovery", () => {
        const previous = process.env.PI_XAI_WS_LOOP_RECOVERY_LIMIT;
        try {
            process.env.PI_XAI_WS_LOOP_RECOVERY_LIMIT = "0";
            const disabled = setupRecovery();
            const disabledMessage = emitReplacement(disabled, 1);
            assert.equal(disabled.aborts.length, 1);
            assert.equal(disabled.compactions.length, 0);
            assert.equal(disabled.messages.length, 0);
            assert.ok(disabledMessage.content[0]?.type === "thinking");
            assert.ok(disabledMessage.content[0].thinking.includes(LOOP_RECOVERY_MARKER));
            assert.deepEqual(disabled.notifications, [[
                "Stopped repetitive Grok output. Automatic recovery is disabled by configuration.",
                "error",
            ]]);

            process.env.PI_XAI_WS_LOOP_RECOVERY_LIMIT = "1";
            withClock((advance) => {
                const harness = setupRecovery();
                emitReplacement(harness, 1);
                assert.equal(harness.compactions.length, 1);
                harness.compactions.at(-1)?.onComplete?.({});

                advance(11 * 60_000);
                emitReplacement(harness, 2);
                assert.equal(harness.compactions.length, 1);
                assert.deepEqual(harness.notifications.at(-1), [
                    WINDOW_LIMIT_NOTIFY,
                    "error",
                ]);
            });
        } finally {
            restoreEnv("PI_XAI_WS_LOOP_RECOVERY_LIMIT", previous);
        }
    });

    it("recovers after a four-loop burst instead of staying capped", () => {
        // Timeline of the session that motivated this budget: repetitions at 0,
        // +3, +11, and +17 minutes spent the budget and the cooldown, and the
        // session stayed capped for the life of the process. The fifth
        // repetition, after the budget window, must recover again.
        withClock((advance) => {
            const harness = setupRecovery();
            const outcomes: string[] = [];
            let previous = 0;
            for (const [index, minutes] of [0, 3, 11, 17, 41].entries()) {
                advance((minutes - previous) * 60_000);
                previous = minutes;
                outcomes.push(recoverOrStop(harness, index + 1));
            }

            assert.deepEqual(outcomes, [
                "recovered",
                "stopped",
                "recovered",
                "stopped",
                "recovered",
            ]);
            assert.equal(harness.aborts.length, 5);
            assert.equal(harness.messages.length, 3);
            assert.deepEqual(harness.notifications.at(-2), [
                "Stopped repetitive Grok output. Automatic recovery is paused because another loop occurred recently.",
                "error",
            ]);
            assert.deepEqual(harness.notifications.at(-1), [LOOP_RECOVERY_NOTIFY, "warning"]);
        });
    });

    it("lets the cooldown bound recovery when the budget window is shorter", () => {
        // Documented interaction: the limit can only bind when the budget window
        // holds more recoveries than the limit at the cooldown rate, that is when
        // budgetMs exceeds limit x cooldownMs. A shorter window leaves the
        // cooldown as the only bound.
        const keys = [
            "PI_XAI_WS_LOOP_RECOVERY_BUDGET_MS",
            "PI_XAI_WS_LOOP_RECOVERY_COOLDOWN_MS",
            "PI_XAI_WS_LOOP_RECOVERY_LIMIT",
        ] as const;
        const previous = keys.map((key) => [key, process.env[key]] as const);
        process.env.PI_XAI_WS_LOOP_RECOVERY_BUDGET_MS = "300000";
        process.env.PI_XAI_WS_LOOP_RECOVERY_COOLDOWN_MS = "600000";
        process.env.PI_XAI_WS_LOOP_RECOVERY_LIMIT = "1";
        try {
            withClock((advance) => {
                const harness = setupRecovery();
                const outcomes: string[] = [];
                let previousMinute = 0;
                for (const [index, minutes] of [0, 11, 22, 33].entries()) {
                    advance((minutes - previousMinute) * 60_000);
                    previousMinute = minutes;
                    outcomes.push(recoverOrStop(harness, index + 1));
                }
                assert.deepEqual(outcomes, [
                    "recovered",
                    "recovered",
                    "recovered",
                    "recovered",
                ]);
            });
        } finally {
            for (const [key, value] of previous) {
                restoreEnv(key, value);
            }
        }
    });

    it("re-arms the recovery budget on a real user turn", () => {
        const previous = process.env.PI_XAI_WS_LOOP_RECOVERY_LIMIT;
        process.env.PI_XAI_WS_LOOP_RECOVERY_LIMIT = "1";
        try {
            withClock((advance) => {
                const harness = setupRecovery();
                assert.equal(recoverOrStop(harness, 1), "recovered");

                emitUserTurn(harness);
                assert.equal(recoverOrStop(harness, 2), "recovered");

                advance(11 * 60_000);
                assert.equal(recoverOrStop(harness, 3), "stopped");
                assert.deepEqual(harness.notifications.at(-1), [
                    WINDOW_LIMIT_NOTIFY,
                    "error",
                ]);

                emitUserTurn(harness);
                assert.equal(recoverOrStop(harness, 4), "recovered");
                assert.equal(harness.compactions.length, 3);
            });
        } finally {
            restoreEnv("PI_XAI_WS_LOOP_RECOVERY_LIMIT", previous);
        }
    });

    it("does not re-arm the recovery budget for hidden steers", () => {
        const previous = process.env.PI_XAI_WS_LOOP_RECOVERY_LIMIT;
        process.env.PI_XAI_WS_LOOP_RECOVERY_LIMIT = "1";
        try {
            withClock((advance) => {
                const harness = setupRecovery();
                assert.equal(recoverOrStop(harness, 1), "recovered");

                emitUserTurn(harness, LOOP_RECOVERY_CUSTOM_TYPE);
                emitUserTurn(harness, "pi-xai-ws-empty-thinking");
                emitUserTurn(harness, undefined, "assistant");
                advance(11 * 60_000);

                assert.equal(recoverOrStop(harness, 2), "stopped");
                assert.equal(harness.compactions.length, 1);
                assert.deepEqual(harness.notifications.at(-1), [
                    WINDOW_LIMIT_NOTIFY,
                    "error",
                ]);
            });
        } finally {
            restoreEnv("PI_XAI_WS_LOOP_RECOVERY_LIMIT", previous);
        }
    });

    it("continues when Pi reports that compacting would be a no-op", () => {
        const harness = setupRecovery();
        const message = streamLoop(harness, 1);
        const replacement = emitFirst(
            harness.handlers,
            "message_end",
            { message },
            harness.ctx,
        ) as { message: AssistantMessage };
        emitFirst(harness.handlers, "turn_end", { message: replacement.message }, harness.ctx);
        harness.compactions[0]?.onError?.(new Error("Nothing to compact (session too small)"));

        assert.equal(harness.notifications.length, 1);
        assert.deepEqual(harness.messages, [{
            content: LOOP_RECOVERY_TEXT,
            customType: LOOP_RECOVERY_CUSTOM_TYPE,
            deliverAs: "steer",
            display: false,
            triggerTurn: true,
        }]);
    });

    it("does not queue recovery after compaction fails", () => {
        const harness = setupRecovery();
        const message = streamLoop(harness, 1);
        const replacement = emitFirst(
            harness.handlers,
            "message_end",
            { message },
            harness.ctx,
        ) as { message: AssistantMessage };
        emitFirst(harness.handlers, "turn_end", { message: replacement.message }, harness.ctx);
        harness.compactions[0]?.onError?.(new Error("summary unavailable"));

        assert.equal(harness.messages.length, 0);
        assert.deepEqual(harness.notifications.at(-1), [
            "Repetitive-output recovery failed: summary unavailable",
            "error",
        ]);
    });

    it("ignores another provider", () => {
        const harness = setupRecovery({ id: "gpt-5.6-sol", provider: "openai-codex" });
        streamLoop(harness, 1);
        assert.equal(harness.aborts.length, 0);
        assert.equal(harness.compactions.length, 0);
    });
});

function assistantMessage(timestamp: number, content: AssistantMessage["content"] = []): AssistantMessage {
    return {
        api: "openai-responses",
        content,
        model: "grok-4.7",
        provider: "xai",
        role: "assistant",
        stopReason: "aborted",
        timestamp,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
}

function emitFirst(
    handlers: Map<string, Array<(...args: any[]) => unknown>>,
    name: string,
    ...args: any[]
): unknown {
    return handlers.get(name)?.[0]?.(...args);
}

function emitUserTurn(
    harness: ReturnType<typeof setupRecovery>,
    customType?: string,
    role = "user",
): void {
    emitFirst(harness.handlers, "message_start", {
        message: customType === undefined ? { role } : { customType, role },
    }, harness.ctx);
}

function recoverOrStop(
    harness: ReturnType<typeof setupRecovery>,
    abortCount: number,
): string {
    const before = harness.compactions.length;
    emitReplacement(harness, abortCount);
    if (harness.compactions.length === before) {
        return "stopped";
    }
    harness.compactions.at(-1)?.onComplete?.({});
    return "recovered";
}

function withClock(run: (advance: (ms: number) => void) => void): void {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
        run((ms) => {
            now += ms;
        });
    } finally {
        Date.now = originalNow;
    }
}

function recoverTwice(
    harness: ReturnType<typeof setupRecovery>,
    advance: (ms: number) => void,
): void {
    for (let round = 1; round <= 2; round += 1) {
        emitReplacement(harness, round);
        assert.equal(harness.compactions.length, round);
        harness.compactions.at(-1)?.onComplete?.({});
        advance(11 * 60_000);
    }
}

function emitReplacement(
    harness: ReturnType<typeof setupRecovery>,
    abortCount: number,
): AssistantMessage {
    const message = streamLoop(harness, abortCount);
    const replacement = emitFirst(
        harness.handlers,
        "message_end",
        { message },
        harness.ctx,
    ) as { message: AssistantMessage };
    emitFirst(harness.handlers, "turn_end", { message: replacement.message }, harness.ctx);
    return replacement.message;
}

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

function setupRecovery(model = { id: "grok-4.7", provider: "xai" }) {
    const aborts: boolean[] = [];
    const compactions: Array<{
        customInstructions?: string;
        onComplete?: (result: unknown) => void;
        onError?: (error: Error) => void;
    }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    const messages: Array<Record<string, unknown>> = [];
    const notifications: Array<[string, string]> = [];
    const pi = {
        on: (name: string, handler: (...args: any[]) => unknown) => {
            const current = handlers.get(name) ?? [];
            current.push(handler);
            handlers.set(name, current);
        },
        sendMessage: (
            message: Record<string, unknown>,
            options?: Record<string, unknown>,
        ) => messages.push({ ...message, ...options }),
    } as unknown as ExtensionAPI;
    registerLoopRecovery(pi);
    const ctx = {
        abort: () => aborts.push(true),
        compact: (options: typeof compactions[number]) => compactions.push(options),
        hasUI: true,
        model,
        sessionManager: { getSessionId: () => "loop-recovery-session" },
        ui: {
            notify: (message: string, level: string) => notifications.push([message, level]),
        },
    };
    emitFirst(handlers, "agent_start", {}, ctx);
    emitFirst(handlers, "turn_start", {}, ctx);
    return { aborts, compactions, ctx, handlers, messages, notifications };
}

function streamLoop(
    harness: ReturnType<typeof setupRecovery>,
    timestamp: number,
): AssistantMessage {
    emitFirst(harness.handlers, "agent_start", {}, harness.ctx);
    emitFirst(harness.handlers, "turn_start", {}, harness.ctx);
    const message = assistantMessage(timestamp, [{ thinking: "", type: "thinking" }]);
    const block = makeBlock(600).repeat(5);
    for (let offset = 0; offset < block.length && harness.aborts.length < timestamp; offset += 41) {
        const delta = block.slice(offset, offset + 41);
        const content = message.content[0];
        if (content?.type === "thinking") {
            content.thinking += delta;
        }
        emitFirst(harness.handlers, "message_update", {
            assistantMessageEvent: {
                contentIndex: 0,
                delta,
                partial: message,
                type: "thinking_delta",
            },
            message,
        }, harness.ctx);
    }
    return message;
}

function makeBlock(length: number): string {
    let value = "";
    let index = 0;
    while (value.length < length) {
        value += `Inspect boundary token${String.fromCharCode(97 + index % 26)} and preserve the next concrete action. `;
        index += 1;
    }
    return value.slice(0, length);
}

describe("registerLoopRecovery replay reset", () => {
    // Long text whose word 5-grams are all unique: the low-novelty backstop
    // (48k+ chars, normalized 5-gram sets, no alignment sensitivity) is the
    // route that reliably fires when a second attempt re-streams the same
    // reasoning, which is exactly what an in-turn transport replay does.
    // Digits are avoided because the detector normalizes them away.
    function indexWord(index: number): string {
        let value = "";
        let remaining = index;
        do {
            value = String.fromCharCode(97 + (remaining % 26)) + value;
            remaining = Math.floor(remaining / 26);
        } while (remaining > 0);
        return `q${value.padStart(4, "a")}`;
    }

    function uniqueThinking(sentences: number): string {
        const parts: string[] = [];
        for (let i = 0; i < sentences; i++) {
            const base = i * 8;
            parts.push(
                `${indexWord(base)} ${indexWord(base + 1)} ${indexWord(base + 2)} ${indexWord(base + 3)} ${indexWord(base + 4)} extends the ${indexWord(base + 5)} derivation past ${indexWord(base + 6)} toward ${indexWord(base + 7)}.`,
            );
        }
        return parts.join(" ");
    }

    function streamThinking(
        harness: ReturnType<typeof setupRecovery>,
        message: AssistantMessage,
        text: string,
    ): void {
        for (let offset = 0; offset < text.length; offset += 257) {
            const delta = text.slice(offset, offset + 257);
            const content = message.content[0];
            if (content?.type === "thinking") {
                content.thinking += delta;
            }
            emitFirst(harness.handlers, "message_update", {
                assistantMessageEvent: {
                    contentIndex: 0,
                    delta,
                    partial: message,
                    type: "thinking_delta",
                },
                message,
            }, harness.ctx);
            if (harness.aborts.length > 0) {
                return;
            }
        }
    }

    it("resets the detector when a thinking block restarts after an in-turn replay", () => {
        // One pass stays under the 48k low-novelty gate; two passes put the
        // first copy inside the detector's 56k window with the second copy's
        // tail as the recent 8k, which must read as fully seen.
        const text = uniqueThinking(380);

        // Control: streaming the same long reasoning twice in one block is a
        // low-novelty loop and must abort, proving the test can see a leaked
        // detector across the attempt boundary.
        const control = setupRecovery();
        const controlMessage = assistantMessage(1, [{ thinking: "", type: "thinking" }]);
        streamThinking(control, controlMessage, text);
        streamThinking(control, controlMessage, text);
        assert.equal(control.aborts.length, 1);

        // Replay: the same restart, but the in-turn replay emits a fresh
        // thinking_start for the replaced block first. The detector must
        // start over, so re-streaming the reasoning from scratch is not a loop.
        const replay = setupRecovery();
        const replayMessage = assistantMessage(2, [{ thinking: "", type: "thinking" }]);
        streamThinking(replay, replayMessage, text);
        assert.equal(replay.aborts.length, 0);
        const content = replayMessage.content[0];
        if (content?.type === "thinking") {
            content.thinking = "";
        }
        emitFirst(replay.handlers, "message_update", {
            assistantMessageEvent: {
                contentIndex: 0,
                partial: replayMessage,
                type: "thinking_start",
            },
            message: replayMessage,
        }, replay.ctx);
        streamThinking(replay, replayMessage, text);
        assert.equal(replay.aborts.length, 0);
    });
});
