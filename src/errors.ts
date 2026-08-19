const XAI_CAPACITY_ERROR_PATTERN = /\bcurrently at capacity\b|\bdue to high demand\b/i;

export function normalizeXaiErrorMessage(message: string): string {
    if (/\boverloaded\b/i.test(message) || !XAI_CAPACITY_ERROR_PATTERN.test(message)) {
        return message;
    }
    return `Provider overloaded: ${message}`;
}
