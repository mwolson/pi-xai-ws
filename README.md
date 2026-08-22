# pi-xai-ws

WebSocket transport for Pi's built-in xAI models.

`pi-xai-ws` intercepts Responses-based Grok models in Pi and sends their turns
to xAI's official Responses WebSocket at `wss://api.x.ai/v1/responses`. It
reuses the SuperGrok OAuth credentials already stored in Pi, aiming for good
performance and coherent caching.

## Requirements

`pi-xai-ws` requires Pi 0.84 or newer.

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

The extension marks recognized xAI capacity errors as "overloaded" so Pi can
apply its agent-level retry policy. Pi enables that policy by default. For
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
| `PI_XAI_WS_LIVENESS_TIMEOUT_MS` | `60000`                                                               | Additional inbound silence after the ping before the turn fails.                                                                               |
| `PI_XAI_WS_IDLE_TIMEOUT_MS`     | `300000`                                                              | Idle milliseconds before the retained socket closes. Any durable checkpoint remains available until process exit or explicit disposal.         |
| `PI_XAI_WS_MAX_AGE_MS`          | `1440000`                                                             | Maximum socket age. The default stays below xAI's 25-minute connection limit.                                                                  |
| `PI_XAI_WS_STORE`               | unset                                                                 | Override stored-response continuation. `1` or `true` enables it; any other defined value disables it.                                          |
| `PI_XAI_WS_DEBUG`               | unset                                                                 | Set to `1` for lifecycle, request-shape, and recovery diagnostics. Logs exclude request data, credentials, generated text, and tool arguments. |

With `cacheRetention: "none"`, the extension omits `prompt_cache_key` and
`x-grok-conv-id`.

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

## How it works

- A Pi session reuses one WebSocket and serializes model calls through it.
- By default every call sends Pi's complete local history with `store: false`
  and no `previous_response_id`.
- With `storeResponses: true` in the global package config, or
  `PI_XAI_WS_STORE=1`, and a nonempty Pi session ID, calls use `store: true` and
  `previous_response_id` continuation. Same-socket calls send only the
  newest items. After reconnecting, the request resumes from the latest durable
  response checkpoint and includes every locally recorded item since it. Calls
  without a session ID remain `store: false`. See
  [Stored-response continuation](docs/transport.md#stored-response-continuation).
- Encrypted Responses reasoning remains in local history and can be sent with
  the next request.
- The extension retains Pi's token limits, sampling options, payload hooks,
  response hooks, tool behavior, and error projection.
- Connect, socket, liveness, or xAI connection-limit failures may retry once
  before model output begins. Stored continuation rebuilds that retry from its
  durable checkpoint rather than assuming a repeated socket-local response ID
  identifies the latest state on a replacement socket.
- Protocol errors, local bound violations, aborts, disposal, and failures after
  output begins never replay.
- Sockets enable TCP keepalive and have fixed memory, age, and idle bounds.

See [Transport design](docs/transport.md) for payload construction, lifecycle,
liveness, replay rules, resource bounds, and Pi integration details.

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
