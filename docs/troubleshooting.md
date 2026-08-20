# Troubleshooting

## Confirm that Pi selected the extension

Pi selects an extension stream only when the model's resolved API matches the
API registered by the extension. `pi-xai-ws` registers
`openai-responses` for the built-in `xai` provider.

If Grok works but this package does not log any socket activity, inspect the
resolved model. It should report:

```text
provider: xai
api: openai-responses
```

Pi's current remote catalog uses that API for `xai/grok-4.6`, while Pi 0.84.2's
bundled xAI catalog labels the same model `openai-completions`. If a catalog
refresh fails and Pi uses that bundled definition, it will not select this
transport. Update Pi or refresh its model catalog rather than registering this
extension against the wrong API.

Another extension can also replace the xAI provider registration. In
particular, passing a `models` property to `registerProvider("xai", ...)`
replaces Pi's built-in xAI model catalog.

## Enable debug logging

Set `PI_XAI_WS_DEBUG=1` before starting Pi:

```sh
PI_XAI_WS_DEBUG=1 pi
```

The extension writes concise diagnostics to stderr. They include socket opens,
closes, rotations, request mode, input-item counts, and pre-output recovery.
They do not include credentials, request content, generated text, reasoning, or
tool arguments.

A healthy two-turn session should normally show one socket open and two
`mode=full` requests. The second request should have more input items because it
contains the expanded local history.

## Authentication failures

The extension reuses the xAI credential Pi passes to provider streams. For the
intended setup, authenticate Pi with SuperGrok OAuth first. The package does not
run a separate xAI login flow.

If the extension reports `No API key for provider: xai`, verify that Pi has a
current xAI OAuth record and that the selected model belongs to the `xai`
provider. Restart Pi after repairing or refreshing the credential.

Do not put credentials in `PI_XAI_WS_URL`. That setting contains only the
WebSocket endpoint.

## Custom xAI endpoints and proxies

By default, the WebSocket URL is derived from `model.baseUrl` when the host is
xAI. The extension rejects a non-xAI HTTP base URL unless
`PI_XAI_WS_URL` explicitly names the matching WebSocket endpoint. This guard
prevents proxy credentials from being sent to public xAI by accident.

For a custom endpoint, configure both sides consistently:

```sh
PI_XAI_WS_URL=wss://proxy.example.test/v1/responses pi
```

Changing the URL, headers, or liveness settings changes the transport identity.
The next request closes the retained socket and opens one with the new values.

## Liveness failures

The default healthcheck sends a protocol ping after 15 seconds without an
inbound frame and allows another 60 seconds for any response.

If a slow but healthy connection repeatedly reaches the liveness timeout, raise
`PI_XAI_WS_LIVENESS_TIMEOUT_MS`. Avoid shortening it below normal model startup
time. Valid Grok requests have been observed with more than 25 seconds of
inbound silence.

If a dead connection answers WebSocket pings but its request worker has stopped,
the transport cannot distinguish it from a live connection. Apply a turn-level
timeout outside this extension when a strict deadline is required.

## Connection rotation

A log entry for `request age` or `max age` is normal. The extension rotates
before xAI's 25-minute connection limit and does not start new requests after
75 percent of the configured maximum age.

Frequent unexpected rotations usually mean one of these values changes between
calls:

- Authorization or another upgrade header
- WebSocket URL
- Connection timeout
- Ping interval
- Liveness timeout

## Replay and duplicate-work concerns

A request can replay once only after a connection, socket, liveness, or explicit
xAI WebSocket connection-limit failure before model output.

The extension does not replay malformed frames, queue overflows, local payload
limits, aborts, or failures after output starts. Reasoning summaries, refusals,
function-call arguments, and custom-tool input all count as output.

If logs show `pre-output reconnect`, xAI may still have received the first full
request even though no output reached Pi. The one-replay limit prevents an
unbounded recovery loop, but no client can prove that a silent remote worker did
nothing. Apply stricter caller policy if duplicate remote work is unacceptable.

## Queue and payload-limit failures

The extension fails rather than accumulating unbounded data when any of these
limits is reached:

- 4 MiB inbound frame
- 4,096 parsed events waiting for Pi
- 8 MiB of parsed events waiting for Pi
- 64 requests waiting in one session

A request backlog usually means callers are issuing overlapping model calls for
the same Pi session. Allow the active stream to settle or abort obsolete queued
calls.

## Existing threads and uninstalling

The package writes Responses-shaped assistant history with
`api: "openai-responses"`. Existing threads remain compatible while the package
is installed.

Start a new Pi session after uninstalling the package or switching the same
model to an `openai-completions` transport. This avoids asking another transport
to reinterpret encrypted Responses reasoning and Responses-specific history.

## Package load failures

Pi supplies `@earendil-works/pi-ai` and
`@earendil-works/pi-coding-agent` as extension peer dependencies. A package
manager may report them as unmet when inspecting the extension's private npm
installation even though Pi supplies them at load time.

A real startup failure usually includes an extension import error. Confirm that
the package contains `src/pi-ai-api.ts` and that the installed Pi version is
0.84 or newer. Direct `@earendil-works/pi-ai/api/...` runtime imports do not work
under Pi 0.84's extension aliasing; the package must use its compatibility
loader.
