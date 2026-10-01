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
field-name signatures such as `reasoning_content` before conversion. It also
applies a newest-first image-byte budget before the payload is built. Older
screenshot blocks become short text placeholders once the request exceeds 8MB
of image data by default. Once omitted in a session, that screenshot stays
omitted on later calls so a new shot does not resurrect an older image in the
wire prefix. Configure that with `maxRequestImageBytes` or
`PI_XAI_WS_MAX_REQUEST_IMAGE_BYTES`. The newest screenshot is kept even when it
alone exceeds the budget. This is a wire-size guard; Pi's session file still
stores the original images.

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

The same global config accepts an optional positive integer
`maxStoredContextTokens`. A valid `PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS`
overrides it; an invalid environment value falls back to the file, then to no
cutoff. The value is a safety boundary for provider storage, not the model
context window. Unset, stored continuation stays on until xAI rejects a
response as too large.

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
- The endpoint, conversation id, or other non-credential transport identity
  settings changed. Stored response references never cross those boundaries.
  A refreshed `Authorization` token on the same account reconnects the socket
  and keeps the durable checkpoint. xAI still rejects a reference that belongs
  to a different account, and that rejection falls back to full history once.
- xAI rejects or no longer recognizes the reference before output begins. The
  live WebSocket error may contain only `Response with id=... not found`, with
  no structured code or parameter. The transport forgets both continuation
  positions, closes the socket, and retries complete local history once.
- No reusable terminal storage event was observed for the previous call.

Reference rejection has a separate bounded budget from pre-output transport
retry. Each recovery may run once per logical request, but a reference fallback
does not replenish an already spent transport replay. Idle cleanup closes only
the physical socket. The retained session keeps its durable checkpoint and can
continue from it on the replacement socket. The durable checkpoint is also
written under `getAgentDir()/pi-xai-ws/continuations/<sessionId>.json` so a new
Pi process can resume it. Pool disposal and process exit drop RAM only. Digest
mismatch, transport-identity change, expiry after 30 days, or a missing session
file drop the sidecar. Debug counters expose
`continuedRequests`, `continuationFallbacks`, and `fullRequests`;
`PI_XAI_WS_DEBUG=1` logs each request as `mode=full` or `mode=continue` with its
input item count.

xAI can reject a long response after model output with `Response is too large to
store`. A post-output retry would duplicate generated work, so the transport
keeps any streamed output, latches `store: false` until compaction, and does not
retry that request. A rejection before output retries once with full local
history and `store: false`.

If `maxStoredContextTokens` is configured, the transport also estimates the
current stored conversation before each request from the latest reliable
provider total usage plus trailing messages. Crossing that cutoff clears
continuation state, warns once, and forces `store: false` plus complete local
history until compaction lowers the estimate. After compaction, retained
pre-compaction usage is ignored. Pi converts the compaction entry to a prefixed
user message before provider streaming, so the estimator recognizes both the raw
extension shape and that wire-facing shape, then uses timestamps to reject
retained older assistants. If no reliable usage exists, all current messages are
estimated rather than allowing storage by default. The guard measures that
stored conversation size, not the unsliced local wire JSON. A live continuation
still sends only new items. Using the full prepared payload JSON as a max()
would disable storage while usage is still safe. The prepared payload estimate
is used only when there is no reliable provider usage yet. There is no default
cutoff: SuperGrok OAuth still rejects same-socket `store: false` continuation,
so dropping `store` early forces full-history replays that miss cache.

The opt-in stored path always normalizes the post-hook payload once and marks
that record as already normalized for the session pool. The estimate runs only
when a cutoff is configured. The default storage-off path skips both and keeps
its existing one-shot wire normalization.

A long SuperGrok OAuth tool loop on 2026-08-23 failed at roughly 251,000 input
tokens with `too large to store`. Later padded probes stored through 328,000, so
billed tokens are a poor predictor.
Current xAI WebSocket documentation says same-socket continuation supports
`store: false`, but SuperGrok OAuth probes on 2026-08-23 and 2026-09-02 returned
`Response with id=... not found` for that shape. The package therefore keeps
sending full local history after the safety downgrade instead of relying on a
continuation mode that the intended credential path rejects.

Retained server state also means xAI holds prompt and response content for its
own retention period. That tradeoff, not transport mechanics, is why the mode
is off by default.

## Sessions and serialization

A nonempty Pi session ID selects a retained session object. The session allows
one active model call and queues at most 64 waiting calls. Requests run in order
so frames from different calls cannot overlap on one socket. The pool does not
evict durable checkpoints by count. Sessions that hold them remain until process
exit, Pi's `session_shutdown` for that session ID, or explicit pool disposal,
preserving continuation across any number of session IDs in RAM. The same durable fields are persisted per session id so a
later process can restore them. Each retained position contains a response ID,
covered item count, and fixed-size SHA-256 digest rather than conversation content. Its size is
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

Reaching maximum age closes the socket even during an active request. Before
model output, the transport may use its one bounded internal replay. After
output, retryable socket, connection, and liveness failures include Pi's
WebSocket wording so Pi's configured outer retry can start a fresh assistant
attempt. Protocol, queue, and lifecycle failures remain non-retryable. Any xAI
connection-limit frame retires its physical socket, including a frame received
after a completed response or while the session is idle. A session also closes
its socket after five idle minutes by default, but keeps its durable
continuation checkpoint for the next connection.

Pi sends `session_shutdown` on quit, reload, `/new`, `/resume`, and fork. The
extension then disposes the pool entry for that Pi session ID and closes its
socket at once, so print-mode runs such as `pi -p` exit when the agent settles
instead of after the idle timeout. Other session IDs in the same process keep
their sockets. The on-disk checkpoint remains, and a later request with the same
session ID restores it.

## Liveness

Every inbound WebSocket frame proves liveness. This includes Responses events,
protocol pongs, and server ping frames. The underlying TCP socket also enables
keepalive after 15 seconds of transport silence so the operating system can
detect a broken network path without waiting for xAI to process a WebSocket
control frame.

The default sequence is:

1. Wait 15 seconds without an inbound frame.
2. Send an RFC 6455 protocol ping.
3. Keep waiting within Pi's configured stream-idle timeout, normally 300 seconds total.
4. Fail the request and close the socket if the connection remains silent.

`PI_XAI_WS_LIVENESS_TIMEOUT_MS` explicitly replaces the post-ping portion when
set. Otherwise the extension subtracts the ping interval from Pi's `timeoutMs`
so its watchdog does not terminate a healthy stream before Pi's configured
budget. This matters for xAI function calls, which xAI documents as arriving
whole in one streaming chunk rather than as incremental argument deltas.
Counting every inbound frame still avoids declaring responsive connections
dead.

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
items, function-call arguments, custom-tool input, and provider-tool lifecycle
events such as web search, code interpreter, file search, and MCP calls. Once
any such event arrives, the transport cannot safely restart the in-flight stream internally.
The transport reports an error instead, after which Pi's separate retry policy
may start a new assistant attempt from local context.

A default-mode retry sends complete local history again. A stored-mode retry
opens a replacement socket and replans from the durable checkpoint plus every
locally recorded item after it. It does not resend only the newest suffix
against a response ID whose latest meaning existed only on the failed socket.

Malformed JSON, non-object frames, inbound payload-limit failures, event queue
overflow, lifecycle errors, and aborts never replay. Neither do provider errors
other than the explicit pre-output WebSocket connection-limit signal. A
connection-limit signal after output retires the physical socket before the
error reaches Pi, preventing an outer retry from reusing an exhausted socket.

## Repetitive-output recovery

`src/loop-recovery.ts` observes xAI assistant deltas through Pi's extension
events. It keeps bounded state per content block and resets at turn and tool-call
boundaries. The detector combines:

- Exact adjacent-suffix detection over at most 8,192 recent characters.
- Word 5-gram similarity across rolling 1,024-character windows after
  normalizing whitespace, counters, and numbers.
- A long-thinking backstop that checks whether at least 85 percent of the newest
  8,000 characters' 5-grams already occurred in the preceding bounded history.

Visible fenced code is excluded. The low-novelty ratio can be changed with
`loopNoveltyThreshold` in the global package config or
`PI_XAI_WS_LOOP_NOVELTY_THRESHOLD`. Detection diagnostics contain only kind,
period, character counts, provider, and model. Generated content is never
logged.

On the first detection, the extension aborts the active response, removes the
repeated suffix and provider signatures from the finalized assistant message,
and keeps at most 8,192 clean prefix characters. After Pi commits that sanitized
message, the extension starts compaction with instructions to preserve the
user's goal, completed tool work, repository state, constraints, and next step.
A successful compaction queues one hidden model-visible recovery message. If Pi
reports that the session is already compacted or too small to compact, recovery
continues directly because the aborted assistant is already excluded from xAI
context. Other compaction failures settle without retrying the same context.

Automatic recovery is capped at two per session. A second recurrence within ten
minutes is aborted and reported without another automatic compaction. This
prevents the guard itself from creating an unbounded retry loop.

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
and temporary availability messages keep xAI's original text and add Pi's
`overloaded` marker so Pi can apply its own retry budget and backoff. That
includes `currently at capacity`, `due to high demand`, `temporarily
unavailable`, and `currently degraded`. Pi's classifier does not match
"Service temporarily unavailable" by itself, because its `service unavailable`
pattern requires those words to be adjacent. The exact
`websocket_connection_limit_reached` code similarly gains a `WebSocket error`
marker after the exhausted socket is retired.

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
