# pi-xai-ws

WebSocket transport for Pi's built-in xAI models.

`pi-xai-ws` intercepts Responses-based Grok models in Pi and sends their turns
to xAI's official Responses WebSocket at `wss://api.x.ai/v1/responses`. It
reuses the SuperGrok OAuth credentials already stored in Pi, aiming for good
performance and coherent caching.

## Requirements

`pi-xai-ws` requires Pi 0.86.0 or newer.

## Install

Install the package from npm:

```sh
pi install npm:@mwolson-org/pi-xai-ws
```

Try it for one run without adding it to your settings:

```sh
pi -e npm:@mwolson-org/pi-xai-ws
```

You can also install it from GitHub or a local checkout:

```sh
pi install git:github.com/mwolson/pi-xai-ws
pi install /absolute/path/to/pi-xai-ws
```

Remove the package with:

```sh
pi remove npm:@mwolson-org/pi-xai-ws
```

## Recommended Pi retry settings

The extension marks recognized xAI capacity and temporary availability errors
as "overloaded" and retryable WebSocket transport failures as socket errors so
Pi can apply its agent-level retry policy. Availability wording such as
"temporarily unavailable" and "currently degraded" is included, because Pi does
not treat those phrases as transient on its own. Pi enables that policy by default. For
longer Grok jobs, these optional agent-wide settings raise the retry budget and
backoff for every provider. Merge them into the global Pi settings file at
`getAgentDir()/settings.json`, normally `~/.pi/agent/settings.json`:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 5,
    "baseDelayMs": 3000,
    "provider": {
      "maxRetries": 0
    }
  }
}
```

Keeping provider-level retries disabled, as Pi does by default, lets Pi own the
retry budget and avoids stacking SDK retries under agent-level retries. This
policy is separate from the extension's single safe transport replay before
model output begins.

## Settings

| Variable                        | Default                                                               | Description                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_XAI_WS_URL`                 | Derived from `model.baseUrl`, otherwise `wss://api.x.ai/v1/responses` | WebSocket URL. Set this when `xai.baseUrl` does not use `api.x.ai` so proxy credentials are not sent to public xAI.                            |
| `PI_XAI_WS_PING_INTERVAL_MS`    | `15000`                                                               | Inbound silence in milliseconds before a protocol ping.                                                                                        |
| `PI_XAI_WS_LIVENESS_TIMEOUT_MS` | Pi's stream timeout                                                    | Additional inbound silence after the ping before the turn fails. When unset, the combined ping and liveness window follows Pi's `timeoutMs`, normally 300 seconds. |
| `PI_XAI_WS_IDLE_TIMEOUT_MS`                 | `300000`                                                              | Idle milliseconds before the retained socket closes. The durable checkpoint stays in RAM for the process and on disk for later Pi processes.         |
| `PI_XAI_WS_LOOP_NOVELTY_THRESHOLD`          | `0.85`                                                                | Fraction of recent thinking 5-grams that must already exist before the long-output novelty backstop stops a response.                           |
| `PI_XAI_WS_LOOP_RECOVERY_LIMIT`             | `2`                                                                   | Automatic recoveries allowed inside `PI_XAI_WS_LOOP_RECOVERY_BUDGET_MS`. `0` disables compaction and recovery steering; detection and abort still fire. |
| `PI_XAI_WS_LOOP_RECOVERY_COOLDOWN_MS`       | `600000`                                                              | Minimum milliseconds between two automatic recoveries. Must be positive; zero or invalid values fall back to the default.                       |
| `PI_XAI_WS_LOOP_RECOVERY_BUDGET_MS`         | `1800000`                                                             | Rolling window in milliseconds over which the recovery limit is counted. Each recovery ages out individually after this interval. The limit binds only when this window is longer than limit times cooldown. `0` makes a spent budget permanent for the session. |
| `PI_XAI_WS_MAX_AGE_MS`                      | `1440000`                                                             | Hard maximum socket age. The default interrupts and retries an active request before xAI's 25-minute connection limit.                          |
| `PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS`       | unset                                                                 | Optional preemptive stored-mode cutoff. At or above this estimated stored conversation size, calls switch to `store: false` until compaction. Unset means keep storing until xAI rejects a response as too large. |
| `PI_XAI_WS_MAX_REQUEST_IMAGE_BYTES`         | `8388608`                                                             | Newest-first budget for image bytes on the wire. Older screenshots become short placeholders so full-history requests stay under xAI's WebSocket size limit. Once omitted in a session, a screenshot stays omitted. |
| `PI_XAI_WS_STORE`                           | unset                                                                 | Override stored-response continuation. `1` or `true` enables it; any other defined value disables it.                                          |
| `PI_XAI_WS_DEBUG`                           | unset                                                                 | Set to `1` for lifecycle, request-shape, and recovery diagnostics. Logs exclude request data, credentials, generated text, and tool arguments. |

With `cacheRetention: "none"`, the extension omits `prompt_cache_key` and
`x-grok-conv-id`. Pi's stream timeout controls the default maximum inbound
silence, while `PI_XAI_WS_LIVENESS_TIMEOUT_MS` remains an explicit transport
override for troubleshooting.

### Global package config

Pi extensions conventionally keep global package configuration under the Pi
agent directory. [xAI documents a 30-day retention period](https://docs.x.ai/developers/model-capabilities/text/generate-text)
for saved Responses state, including previous prompts, reasoning content, and
model responses. This opt-in makes that state retrievable by ID for continuation
and is incompatible with [Zero Data Retention](https://docs.x.ai/developers/faq/security#what-is-zero-data-retention-zdr).
Enable it only when that retention is acceptable. Cache affinity remains enabled
when stored responses are off.

Enable stored-response continuation for every Pi process using this agent
directory by creating `~/.pi/agent/pi-xai-ws.json`:

```json
{
  "storeResponses": true
}
```

The package resolves the directory through Pi's `getAgentDir()`, so
`PI_CODING_AGENT_DIR` and embedded Pi runtimes continue to work. The environment
variable `PI_XAI_WS_STORE` takes precedence when it is defined, including
`PI_XAI_WS_STORE=0` to force storage off. Project-local configuration is not
supported because a repository must not opt users into server-side retention.
A missing, malformed, unreadable, or non-boolean config remains safely off.

Stored mode also accepts an optional positive integer
`maxStoredContextTokens`, overridden by a valid
`PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS`. There is no default cutoff. Invalid
environment values fall back to the global config, then to no cutoff. This is a
safety boundary for provider storage, not a model context-window setting. If xAI
rejects a stored response as too large, the extension keeps any streamed output,
disables storage until compaction, and does not retry that request.

The same global file may set `loopNoveltyThreshold` to a ratio above zero and at
most one. `PI_XAI_WS_LOOP_NOVELTY_THRESHOLD` takes precedence. The default is
`0.85`; invalid values fall back to the file and then the default.

Automatic recovery is bounded by `loopRecoveryLimit` (default `2`) recoveries
per rolling `loopRecoveryBudgetMs` (default `1800000`), with at least
`loopRecoveryCooldownMs` (default `600000`) between them.
`PI_XAI_WS_LOOP_RECOVERY_LIMIT`, `PI_XAI_WS_LOOP_RECOVERY_COOLDOWN_MS`, and
`PI_XAI_WS_LOOP_RECOVERY_BUDGET_MS` take precedence; invalid values fall back to
the file and then the default. A `loopRecoveryLimit` of zero disables compaction
and steering. A `loopRecoveryBudgetMs` of zero makes a spent budget permanent.
The limit binds only while the window can hold more recoveries than the limit, so
keep `loopRecoveryBudgetMs` above `loopRecoveryLimit x loopRecoveryCooldownMs`.
Inside that window, Pi says recovery is paused until an earlier recovery ages out
or you send another message. A zero budget window keeps the permanent
session-limit notice.

## How it works

- A Pi session reuses one WebSocket and serializes model calls through it.
- By default every call sends Pi's complete local history with `store: false`
  and no `previous_response_id`.
- With `storeResponses: true` in the global package config, or
  `PI_XAI_WS_STORE=1`, and a nonempty Pi session ID, calls use `store: true` and
  `previous_response_id` continuation. Same-socket calls send only the
  newest items. After reconnecting, including a new Pi process, the request
  resumes from the durable response checkpoint on disk and includes every
  locally recorded item since it. If xAI rejects a stored response as too large,
  the extension keeps streamed output, clears continuation, and sends complete
  local history with `store: false` until compaction. An optional configured
  `maxStoredContextTokens` cutoff can make that switch before xAI rejects. The
  estimate, when used, is reliable provider usage plus trailing messages, so a
  large new tool result is included before the next request. It does not use
  unsliced full-history JSON. Calls without a session ID remain `store: false`.
  See
  [Stored-response continuation](docs/transport.md#stored-response-continuation).
- Encrypted Responses reasoning remains in local history and can be sent with
  the next request.
- The extension retains Pi's token limits, sampling options, payload hooks,
  response hooks, tool behavior, and error projection.
- Connect, socket, liveness, or xAI connection-limit failures may retry once
  before model output begins. Stored continuation rebuilds that retry from its
  durable checkpoint rather than assuming a repeated socket-local response ID
  identifies the latest state on a replacement socket.
- If a Grok assistant message in the current agent run is only thinking, with
  `stop` and no text or tools, the extension injects one hidden same-run follow-up
  so Pi continues instead of settling. The first assistant of a run is left alone.
  Other providers are not nudged.
- Bounded exact, near-duplicate, and low-novelty checks stop repetitive xAI
  thinking or prose. The extension sanitizes the unfinished assistant message,
  compacts the context when useful, and queues one hidden recovery turn. A
  recurrence inside the cooldown is stopped without another automatic compaction.
  Each recovery ages out of the budget individually, so a spent budget is not
  permanent. A real user turn re-arms the budget and the cooldown; hidden steers
  do not, so an unattended session keeps its bound.
- Sockets enable TCP keepalive and have fixed memory, age, and idle bounds.
  Pi's session shutdown closes that session's socket, so `pi -p` exits as soon
  as the run settles.

See [Transport design](docs/transport.md) for payload construction, lifecycle,
liveness, replay rules, resource bounds, and Pi integration details.

## Known limitations

This extension does not guarantee uninterrupted cache hits or proactive
avoidance of Grok's 500,000-token prompt limit.

- Stored continuation reduces full-history requests. Cache affinity helps reuse
  cached prefixes, but compaction, changed history, and rejected stored
  references can still require a cold replay. A continuation sidecar does not
  guarantee every reconnect can use it.
- Pi owns context compaction. xAI can reject a reconstructed prompt even when
  the last reported token usage is well below the limit. Raising Pi's global
  compaction reserve is not a reliable fix for that discrepancy. See
  [Maximum prompt length](docs/troubleshooting.md#maximum-prompt-length-is-500000).
- SuperGrok OAuth rejects same-socket `store: false` continuation in the tested
  request shape. Disabling storage requires full local history and can lose
  cache reuse. Stored continuation remains an explicit retention opt-in, not a
  requirement for using the extension.
- Provider capacity errors can exhaust Pi's bounded retry budget. The transport
  does not guarantee completion when xAI remains overloaded.

## Existing threads

Existing threads continue to work. The extension drops legacy field-name
thinking signatures such as `reasoning_content` from Responses requests while
retaining encrypted reasoning produced by Responses models.

History written by this package uses `api: "openai-responses"`. Start a new Pi
session after uninstalling the package or switching the same model back to a
Completions transport.

## Documentation

- [Transport design](docs/transport.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)
- [Release process](docs/releasing.md)

## Development

Run the package checks with:

```sh
npm test
npm run test:catalog
```

See [Development](docs/development.md) for the source layout, compatibility
imports, test strategy, and contribution rules.
