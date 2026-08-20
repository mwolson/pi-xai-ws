import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LIVENESS_TIMEOUT_MS, SocketLiveness } from "../src/liveness.ts";

describe("SocketLiveness", () => {
    it("defaults the post-ping timeout to 60 seconds", () => {
        const live = new SocketLiveness(
            () => {},
            () => {},
        );
        assert.equal(live.livenessTimeoutMs, 60_000);
        assert.equal(DEFAULT_LIVENESS_TIMEOUT_MS, 60_000);
    });

    it("sends a ping after the quiet interval and fails if nothing returns", () => {
        let now = 1_000;
        let pings = 0;
        let dead: string | undefined;

        const live = new SocketLiveness(
            () => {
                pings += 1;
            },
            (reason) => {
                dead = reason;
            },
            {
                pingIntervalMs: 15_000,
                livenessTimeoutMs: 10_000,
                now: () => now,
            },
        );

        live.tick();
        assert.equal(pings, 0);
        assert.equal(dead, undefined);

        now += 14_999;
        live.tick();
        assert.equal(pings, 0);

        now += 1;
        live.tick();
        assert.equal(pings, 1);
        assert.equal(dead, undefined);

        now += 9_999;
        live.tick();
        assert.equal(pings, 1);
        assert.equal(dead, undefined);

        now += 1;
        live.tick();
        assert.equal(pings, 1);
        assert.match(dead ?? "", /silent for 25000ms after ping/);
    });

    it("sends a ping before failing when the first tick jumps past the full budget", () => {
        let now = 1_000;
        let pings = 0;
        let dead: string | undefined;

        const live = new SocketLiveness(
            () => {
                pings += 1;
            },
            (reason) => {
                dead = reason;
            },
            {
                pingIntervalMs: 15_000,
                livenessTimeoutMs: 10_000,
                now: () => now,
            },
        );

        now += 26_000;
        live.tick();
        assert.equal(pings, 1);
        assert.equal(dead, undefined);

        now += 9_999;
        live.tick();
        assert.equal(dead, undefined);

        now += 1;
        live.tick();
        assert.equal(pings, 1);
        assert.match(dead ?? "", /after ping/);
    });

    it("treats any inbound frame as a pong and does not fail during a write burst", () => {
        let now = 1_000;
        let pings = 0;
        let dead: string | undefined;

        const live = new SocketLiveness(
            () => {
                pings += 1;
            },
            (reason) => {
                dead = reason;
            },
            {
                pingIntervalMs: 15_000,
                livenessTimeoutMs: 10_000,
                now: () => now,
            },
        );

        for (let i = 0; i < 40; i += 1) {
            now += 500;
            live.noteInbound();
            live.tick();
        }

        assert.equal(pings, 0);
        assert.equal(dead, undefined);
        assert.equal(now - 1_000, 20_000);
    });

    it("cancels a pending ping timeout when traffic arrives", () => {
        let now = 1_000;
        let pings = 0;
        let dead: string | undefined;

        const live = new SocketLiveness(
            () => {
                pings += 1;
            },
            (reason) => {
                dead = reason;
            },
            {
                pingIntervalMs: 15_000,
                livenessTimeoutMs: 10_000,
                now: () => now,
            },
        );

        now += 15_000;
        live.tick();
        assert.equal(pings, 1);

        now += 2_000;
        live.noteInbound();
        live.tick();
        assert.equal(dead, undefined);

        now += 14_999;
        live.tick();
        assert.equal(pings, 1);
        assert.equal(dead, undefined);
    });

    it("fails only once", () => {
        let now = 1_000;
        let deaths = 0;
        const live = new SocketLiveness(
            () => {},
            () => {
                deaths += 1;
            },
            {
                pingIntervalMs: 1_000,
                livenessTimeoutMs: 1_000,
                now: () => now,
            },
        );

        now += 1_000;
        live.tick();
        now += 1_000;
        live.tick();
        live.tick();
        live.noteInbound();
        assert.equal(deaths, 1);
        assert.equal(live.dead, true);
    });
});
