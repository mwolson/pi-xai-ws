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

## Settings

| Variable                        | Default                                                               | Description                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_XAI_WS_URL`                 | Derived from `model.baseUrl`, otherwise `wss://api.x.ai/v1/responses` | WebSocket URL. Set this when `xai.baseUrl` does not use `api.x.ai` so proxy credentials are not sent to public xAI.                            |
| `PI_XAI_WS_PING_INTERVAL_MS`    | `15000`                                                               | Inbound silence in milliseconds before a protocol ping.                                                                                        |
| `PI_XAI_WS_LIVENESS_TIMEOUT_MS` | `60000`                                                               | Additional inbound silence after the ping before the turn fails.                                                                               |
| `PI_XAI_WS_IDLE_TIMEOUT_MS`     | `300000`                                                              | Idle milliseconds before a retained session socket closes.                                                                                     |
| `PI_XAI_WS_MAX_AGE_MS`          | `1440000`                                                             | Maximum socket age. The default stays below xAI's 25-minute connection limit.                                                                  |
| `PI_XAI_WS_DEBUG`               | unset                                                                 | Set to `1` for lifecycle, request-shape, and recovery diagnostics. Logs exclude request data, credentials, generated text, and tool arguments. |

With `cacheRetention: "none"`, the extension omits `prompt_cache_key` and
`x-grok-conv-id`.

## How it works

- A Pi session reuses one WebSocket and serializes model calls through it.
- Every call sends Pi's complete local history with `store: false` and no
  `previous_response_id`.
- Encrypted Responses reasoning remains in local history and can be sent with
  the next request.
- The extension retains Pi's token limits, sampling options, payload hooks,
  response hooks, tool behavior, and error projection.
- Connect, socket, liveness, or xAI connection-limit failures may replay the
  complete request once, but only before model output begins.
- Protocol errors, local bound violations, aborts, disposal, and failures after
  output begins never replay.
- Sockets and request queues have fixed memory, age, and idle bounds.

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
