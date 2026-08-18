# pi-xai-ws

WebSocket transport for Pi's built-in xAI Completions models.

`pi-xai-ws` intercepts `grok-4.6`, `grok-4.3`, and `grok-build-0.1` in Pi
0.84.2 and sends their turns to xAI's official Responses WebSocket:

`wss://api.x.ai/v1/responses`

It reuses the xAI API key or SuperGrok OAuth credentials already stored in Pi.
`grok-4.5` stays on Pi's built-in HTTP Responses transport.

## Install

Install from GitHub:

```sh
pi install git:github.com/mwolson/pi-xai-ws
```

Or install a local checkout:

```sh
pi install /absolute/path/to/pi-xai-ws
```

T3 Nightly re-adds packages from `settings.json` around
`pi --mode rpc --no-extensions`, so installing the package is enough to enable
it there.

Passing `models` to another `registerProvider("xai")` call replaces Pi's model
catalog. Omit `models` to keep the built-in xAI models available.

## Healthcheck

Any inbound WebSocket frame counts as liveness, including data, pong, and server
ping frames.

1. After 15 seconds with no inbound frame, the extension sends an RFC 6455
   protocol ping.
2. If another 5 seconds pass after that ping with no inbound frame, the turn
   fails and the extension closes the socket.

The defaults are `15000` and `5000` milliseconds and can be changed with the
environment variables below.

A live probe on 2026-08-18 measured quiet-socket pongs at about 75 ms. During an
active turn, pongs waited as long as 9.6 seconds for the turn to stop writing,
while response deltas continued to arrive. Those deltas count as liveness.

A live edge that still answers ping after its worker dies would keep the turn
open.

## Settings

| Variable | Default | Description |
| --- | --- | --- |
| `PI_XAI_WS_URL` | Derived from `model.baseUrl`, otherwise `wss://api.x.ai/v1/responses` | WebSocket URL. Required when `xai.baseUrl` does not use `api.x.ai` so proxy credentials are not sent to public xAI. |
| `PI_XAI_WS_PING_INTERVAL_MS` | `15000` | Inbound silence in milliseconds before a protocol ping. |
| `PI_XAI_WS_LIVENESS_TIMEOUT_MS` | `5000` | Additional inbound silence in milliseconds after the ping before the turn fails. |

With `cacheRetention: "none"`, the extension omits `prompt_cache_key` and
`x-grok-conv-id`.

## Turn behavior

- Each turn opens a new socket. xAI closes a socket after 25 minutes, so a turn
  still running at that point ends with the server close.
- Aborts use Pi's `AbortSignal` and close the socket.
- A liveness failure uses `stopReason: "error"` so Pi can retry the turn.
- Steer waits until the current stream ends.

## Thread history

Existing Completions threads continue to work. Field-name thinking signatures
such as `reasoning_content` are dropped from the Responses payload. Encrypted
Completions `thoughtSignature` values on tool calls stay unused.

History written by this package is Responses-shaped even though `api` remains
`openai-completions`. Start a new session after uninstalling the package.

## Development

Load sibling `dist/api` files through `src/pi-ai-api.ts`. Direct imports of
`@earendil-works/pi-ai/api/...` abort every Pi 0.84 session at startup, because
jiti aliases `@earendil-works/pi-ai` to `dist/compat.js`.

Run the test suite with:

```sh
npm test
```
