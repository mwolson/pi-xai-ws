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
catalog and verifies that `grok-4.6` still resolves to `openai-responses`.

## Source layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Extension entry point. |
| `src/provider.ts` | xAI provider registration and API matching. |
| `src/stream.ts` | Pi stream setup, hooks, output projection, and error completion. |
| `src/payload.ts` | Pi option preparation, full-context payloads, tools, reasoning, headers, and cache affinity. |
| `src/continuation.ts` | Stored-response chain planning, covered-prefix checks, and rejection detection. |
| `src/history.ts` | Responses and legacy thinking-signature handling. |
| `src/config.ts` | Global `getAgentDir()/pi-xai-ws.json` loading, WebSocket URL safety, and environment settings. |
| `src/liveness.ts` | Ping-on-silence state machine. |
| `src/ws-events.ts` | WebSocket protocol, session pool, serialization, replay, bounds, and lifecycle. |
| `src/errors.ts` | xAI error normalization for Pi. |
| `src/pi-ai-api.ts` | Runtime access to Pi's internal Responses helpers. |

The package intentionally contains TypeScript source rather than a compiled
`dist` directory. Pi loads the extension entry point through its TypeScript
extension loader.

## Pi compatibility imports

Pi 0.84 aliases `@earendil-works/pi-ai` to `dist/compat.js` while loading
extensions. A direct runtime import such as:

```ts
import { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
```

can therefore resolve under `dist/compat.js/api` and abort every Pi session at
startup.

Load sibling `dist/api` files through `src/pi-ai-api.ts`. That module resolves
the exact `@earendil-works/pi-ai/compat` export, locates its sibling API files,
and loads them by filesystem path. Type-only imports from Pi's API subpaths are
safe because TypeScript removes them.

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

## WebSocket changes

`src/ws-events.ts` owns both individual sockets and the session pool. Keep these
rules when adding or changing protocol events:

1. A session has one active request.
2. Default-mode requests carry complete local history. Stored requests carry a
   verified suffix from the socket-local or durable covered prefix.
3. Only one pre-output transport retry is allowed.
4. Every event that represents model output disables the internal retry.
5. A replacement socket replans from the durable checkpoint rather than the
   latest socket-local head.
6. Protocol, local-bound, queue, lifecycle, and abort errors do not retry.
7. Socket callbacks verify that they still belong to the current socket and
   request.
8. All queues, frames, requests, and timers remain bounded.
9. Disposal wakes waiters and prevents reconnects.

When xAI adds an output event, update `isModelOutputEvent` before projecting the
event. Missing an output type can cause a complete request to replay after the
model has already started work.

When xAI adds a terminal event, update terminal detection and add a transport
test proving that the generator settles after that event.

## Test strategy

The test suite has three levels.

Focused tests cover payloads, history filtering, URL protection, liveness, error
normalization, provider registration, global config parsing, and environment
override precedence. The test runner forces storage off before loading test
files so a developer's global opt-in cannot change suite behavior.

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
