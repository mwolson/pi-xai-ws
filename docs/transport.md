# Transport design

`pi-xai-ws` replaces Pi's HTTP Responses stream for xAI models with xAI's
Responses WebSocket mode. By default it keeps conversation state in Pi rather
than asking xAI to retain Responses objects.

The design has two independent forms of reuse:

- Pi's stable session ID supplies cache affinity.
- One physical WebSocket is retained for serial calls in that session.

Neither form relies on `previous_response_id` or retrievable server-side
Responses state. An opt-in third mode adds stored-response continuation and is
described in [Stored-response continuation](#stored-response-continuation).

## Request construction

`src/stream.ts` starts with Pi's own option preparation. It uses Pi's
`buildBaseOptions` behavior, including context-aware output-token limits, then
maps Pi's reasoning level for the selected model.

`src/payload.ts` converts the complete Pi context and tool definitions with
Pi's Responses helpers. The payload preserves supported options such as:

- `max_output_tokens`
- `temperature`
- `service_tier`
- `tool_choice`
- reasoning effort and summary
- provider sampling parameters

Reasoning models request `reasoning.encrypted_content` so encrypted reasoning
can survive in Pi's local history and return with the next full-context call.

Pi's payload hook runs after the base payload is built. The transport then
normalizes the result through JSON serialization, forces `store` to the
configured mode (`false` by default, `true` only with the global package config
or `PI_XAI_WS_STORE` plus a nonempty Pi session ID), and deletes any
hook-supplied `previous_response_id`. This final pass prevents a hook from
enabling storage or response continuation outside the explicit opt-in.
It also makes the retained retry payload match the exact JSON wire shape for
dates, custom `toJSON` methods, accessors, class instances, sparse arrays, and
undefined array elements.

The normalized full-context payload is created once per logical request.
A permitted retry without stored continuation sends that payload again. Stored
continuation replans a replacement-socket retry from the latest durable
checkpoint because a socket-local response ID may not identify the same state
after reconnecting.

## Full local history by default

Without stored-response continuation, every request sends Pi's current
conversation. Pi remains authoritative after compaction, branch changes, tool
calls, interruption, and process restarts. There is no server-side response
chain to reconcile in this default mode.

`src/history.ts` distinguishes Responses thinking signatures from legacy
Completions signatures. It retains JSON-shaped Responses signatures and removes
field-name signatures such as `reasoning_content` before conversion.

Pi's Responses stream processor projects output events back into its durable
assistant message format. This includes reasoning, messages, function calls,
tool results, phases, annotations, and normalized function argument JSON.

## Privacy and cache affinity

By default all requests use `store: false` and the extension never sends
`previous_response_id`. The global opt-in file is
`getAgentDir()/pi-xai-ws.json`, normally `~/.pi/agent/pi-xai-ws.json`:

```json
{
  "storeResponses": true
}
```

`PI_XAI_WS_STORE` overrides the file whenever the variable is defined. Only `1`
or `true` enables storage; `0`, `false`, an empty value, and other values force
it off. Missing, malformed, unreadable, and non-boolean config values remain
off. Project-local config is intentionally unsupported so a repository cannot
enable server-side retention.

The session ID normally supplies both:

- `prompt_cache_key` in the request payload
- `x-grok-conv-id` in the WebSocket upgrade headers

These values preserve cache and routing affinity without making Responses state
retrievable. Setting Pi's `cacheRetention` option to `"none"` omits both.

The default request shape matches the official Grok Build CLI, which sets
`store: false` because the Responses API default of retaining requests breaks
zero-data-retention compliance. Enable stored-response continuation only if
xAI retaining your prompts and responses server-side is acceptable.

See [xAI WebSocket mode](https://docs.x.ai/developers/advanced-api-usage/websocket-mode)
and [xAI's prompt caching guidance](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits).

## Stored-response continuation

With `storeResponses: true` in the global config, or
`PI_XAI_WS_STORE=1`, and a nonempty Pi session ID, requests set `store: true`
and the session maintains two continuation positions:

- The socket-local head covers the latest successful response on the current
  physical WebSocket.
- The durable checkpoint covers the first safely rehydratable completion on a
  physical WebSocket. Later terminals on that socket do not advance it, even
  when their response IDs differ.

The first call sends complete history. After Pi processes a terminal response,
the transport converts the finalized assistant message through the same
Responses converter used for the next request. Server-only output items are not
counted because xAI may retain items that Pi does not persist locally.

On one open socket, later calls verify a SHA-256 digest of the complete covered
prefix and send only the newest suffix with `previous_response_id`. The local
checkpoint retains the covered item count and digest rather than the input
objects themselves. Live SuperGrok OAuth probes
on 2026-08-21 showed that xAI can reuse one response ID for multiple completed
calls on a socket. The socket-local state advances, but reconnecting with that
ID rehydrates the first stored response associated with it rather than the
latest socket-local response.

The session therefore describes the first safely rehydratable prefix for the
current socket lineage with its durable checkpoint. Later terminals update only
the socket-local head because IDs could follow a sequence such as `A`, `B`,
`A`; promoting the final `A` would attach its newer local prefix to A's older
stored state. After a socket boundary, the session verifies the durable
checkpoint digest, then sends its `previous_response_id` plus every locally
projected input and assistant item after the checkpoint's item count. The
replacement socket's first
successful terminal can promote a new response ID to the next durable
checkpoint. A focused live probe verified a recovery suffix containing a tool
result, projected reasoning and function call, and the next tool result. xAI
reconstructed the chain without repeating the tool call and returned a new
durable response ID. If xAI later guarantees uniquely rehydratable IDs for
every WebSocket completion, this conservative rule can be relaxed to reduce the
recovery suffix.

The chain falls back to one full-context request without a continuation
reference when any of these occur:

- History was rewritten or shrank below the covered prefix, for example after
  compaction or an assistant-message edit.
- A completed response added no new input items.
- Pi could not project finalized assistant output into a reusable prefix.
- The endpoint, credentials, headers, or other transport identity settings
  changed. Stored response references never cross those boundaries.
- xAI rejects or no longer recognizes the reference before output begins. The
  live WebSocket error may contain only `Response with id=... not found`, with
  no structured code or parameter. The transport forgets both continuation
  positions, closes the socket, and retries complete local history once.
- No reusable terminal storage event was observed for the previous call.

Reference rejection has a separate bounded budget from pre-output transport
retry. Each recovery may run once per logical request, but a reference fallback
does not replenish an already spent transport replay. Idle cleanup closes only
the physical socket. The retained session keeps its durable checkpoint and can
continue from it on the replacement socket. Process restarts and explicit pool
disposal clear both continuation positions. Debug counters expose
`continuedRequests`, `continuationFallbacks`, and `fullRequests`;
`PI_XAI_WS_DEBUG=1` logs each request as `mode=full` or `mode=continue` with its
input item count.

Retained server state also means xAI holds prompt and response content for its
own retention period. That tradeoff, not transport mechanics, is why the mode
is off by default.

## Sessions and serialization

A nonempty Pi session ID selects a retained session object. The session allows
one active model call and queues at most 64 waiting calls. Requests run in order
so frames from different calls cannot overlap on one socket. The pool does not
evict durable checkpoints by count. Sessions that hold them remain until process
exit or explicit pool disposal, preserving continuation across any number of
session IDs. Each retained position contains a response ID, covered item count,
and fixed-size SHA-256 digest rather than conversation content. Its size is
independent of conversation length, apart from the provider-issued response ID.
Long-lived processes that store responses for many distinct IDs therefore keep
only small checkpoint metadata for each ID. A session with no durable checkpoint
may be removed after an aborted or failed request leaves it without a socket.

A call without a session ID receives a request-owned session and socket. The
transport forces `store: false` because that call cannot reuse continuation
state, then disposes the session and socket when the call ends.

Queued aborts leave the active request and socket alone. Aborting the active
request closes its socket. Disposing a session wakes queued callers, prevents
the active call from reconnecting, and reports a non-replayable lifecycle
error. A failed initial acquisition that never opened a socket is removed from
the session pool.

## Socket identity and lifetime

A retained socket belongs to one transport identity. The identity contains the
WebSocket URL, canonical upgrade headers, connection timeout, ping interval,
and liveness timeout. Changing any of them closes the old socket before the
next request.

The default maximum socket age is 24 minutes, below xAI's documented 25-minute
connection limit. The transport stops assigning new requests to a socket after
75 percent of its configured maximum age. With the default setting, a request
therefore starts on a fresh socket after 18 minutes. This leaves time for a
long-running turn before the hard limit.

Reaching maximum age during a request marks the socket expired. The active call
can settle, then the session closes the socket. A session also closes its socket
after five idle minutes by default, but keeps its durable continuation checkpoint
for the next connection.

## Liveness

Every inbound WebSocket frame proves liveness. This includes Responses events,
protocol pongs, and server ping frames. The underlying TCP socket also enables
keepalive after 15 seconds of transport silence so the operating system can
detect a broken network path without waiting for xAI to process a WebSocket
control frame.

The default sequence is:

1. Wait 15 seconds without an inbound frame.
2. Send an RFC 6455 protocol ping.
3. Wait another 60 seconds for any inbound frame.
4. Fail the request and close the socket if the connection remains silent.

The post-ping window was raised from 10 seconds after live requests showed more
than 25 seconds of valid inbound silence. During other probes, pongs could wait
behind active writes while response deltas continued arriving. Counting every
inbound frame avoids declaring those connections dead.

A remote edge that still answers protocol pings after its request worker dies
cannot be detected by this healthcheck. Pi or the caller must apply a broader
turn deadline if it needs one.

## Replay contract

The transport permits one pre-output retry when all of these conditions hold:

- No replay has occurred for the logical request.
- No model-output event has arrived.
- The failure is a connection, socket, or liveness failure, or xAI reports its
  WebSocket connection limit before output.

Output includes text, reasoning and reasoning summaries, refusals, output
items, function-call arguments, and custom-tool input. Once any such event
arrives, the transport cannot safely restart the in-flight stream internally.
The transport reports an error instead, after which Pi's separate retry policy
may start a new assistant attempt from local context.

A default-mode retry sends complete local history again. A stored-mode retry
opens a replacement socket and replans from the durable checkpoint plus every
locally recorded item after it. It does not resend only the newest suffix
against a response ID whose latest meaning existed only on the failed socket.

Malformed JSON, non-object frames, inbound payload-limit failures, event queue
overflow, lifecycle errors, and aborts never replay. Neither do provider errors
other than the explicit pre-output WebSocket connection-limit signal.

## Resource bounds

The transport enforces these defaults:

| Resource | Limit |
| --- | ---: |
| Inbound WebSocket frame | 4 MiB |
| Parsed events waiting for the consumer | 4,096 events |
| Bytes waiting for the consumer | 8 MiB |
| Waiting requests per session | 64 requests |
| Connection handshake | 15 seconds |
| TCP keepalive initial delay | 15 seconds |
| Idle socket | 5 minutes |
| Socket age | 24 minutes |

Crossing a frame or event bound closes the socket and fails the turn without a
replay. Queue accounting uses the serialized event size rather than retaining
an unbounded list of parsed provider objects.

## Error and abort behavior

xAI error envelopes can be direct, nested, or loosely typed. The transport
normalizes them before Pi's Responses processor sees them. Recognized capacity
messages keep xAI's original text and add Pi's `overloaded` marker so Pi can
apply its own retry budget and backoff.

Pi's `AbortSignal` applies while waiting for a session, opening a socket,
running the response hook, sending the request, and reading events. The active
socket closes on abort so stale callbacks cannot deliver frames into a later
request.

## Pi provider integration

`src/provider.ts` registers the built-in `xai` provider with API
`openai-responses`. Pi chooses extension streams by resolved API, so registering
against `openai-completions` would leave current Responses-based Grok models on
Pi's original transport.

The registration omits a `models` property. Supplying models to another
`registerProvider("xai")` call replaces Pi's built-in xAI catalog, while this
package only replaces the matching stream implementation.

Pi supplies `@earendil-works/pi-ai` and
`@earendil-works/pi-coding-agent` to loaded extensions. They remain declared as
peer dependencies so package managers and development tools record that host
contract.
