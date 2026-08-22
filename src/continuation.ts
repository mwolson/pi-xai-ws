import { createHash, type Hash } from "node:crypto";

/**
 * Stored-response continuation state for `store: true` sessions.
 *
 * After each terminal response, the stream projects Pi's finalized assistant
 * message through the same Responses converter used for future requests. The
 * session stores the item count and SHA-256 digest of the complete Pi-side wire
 * prefix covered by the response. The next request continues only when that
 * entire prefix hashes identically; compaction, edits, missing output, or
 * unknown projection failures fall back to a full-context request without a
 * continuation reference. The digest avoids retaining conversation-sized wire
 * objects between requests.
 *
 * The session uses this state shape for both its latest socket-local head and
 * its durable cross-socket checkpoint. Later terminals on one socket advance
 * only the socket-local head because response IDs can repeat or cycle, and xAI
 * may rehydrate the first stored response tied to an ID after reconnecting.
 *
 * Neither position counts raw `response.output` items. xAI may retain
 * server-only items that Pi does not persist, so raw server output and Pi's
 * next wire conversion are not guaranteed to be one-to-one.
 */

export type ContinuationState = {
    responseId: string;
    coveredItemCount: number;
    coveredInputDigest: string;
};

export type ContinuationRequestContext = {
    fullInput: readonly unknown[];
};

export function continuationInputDigest(
    input: readonly unknown[],
    itemCount = input.length,
): string {
    if (!Number.isSafeInteger(itemCount) || itemCount < 0 || itemCount > input.length) {
        throw new RangeError("Continuation item count is outside the input range");
    }
    return digestInputParts([{ input, itemCount }]);
}

function digestInputParts(
    parts: ReadonlyArray<{ input: readonly unknown[]; itemCount: number }>,
): string {
    const hash = createHash("sha256");
    let totalItemCount = 0;
    for (const part of parts) {
        totalItemCount += part.itemCount;
    }
    hash.update(`a${totalItemCount}:`);
    for (const part of parts) {
        for (let index = 0; index < part.itemCount; index += 1) {
            updateJsonDigest(hash, part.input[index]);
        }
    }
    return `sha256:${hash.digest("hex")}`;
}

function updateJsonDigest(hash: Hash, value: unknown): void {
    if (value === null) {
        hash.update("z");
        return;
    }
    if (typeof value === "boolean") {
        hash.update(value ? "b1" : "b0");
        return;
    }
    if (typeof value === "number") {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new TypeError("Continuation input must contain only JSON values");
        }
        hash.update(`n${serialized};`);
        return;
    }
    if (typeof value === "string") {
        updateDigestString(hash, "s", value);
        return;
    }
    if (Array.isArray(value)) {
        hash.update(`a${value.length}:`);
        for (const item of value) {
            updateJsonDigest(hash, item);
        }
        return;
    }
    if (!isPlainRecord(value)) {
        throw new TypeError("Continuation input must contain only JSON values");
    }
    const keys = Object.keys(value).sort();
    hash.update(`o${keys.length}:`);
    for (const key of keys) {
        updateDigestString(hash, "k", key);
        updateJsonDigest(hash, value[key]);
    }
}

function updateDigestString(hash: Hash, tag: "k" | "s", value: string): void {
    hash.update(`${tag}${value.length}:`);
    hash.update(value, "utf16le");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function continuationInput(payload: Record<string, unknown>): readonly unknown[] {
    const input = payload.input;
    return Array.isArray(input) ? input : [];
}

/**
 * Build one stored-response request. Never mutates the caller's payload or
 * chain state.
 */
export function planStoredRequest(
    base: Record<string, unknown>,
    state: Readonly<ContinuationState> | undefined,
): { context: ContinuationRequestContext; payload: Record<string, unknown>; resetChain: boolean } {
    const payload: Record<string, unknown> = { ...base, store: true };
    delete payload.previous_response_id;
    const fullInput = [...continuationInput(payload)];

    if (!state) {
        return {
            context: { fullInput },
            payload,
            resetChain: false,
        };
    }

    const coveredItemCount = state.coveredItemCount;
    const validCoveredItemCount = Number.isSafeInteger(coveredItemCount) &&
        coveredItemCount >= 0 &&
        fullInput.length > coveredItemCount;
    let prefixIntact = false;
    if (validCoveredItemCount) {
        try {
            prefixIntact = continuationInputDigest(fullInput, coveredItemCount) ===
                state.coveredInputDigest;
        } catch {
            prefixIntact = false;
        }
    }
    if (!prefixIntact) {
        return {
            context: { fullInput },
            payload,
            resetChain: true,
        };
    }

    const continued: Record<string, unknown> = {
        ...payload,
        input: fullInput.slice(coveredItemCount),
        previous_response_id: state.responseId,
    };
    return {
        context: { fullInput },
        payload: continued,
        resetChain: false,
    };
}

const STORED_TERMINAL_TYPES = new Set(["response.completed", "response.incomplete"]);

export function readStoredResponse(
    event: Record<string, unknown>,
): { responseId: string } | undefined {
    if (!STORED_TERMINAL_TYPES.has(typeof event.type === "string" ? event.type : "")) {
        return undefined;
    }
    const response = isPlainRecord(event.response) ? event.response : undefined;
    if (!response || typeof response.id !== "string" || response.id === "") {
        return undefined;
    }
    return { responseId: response.id };
}

export function nextContinuationState(
    context: ContinuationRequestContext,
    stored: { responseId: string },
    projectedOutput: readonly unknown[],
): ContinuationState {
    return {
        coveredInputDigest: digestInputParts([
            { input: context.fullInput, itemCount: context.fullInput.length },
            { input: projectedOutput, itemCount: projectedOutput.length },
        ]),
        coveredItemCount: context.fullInput.length + projectedOutput.length,
        responseId: stored.responseId,
    };
}

/**
 * Recognize server rejections of a continuation reference so the session can
 * retry once with full context instead of surfacing a transport error.
 */
export function isContinuationRejection(event: Record<string, unknown>): boolean {
    if (event.type !== "error") {
        return false;
    }
    const code = typeof event.code === "string" ? event.code.toLowerCase() : "";
    if (code.includes("previous_response")) {
        return true;
    }
    const nestedError = isPlainRecord(event.error) ? event.error : undefined;
    const nestedCode = typeof nestedError?.code === "string"
        ? nestedError.code.toLowerCase()
        : "";
    if (nestedCode.includes("previous_response")) {
        return true;
    }
    const param = typeof event.param === "string" ? event.param.toLowerCase() : "";
    const nestedParam = typeof nestedError?.param === "string"
        ? nestedError.param.toLowerCase()
        : "";
    if (param === "previous_response_id" || nestedParam === "previous_response_id") {
        return true;
    }
    const message = typeof event.message === "string" ? event.message.toLowerCase() : "";
    return message.includes("previous_response_id") ||
        (message.includes("previous response") && message.includes("not found")) ||
        (message.includes("response with id=") && message.includes("not found"));
}
