# pi-xai-ws

Pi's built-in `xai/grok-4.6` talks HTTP Chat Completions. That stream can sit on
`api.x.ai:443` with no tokens after thinking ends. The OpenAI SDK timeout only
covers fetch-until-headers, so the turn never fails.

This package intercepts Pi's `xai` Completions models and sends them over the
official Responses WebSocket instead:

`wss://api.x.ai/v1/responses`

It reuses the same stored xAI API key or SuperGrok OAuth token Pi already has.

The healthcheck fails a dead TCP session in about 20s. It does not add a
no-tokens timer. If xAI's edge still answers RFC 6455 ping after the worker
stops writing, the turn stays open. That case was not reproduced on this socket.

## Healthcheck

There is no JSON ping frame. The client event type is only `response.create`.

The healthcheck is RFC 6455 ping, plus this rule: any inbound frame counts as
liveness. A delayed pong during a write burst is fine, because the burst itself
is traffic.

1. Remember `last_inbound` on every data frame, pong, or server ping.
2. After 15s of silence, send a protocol ping.
3. If 5s later there is still no inbound frame, fail the turn and close the
   socket.

A live probe against `api.x.ai` on 2026-08-18 showed quiet-socket pongs in about
75ms, and in-flight pongs delayed until the turn stopped writing (up to 9.6s)
while deltas were still arriving. Counting those deltas as liveness is what
keeps a healthy Grok turn alive.

This can miss a wedge where the TLS session stays up and some edge still
answers ping after the worker has died. That is a hope about xAI's wiring, not
a guarantee. Do not treat install as a fix for the HTTP Completions hang until
a wedged worker on this socket actually misses ping.

## Install

```sh
pi install git:github.com/mwolson/pi-xai-ws
```

Or a local checkout:

```sh
pi install /absolute/path/to/pi-xai-ws
```

T3 Nightly re-adds `settings.json` packages around `pi --mode rpc --no-extensions`,
so an installed copy is enough for `xai/grok-4.6`. Do not pass `models` in your
own `registerProvider("xai")` or you will wipe the catalog.

`grok-4.5` stays on built-in HTTP Responses. Only Completions models
(`grok-4.6`, `grok-4.3`, `grok-build-0.1` in Pi 0.84.2) are intercepted.

Existing Completions threads keep working. Thinking signatures stored as field
names (`reasoning_content`, and so on) are dropped for the Responses payload
instead of crashing `JSON.parse`. Encrypted Completions `thoughtSignature` on
tool calls is not replayed. After uninstall, start a new session. History this
package wrote is Responses-shaped even though `api` stays `openai-completions`.

xAI closes a socket after 25 minutes. A single generate that long fails on the
close. Each turn opens a new socket.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_XAI_WS_URL` | derived from `model.baseUrl`, else `wss://api.x.ai/v1/responses` | WebSocket URL. Required if `xai.baseUrl` is not `api.x.ai`, so a proxy token is not sent to public xAI |
| `PI_XAI_WS_PING_INTERVAL_MS` | `15000` | Silence before a protocol ping |
| `PI_XAI_WS_LIVENESS_TIMEOUT_MS` | `5000` | Extra silence after that ping before fail |

`cacheRetention: "none"` omits `prompt_cache_key` and `x-grok-conv-id`.

## Abort

T3 `{ "type": "abort" }` becomes Pi's `AbortSignal`. The socket is closed.
A liveness failure is `stopReason: "error"`, not user abort, so Pi can retry.

Steer still waits until the stream ends. A dead socket that fails in ~20s is
what lets the queued steer apply.

## Develop

```sh
npm test
```
