# Development

## Requirements

Development uses Node.js 22.19 or newer. The release workflow tests on Node.js
24.

Install dependencies and run the main checks:

```sh
npm install
npm test
npm run test:catalog
```

`npm test` runs strict TypeScript checking before the package unit and transport
tests. `npm run test:catalog` is separate because it fetches Pi's current xAI
catalog and verifies that `grok-4.7` still resolves to `openai-responses`.

## Source layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Extension entry point. |
| `src/provider.ts` | xAI provider registration and API matching. |
| `src/stream.ts` | Pi stream setup, hooks, storage safety enforcement, output projection, and error completion. |
| `src/payload.ts` | Pi option preparation, full-context payloads, tools, reasoning, headers, and cache affinity. |
| `src/continuation.ts` | Stored-response chain planning, canonical prefix digests, and rejection detection. |
| `src/empty-thinking.ts` | Same-run Grok recovery after a mid-loop thinking-only stop. |
| `src/loop-recovery.ts` | Pi event integration for abort, sanitization, compaction, and bounded recovery. |
| `src/repetition-detector.ts` | Bounded exact, near-duplicate, and low-novelty checks. |
| `src/stored-context.ts` | Context-usage inspection and the one-shot stored-limit warning. |
| `src/history.ts` | Responses and legacy thinking-signature handling, plus the newest-first image-byte budget. |
| `src/config.ts` | Global `getAgentDir()/pi-xai-ws.json` loading, WebSocket URL safety, and environment settings. |
| `src/liveness.ts` | Ping-on-silence state machine. |
| `src/ws-events.ts` | WebSocket protocol, session pool, serialization, replay, bounds, and lifecycle. |
| `src/errors.ts` | xAI error normalization for Pi. |
| `src/pi-ai-api.ts` | Runtime access to Pi's internal Responses helpers. |

The package intentionally contains TypeScript source rather than a compiled
`dist` directory. Pi loads the extension entry point through its TypeScript
extension loader.

## Pi compatibility imports

Pi aliases `@earendil-works/pi-ai` and `@earendil-works/pi-ai/compat`
while loading extensions. A direct runtime import such as:

```ts
import { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
```

is not aliased, and those exports have no `require` condition, so Pi's CJS
extension loader aborts at startup.

Load those helpers as files through `src/pi-ai-api.ts`. Pi's CJS extension
loader cannot `require` `@earendil-works/pi-ai/api/*` because those exports have
no `require` condition, and they are not on the aliased `/compat` module. The
loader realpaths `process.argv[1]` and loads `dist/api/<name>.js` from the host
CLI's node_modules, so a packed install without peer packages still sees Pi's
own tree when `pi` is a `bin/` symlink. Type-only imports from Pi's API
subpaths are safe because TypeScript removes them.

Compiled bun and sea binaries have no on-disk `dist/api`. Skip `$bunfs` argv
paths, then use `src/pi-ai-fallback/` copies that statically import the aliased
`@earendil-works/pi-ai` compat surface. Native `createRequire("@earendil-works/pi-ai")`
bypasses that alias and fails on those hosts.

Read transcript tool declarations with `resolveTranscriptTools` from
`@earendil-works/pi-ai`. That helper is on the compat surface, so it works on
both Node CLI hosts and compiled binaries.

## Transcript context

The provider-facing context is a branded `TranscriptContext`. The system prompt
and tool declarations live on its leading system message. Read tools through
`resolveRequestToolsFn` in `src/payload.ts`, which calls the host's
`resolveTranscriptTools` helper. A transport that still reads `Context.tools`
declares no tools, and Grok writes tool calls as prose instead of calling them.

Compile against current Pi packages in `devDependencies` so `npm test` exercises
that contract. `tests/payload.test.ts` covers a transcript `toolsAdded` system
message.

A host event may narrow a message type to a single role. Compare such a field
through a widened local instead of an inline literal.

Keep both Pi packages in `peerDependencies`. Pi supplies them to the extension
at runtime, while the exact versions in `devDependencies` make local tests
repeatable.

## Provider registration

The extension must register the `xai` provider with API
`openai-responses`. Pi matches an extension stream against the resolved model
API. Registering `openai-completions` does not intercept current Responses-based
Grok models.

Do not add a `models` property unless the package is intentionally taking
ownership of the whole xAI model catalog. Pi treats provider model registration
as a replacement, not an additive override.

The catalog integration test guards this contract against Pi's current remote
catalog:

```sh
npm run test:catalog
```

## Payload invariants

Build requests with Pi's existing Responses conversion and option helpers.
Changes must retain:

- Context-aware output-token limits
- Sampling and service-tier options
- Tool conversion and tool choice
- Reasoning effort and summary mapping
- Encrypted reasoning output
- Payload and response hooks
- Cache-affinity behavior

The payload hook runs before the transport enforcement pass. Unless the global
`getAgentDir()/pi-xai-ws.json` config enables `storeResponses`, or
`PI_XAI_WS_STORE` explicitly enables it, no code path may send `store: true` or
`previous_response_id`, including hook replacements and retry payloads. The
environment value overrides the config file, including `0` to force the mode
off. With storage and a nonempty Pi session ID enabled,
`src/continuation.ts` owns request planning. The session tracks a socket-local
head and a durable checkpoint, and
only the session may set `previous_response_id` after the hook. Later terminals
on one physical socket advance the socket-local head without advancing the
durable checkpoint because response IDs may repeat or cycle.

Normalize the payload through JSON serialization once before the first send.
Tests cover dates, custom `toJSON` methods, accessors, class instances, sparse
arrays, and undefined array values. Avoid object-spread-only normalization,
which does not match the actual JSON wire representation.

Stored mode may enforce `maxStoredContextTokens` after the payload hook when
that cutoff is configured. There is no default cutoff. Estimate the conversation
xAI would store from the latest reliable provider total usage plus trailing
messages. Do not max that with unsliced prepared payload JSON: that JSON includes
full local history, tools, and encrypted reasoning, and it will cross the
threshold during continuation while usage is still safe. Use the prepared payload
estimate only when there is no reliable provider usage yet. Recognize both raw
compaction-summary messages and Pi's converted prefixed-user shape, then ignore
retained pre-compaction usage by timestamp. Without reliable usage, estimate all
current messages instead of failing open. Normalize early only when storage is
configured and mark that payload for the pool so custom `toJSON` behavior still
runs once. The default storage-off path skips the safety estimate. At a
configured threshold, force `store: false`, remove continuation state, and send
full local history. Record the exact stream decision for the extension warning.
Never retry `Response is too large to store` after output begins. Keep the
streamed output, latch `store: false` until a later compaction, and retry that
request with `store: false` only when the rejection arrived before output.

## WebSocket changes

`src/ws-events.ts` owns both individual sockets and the session pool. Keep these
rules when adding or changing protocol events:

1. A session has one active request.
2. Default-mode requests carry complete local history. Stored requests carry a
   suffix verified against the socket-local or durable prefix digest.
3. Only one pre-output transport retry is allowed.
4. Every event that represents model output disables the internal retry.
5. A replacement socket replans from the durable checkpoint rather than the
   latest socket-local head.
6. Protocol, local-bound, queue, lifecycle, and abort errors do not retry.
7. Socket callbacks verify that they still belong to the current socket and
   request.
8. All queues, frames, requests, and timers remain bounded.
9. Disposal wakes waiters and prevents reconnects.
10. Maximum socket age interrupts active requests before xAI's hard limit.
11. Any connection-limit response retires its physical socket, including after output.

When xAI adds an output event, update `isModelOutputEvent` before projecting the
event. Missing an output type can cause a complete request to replay after the
model has already started work.

When xAI adds a terminal event, update terminal detection and add a transport
test proving that the generator settles after that event.

## Test strategy

The test suite has three levels.

Focused tests cover payloads, history filtering, URL protection, liveness, error
normalization, provider registration, repetition detection and recovery, global
config parsing, and environment override precedence. Repetition fixtures must
remain synthetic and must not include private session content. The test runner
forces storage off before loading test files so a developer's global opt-in
cannot change suite behavior.

The local WebSocket harness covers framing and session behavior without calling
xAI. It should prove:

- Full-history requests on a reused socket
- Privacy enforcement after hooks
- Transport identity rotation
- Pre-output retry, durable-checkpoint recovery, and post-output suppression
- Abort races and queued aborts
- Disposal barriers
- Idle and maximum-age rotation
- Frame, event, byte, and request bounds
- Malformed protocol data
- Repeated and cycling socket-local response IDs across multiple reconnects
- Missing stored-response references and one bounded full-context fallback
- Proactive storage downgrade at the configured context-token boundary

The catalog integration test checks Pi's current remote model metadata. Keep it
outside `npm test` so routine local tests remain deterministic.

Before release, add a package-load smoke test and a live two-turn Pi probe as
described in [Release process](releasing.md). Live probes should assert durable
facts such as socket-open count, full-request count, resolved API, and history
growth rather than relying only on the generated text.

## Package checks

Before committing a release candidate, run:

```sh
npm test
npm run test:catalog
git diff --check
npm pack --dry-run
```

Inspect the tarball contents. It should contain the extension source, README,
license, and `docs` directory. It should not contain tests, temporary probe
output, credentials, or local session data.
