/**
 * Stored-response continuation state for `store: true` sessions.
 *
 * After each terminal response, the stream projects Pi's finalized assistant
 * message through the same Responses converter used for future requests. The
 * session stores the complete Pi-side wire prefix covered by the response.
 * The next request continues only when that entire prefix is still present and
 * unchanged; compaction, edits, missing output, or unknown projection failures
 * fall back to a full-context request without a continuation reference.
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
    coveredInput: readonly unknown[];
};

export type ContinuationRequestContext = {
    fullInput: readonly unknown[];
};

export function jsonItemsEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
    if (left === right) {
        return true;
    }
    if (left.length !== right.length) {
        return false;
    }
    return left.every((value, index) => jsonValueEqual(value, right[index]));
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
    if (left === right) {
        return true;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return jsonItemsEqual(left, right);
    }
    if (!isPlainRecord(left) || !isPlainRecord(right)) {
        return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    return leftKeys.every((key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        jsonValueEqual(left[key], right[key]),
    );
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

    const prefixIntact = fullInput.length > state.coveredInput.length &&
        jsonItemsEqual(fullInput.slice(0, state.coveredInput.length), state.coveredInput);
    if (!prefixIntact) {
        return {
            context: { fullInput },
            payload,
            resetChain: true,
        };
    }

    const continued: Record<string, unknown> = {
        ...payload,
        input: fullInput.slice(state.coveredInput.length),
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
        coveredInput: [...context.fullInput, ...projectedOutput],
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
