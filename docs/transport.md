# Transport design

`pi-xai-ws` replaces Pi's HTTP Responses stream for xAI models with xAI's
Responses WebSocket mode. It keeps conversation state in Pi rather than asking
xAI to retain Responses objects.

The design has two independent forms of reuse:

- Pi's stable session ID supplies cache affinity.
- One physical WebSocket is retained for serial calls in that session.

Neither form relies on `previous_response_id` or retrievable server-side
Responses state.

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
normalizes the result through JSON serialization, forces `store: false`, and
deletes `previous_response_id`. This final pass prevents a hook from enabling
storage or response continuation. It also makes the retained retry payload
match the exact JSON wire shape for dates, custom `toJSON` methods, accessors,
class instances, sparse arrays, and undefined array elements.

The normalized payload is created once per logical request. A permitted
transport replay sends that same complete payload again.

## Full local history

Every request sends Pi's current conversation. Pi remains authoritative after
compaction, branch changes, tool calls, interruption, and process restarts.
There is no server-side response chain to reconcile.

`src/history.ts` distinguishes Responses thinking signatures from legacy
Completions signatures. It retains JSON-shaped Responses signatures and removes
field-name signatures such as `reasoning_content` before conversion.

Pi's Responses stream processor projects output events back into its durable
assistant message format. This includes reasoning, messages, function calls,
tool results, phases, annotations, and normalized function argument JSON.

## Privacy and cache affinity

All requests use `store: false`. The extension never sends
`previous_response_id`.

The session ID normally supplies both:

- `prompt_cache_key` in the request payload
- `x-grok-conv-id` in the WebSocket upgrade headers

These values preserve cache and routing affinity without making Responses state
retrievable. Setting Pi's `cacheRetention` option to `"none"` omits both.

This matches the stateless request shape used by the official Grok Build CLI.
A direct SuperGrok OAuth probe rejected same-socket continuation with
`previous_response_id`, so this package does not maintain a continuation path
or ask users to enable Responses storage.

See [xAI WebSocket mode](https://docs.x.ai/developers/advanced-api-usage/websocket-mode)
and [xAI's prompt caching guidance](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits).

## Sessions and serialization

A nonempty Pi session ID selects a retained session object. The session allows
one active model call and queues at most 64 waiting calls. Requests run in order
so frames from different calls cannot overlap on one socket.

A call without a session ID receives a request-owned session and socket. The
transport disposes both when that call ends.

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
can settle, then the session closes the socket. An idle session closes its
socket after five minutes by default and removes itself from the pool.

## Liveness

Every inbound WebSocket frame proves liveness. This includes Responses events,
protocol pongs, and server ping frames.

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

The transport permits one complete-request replay when all of these conditions
hold:

- No replay has occurred for the logical request.
- No model-output event has arrived.
- The failure is a connection, socket, or liveness failure, or xAI reports its
  WebSocket connection limit before output.

Output includes text, reasoning and reasoning summaries, refusals, output
items, function-call arguments, and custom-tool input. Once any such event
arrives, the transport cannot prove that replay is free from duplicate work.
The turn fails instead.

Malformed JSON, non-object frames, inbound payload-limit failures, event queue
overflow, lifecycle errors, and aborts never replay. Neither do provider errors
other than the explicit pre-output WebSocket connection-limit signal.

## Resource bounds

Each socket enforces these defaults:

| Resource | Limit |
| --- | ---: |
| Inbound WebSocket frame | 4 MiB |
| Parsed events waiting for the consumer | 4,096 events |
| Bytes waiting for the consumer | 8 MiB |
| Waiting requests per session | 64 requests |
| Connection handshake | 15 seconds |
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
