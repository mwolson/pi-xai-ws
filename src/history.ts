type ThinkingBlock = {
    type: "thinking";
    thinking?: string;
    thinkingSignature?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isResponsesThinkingSignature(signature: string): boolean {
    if (!signature.startsWith("{")) {
        return false;
    }
    try {
        const parsed = JSON.parse(signature) as unknown;
        return isRecord(parsed);
    } catch {
        return false;
    }
}

function sanitizeContentBlock(block: unknown): unknown {
    if (!isRecord(block) || block.type !== "thinking") {
        return block;
    }
    const thinking = block as ThinkingBlock;
    if (!thinking.thinkingSignature || isResponsesThinkingSignature(thinking.thinkingSignature)) {
        return block;
    }
    const { thinkingSignature: _dropped, ...rest } = thinking;
    return rest;
}

function sanitizeMessage(message: unknown): unknown {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
        return message;
    }
    return {
        ...message,
        content: message.content.map(sanitizeContentBlock),
    };
}

export function sanitizeContextMessages<T extends { messages: readonly unknown[] }>(context: T): T {
    return {
        ...context,
        messages: context.messages.map(sanitizeMessage),
    };
}
