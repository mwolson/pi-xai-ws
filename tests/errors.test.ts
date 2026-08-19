import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeXaiErrorMessage } from "../src/errors.ts";

describe("normalizeXaiErrorMessage", () => {
    it("maps xAI capacity wording to Pi's retryable overloaded vocabulary", () => {
        const currentMessage = "The model is currently at capacity due to high demand.";
        assert.equal(
            normalizeXaiErrorMessage(currentMessage),
            `Provider overloaded: ${currentMessage}`,
        );
        assert.equal(
            normalizeXaiErrorMessage("The service is unavailable due to high demand."),
            "Provider overloaded: The service is unavailable due to high demand.",
        );
        const transportMessage =
            "Error Code undefined: The model is currently at capacity due to high demand.";
        assert.equal(
            normalizeXaiErrorMessage(transportMessage),
            `Provider overloaded: ${transportMessage}`,
        );
    });

    it("leaves normalized and unrelated errors unchanged", () => {
        const normalizedMessage =
            "Provider overloaded: The model is currently at capacity due to high demand.";
        assert.equal(normalizeXaiErrorMessage(normalizedMessage), normalizedMessage);
        assert.equal(normalizeXaiErrorMessage("Invalid API key"), "Invalid API key");
    });
});
