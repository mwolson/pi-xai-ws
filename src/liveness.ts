export const DEFAULT_PING_INTERVAL_MS = 15_000;
export const DEFAULT_LIVENESS_TIMEOUT_MS = 5_000;

export type SocketLivenessOptions = {
    pingIntervalMs?: number;
    livenessTimeoutMs?: number;
    now?: () => number;
};

/**
 * Any inbound WebSocket frame counts as liveness. Protocol ping is only sent
 * after the line has been quiet for pingIntervalMs. The turn fails if silence
 * then lasts another livenessTimeoutMs.
 */
export class SocketLiveness {
    lastInboundMs: number;
    pingSentAtMs: number | null = null;
    dead = false;

    readonly pingIntervalMs: number;
    readonly livenessTimeoutMs: number;

    private readonly now: () => number;
    private readonly sendPing: () => void;
    private readonly onDead: (reason: string) => void;
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(sendPing: () => void, onDead: (reason: string) => void, options: SocketLivenessOptions = {}) {
        this.sendPing = sendPing;
        this.onDead = onDead;
        this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
        this.livenessTimeoutMs = options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
        this.now = options.now ?? Date.now;
        this.lastInboundMs = this.now();
    }

    noteInbound(): void {
        if (this.dead) {
            return;
        }
        this.lastInboundMs = this.now();
        this.pingSentAtMs = null;
    }

    start(): void {
        if (this.timer !== undefined) {
            return;
        }
        this.lastInboundMs = this.now();
        this.timer = setInterval(() => {
            this.tick();
        }, 250);
    }

    stop(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    tick(): void {
        if (this.dead) {
            return;
        }
        const now = this.now();
        const silentMs = now - this.lastInboundMs;
        if (this.pingSentAtMs === null) {
            if (silentMs >= this.pingIntervalMs) {
                this.pingSentAtMs = now;
                this.sendPing();
            }
            return;
        }
        if (now - this.pingSentAtMs >= this.livenessTimeoutMs) {
            this.fail(
                `xAI WebSocket silent for ${silentMs}ms after ping (timeout ${this.livenessTimeoutMs}ms)`,
            );
        }
    }

    private fail(reason: string): void {
        if (this.dead) {
            return;
        }
        this.dead = true;
        this.stop();
        this.onDead(reason);
    }
}
