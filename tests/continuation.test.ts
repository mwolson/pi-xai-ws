import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    type ContinuationState,
    continuationInputDigest,
    isContinuationRejection,
    nextContinuationState,
    planStoredRequest,
    readStoredResponse,
} from "../src/continuation.ts";

function basePayload(input: unknown[]): Record<string, unknown> {
    return {
        input,
        model: "grok-4.6",
        store: false,
        type: "response.create",
    };
}

function state(coveredInput: unknown[]): ContinuationState {
    return {
        coveredInputDigest: continuationInputDigest(coveredInput),
        coveredItemCount: coveredInput.length,
        responseId: "response-prev",
    };
}

describe("planStoredRequest", () => {
    it("sends full input with storage and no continuation reference before a chain exists", () => {
        const input = [{ role: "user", text: "first" }];
        const plan = planStoredRequest(basePayload(input), undefined);

        assert.equal(plan.payload.store, true);
        assert.equal(plan.payload.previous_response_id, undefined);
        assert.deepEqual(plan.payload.input, input);
        assert.equal(plan.resetChain, false);
        assert.deepEqual(plan.context.fullInput, input);
    });

    it("continues with only items beyond the verified covered prefix", () => {
        const covered = [
            { role: "user", text: "first" },
            { role: "assistant", text: "answer" },
        ];
        const full = [...covered, { role: "user", text: "second" }];
        const plan = planStoredRequest(basePayload(full), state(covered));

        assert.equal(plan.payload.store, true);
        assert.equal(plan.payload.previous_response_id, "response-prev");
        assert.deepEqual(plan.payload.input, full.slice(covered.length));
        assert.equal(plan.resetChain, false);
        assert.deepEqual(plan.context.fullInput, full);
    });

    it("does not mutate the base payload or stored chain state", () => {
        const covered = [{ role: "user", text: "first" }];
        const full = [...covered, { role: "user", text: "second" }];
        const chain = state(covered);
        const base = basePayload(full);
        base.previous_response_id = "hook-supplied";

        const originalChain = { ...chain };
        planStoredRequest(base, chain);

        assert.deepEqual(base.input, full);
        assert.equal(base.store, false);
        assert.equal(base.previous_response_id, "hook-supplied");
        assert.deepEqual(chain, originalChain);
    });

    it("falls back to full context when history was rewritten", () => {
        const covered = [
            { role: "user", text: "original prefix" },
            { role: "assistant", text: "original answer" },
        ];
        const compacted = [{ role: "user", text: "compacted summary" }, { role: "user", text: "new" }];
        const plan = planStoredRequest(basePayload(compacted), state(covered));

        assert.equal(plan.payload.store, true);
        assert.equal(plan.payload.previous_response_id, undefined);
        assert.deepEqual(plan.payload.input, compacted);
        assert.equal(plan.resetChain, true);
    });

    it("falls back when previously projected assistant output was edited", () => {
        const covered = [
            { role: "user", text: "first" },
            { role: "assistant", text: "original" },
        ];
        const edited = [
            covered[0],
            { role: "assistant", text: "edited" },
            { role: "user", text: "second" },
        ];
        const plan = planStoredRequest(basePayload(edited), state(covered));

        assert.equal(plan.resetChain, true);
        assert.equal(plan.payload.previous_response_id, undefined);
        assert.deepEqual(plan.payload.input, edited);
    });

    it("falls back to full context when the history shrank below the covered prefix", () => {
        const covered = [{ a: 1 }, { b: 2 }, { c: 3 }];
        const shrunk = [{ a: 1 }];
        const plan = planStoredRequest(basePayload(shrunk), state(covered));

        assert.equal(plan.resetChain, true);
        assert.equal(plan.payload.previous_response_id, undefined);
        assert.deepEqual(plan.payload.input, shrunk);
    });

    it("falls back to full context when nothing new was added", () => {
        const covered = [{ role: "user", text: "only" }];
        const plan = planStoredRequest(basePayload([...covered]), state(covered));

        assert.equal(plan.resetChain, true);
        assert.equal(plan.payload.previous_response_id, undefined);
        assert.deepEqual(plan.payload.input, covered);
    });

    it("falls back safely when the candidate prefix is not canonical JSON", () => {
        const covered = [{ role: "user", text: "first" }];
        const input = [
            { role: "user", text: undefined },
            { role: "user", text: "second" },
        ];
        const plan = planStoredRequest(basePayload(input), state(covered));

        assert.equal(plan.resetChain, true);
        assert.equal(plan.payload.previous_response_id, undefined);
        assert.deepEqual(plan.payload.input, input);
    });
});

describe("continuationInputDigest", () => {
    it("hashes JSON structure independently of object key order", () => {
        const left = continuationInputDigest([{ a: 1, b: [2, { c: 3 }] }]);
        const reordered = continuationInputDigest([{ b: [2, { c: 3 }], a: 1 }]);

        assert.equal(left, reordered);
        assert.notEqual(left, continuationInputDigest([{ a: 2, b: [2, { c: 3 }] }]));
        assert.notEqual(left, continuationInputDigest([{ a: 1, b: [2, { c: 4 }] }]));
        assert.notEqual(left, continuationInputDigest([{ a: 1, b: [2, { c: 3 }] }, null]));
        assert.notEqual(continuationInputDigest(["ab", "c"]), continuationInputDigest(["a", "bc"]));
        assert.notEqual(continuationInputDigest([1]), continuationInputDigest(["1"]));
        assert.notEqual(continuationInputDigest(["\uD800"]), continuationInputDigest(["\uFFFD"]));
        assert.notEqual(continuationInputDigest([{ "\uDC00": 1 }]), continuationInputDigest([{ "\uFFFD": 1 }]));
    });

    it("hashes only the requested prefix without slicing it", () => {
        const input = [{ a: 1 }, { b: 2 }, { c: 3 }];

        assert.equal(
            continuationInputDigest(input, 2),
            continuationInputDigest(input.slice(0, 2)),
        );
        assert.throws(() => continuationInputDigest(input, 4), /outside the input range/);
    });
});

describe("readStoredResponse", () => {
    it("reads the response id from terminal events", () => {
        const event = {
            response: { id: "response-7", output: [{ type: "reasoning" }], status: "completed" },
            type: "response.completed",
        };
        assert.deepEqual(readStoredResponse(event), { responseId: "response-7" });
        assert.deepEqual(readStoredResponse({
            response: { id: "response-8" },
            type: "response.incomplete",
        }), { responseId: "response-8" });
    });

    it("ignores non-terminal events and malformed responses", () => {
        assert.equal(readStoredResponse({ type: "response.output_text.delta" }), undefined);
        assert.equal(readStoredResponse({ response: {}, type: "response.completed" }), undefined);
        assert.equal(readStoredResponse({ type: "error", message: "boom" }), undefined);
    });
});

describe("nextContinuationState", () => {
    it("stores a fixed-size digest of the covered Pi-side prefix", () => {
        const context = {
            fullInput: [{ role: "user" }, { type: "function_call_output" }],
        };
        const projectedOutput = [
            { type: "reasoning" },
            { type: "message", role: "assistant" },
        ];
        const next = nextContinuationState(context, { responseId: "response-next" }, projectedOutput);

        assert.deepEqual(next, {
            coveredInputDigest: continuationInputDigest([
                ...context.fullInput,
                ...projectedOutput,
            ]),
            coveredItemCount: 4,
            responseId: "response-next",
        });
        assert.equal(Object.hasOwn(next, "coveredInput"), false);
    });

    it("does not grow retained state with covered input content", () => {
        const small = nextContinuationState(
            { fullInput: [{ role: "user", text: "x" }] },
            { responseId: "response-next" },
            [],
        );
        const large = nextContinuationState(
            { fullInput: [{ role: "user", text: "x".repeat(1_000_000) }] },
            { responseId: "response-next" },
            [],
        );

        assert.equal(JSON.stringify(small).length, JSON.stringify(large).length);
        assert.notEqual(small.coveredInputDigest, large.coveredInputDigest);
    });
});

describe("isContinuationRejection", () => {
    it("matches previous_response_id rejections in code or message", () => {
        assert.equal(isContinuationRejection({
            message: "Previous response id was not found.",
            type: "error",
        }), true);
        assert.equal(isContinuationRejection({
            error: { code: "previous_response_not_found" },
            type: "error",
        }), true);
        assert.equal(isContinuationRejection({
            code: "invalid_previous_response_id",
            message: "bad reference",
            type: "error",
        }), true);
        assert.equal(isContinuationRejection({
            error: { param: "previous_response_id" },
            message: "invalid parameter",
            type: "error",
        }), true);
        assert.equal(isContinuationRejection({
            message: "gRPC error: Response with id=response-7-probe-missing-id not found",
            type: "error",
        }), true);
    });

    it("ignores unrelated errors and non-error events", () => {
        assert.equal(isContinuationRejection({
            code: "websocket_connection_limit_reached",
            message: "connection limit reached",
            type: "error",
        }), false);
        assert.equal(isContinuationRejection({
            message: "rate limit exceeded",
            type: "error",
        }), false);
        assert.equal(isContinuationRejection({
            message: "Response format not found.",
            type: "error",
        }), false);
        assert.equal(isContinuationRejection({ message: "not found", type: "response.failed" }), false);
    });
});
