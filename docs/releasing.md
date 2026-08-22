# Release process

Git tags start `.github/workflows/publish.yml`, which validates and publishes
the package to npm. The tag must exactly match the version in `package.json`.
Do not run `npm publish` locally. Create the GitHub release by hand after npm
publication succeeds, as described in step 8.

## 1. Choose the version

Use a patch release for fixes that preserve the transport contract. Use a minor
release for new provider behavior, settings, session lifecycle, or request
semantics.

Update `package.json` and `package-lock.json` together. For example:

```sh
npm version minor --no-git-tag-version
```

Check that both files contain the intended version before continuing.

## 2. Run deterministic validation

From the repository root:

```sh
npm test
npm run test:catalog
git diff --check
npm pack --dry-run
```

The publish workflow repeats `npm test` and `npm run test:catalog` on Node.js
24. Treat either failure as a release blocker.

Inspect the dry-run file list. A release should contain:

- `src/`
- `docs/`
- `README.md`
- `LICENSE`
- `package.json`

It should not contain tests, temporary probes, credentials, or Pi session data.

## 3. Test the packed package

A source-checkout test can hide missing package metadata or undeclared runtime
imports. Pack the exact release candidate and install it in an empty directory.
Install with peer dependency installation disabled so the smoke test proves Pi
can supply its own peer packages:

```sh
rm -rf tmp/package-smoke
mkdir -p tmp/package-smoke/install
npm pack --pack-destination tmp/package-smoke
printf '{"private":true}\n' > tmp/package-smoke/install/package.json
cd tmp/package-smoke/install
npm install --legacy-peer-deps --ignore-scripts ../mwolson-org-pi-xai-ws-*.tgz
```

Load the installed `src/index.ts` through Pi's real extension loader, not a
standalone TypeScript import. A minimal RPC startup check is sufficient:

```sh
printf '{"type":"get_state"}\n' |
    pi --mode rpc --no-session --no-tools --no-extensions \
        --extension "$PWD/node_modules/@mwolson-org/pi-xai-ws/src/index.ts"
```

The command must return a successful `get_state` response without an extension
load error. This catches missing peer declarations, missing tarball files, and
Pi compatibility-import failures.

Return to the repository root after the smoke test.

## 4. Run a live two-turn probe

Use a temporary Pi session with SuperGrok OAuth and
`PI_XAI_WS_DEBUG=1`. Send two model calls through `xai/grok-4.6` in the same Pi
session.

Verify these facts:

- The model resolves to `api: "openai-responses"`.
- Both calls finish successfully.
- Debug output reports one physical socket open.
- Debug output reports two `mode=full` requests.
- The second wire request has more input items than the first.
- Pi history grows by one user and one assistant message per turn.
- No unexpected replay or connection-limit recovery occurs.
- With `PI_XAI_WS_STORE=0`, no payload uses `store: true` or
  `previous_response_id`, even when the global package config enables it.

Generated wording is not a useful assertion. Record counts and request shape
instead.

When validating the opt-in stored-response mode, set `storeResponses: true` in
`getAgentDir()/pi-xai-ws.json`, leave `PI_XAI_WS_STORE` unset, and run a separate
multi-turn probe with a nonempty Pi session ID and `PI_XAI_WS_DEBUG=1`. Require
one `mode=full` first request and same-socket `mode=continue` follow-ups
containing only new input items. This verifies the package-owned config path,
not just the environment override.

Also rotate the socket after two successful tool-call responses that share one
xAI response ID. Verify that the replacement-socket request uses the durable
checkpoint plus the projected tool and assistant items since that checkpoint,
then completes without repeating a tool call. Confirm the package regression
also covers response IDs cycling `A`, `B`, `A` before rotation and through a
second socket boundary. In a separate probe, corrupt one
`previous_response_id` and verify that the live `Response with id=... not found`
error causes exactly one full-context fallback with no continuation reference.

## 5. Review the final package diff

Review the final change against the last release tag. Check these areas
explicitly:

- Provider API registration
- Payload-hook privacy enforcement
- Replay eligibility and output detection
- Abort and disposal paths
- Queue, frame, timer, idle, and age bounds
- Peer and packaged-file declarations
- README and detailed documentation

Transport changes benefit from an independent review because an incorrect
socket-local or durable checkpoint can duplicate remote model work without
corrupting local state.

## 6. Commit and tag

Commit the validated release candidate. The release tag must match the package
version:

```sh
version=$(node -p 'require("./package.json").version')
git tag "v$version"
```

Push the branch first. Push the tag only after the branch push succeeds and the
intended commit is visible on the remote. The tag starts the npm publish
workflow.

## 7. Verify npm publication

Wait for both workflow jobs to pass, then confirm npm reports the new version:

```sh
npm view @mwolson-org/pi-xai-ws version
```

Confirm that the npm tarball includes `docs/` and that its peer dependencies
still name both Pi packages.

## 8. Draft and publish the GitHub release

Create the GitHub release only after npm publication succeeds. From the
repository root, fetch the remote tags and resolve the previous version tag
before asking GitHub to generate a draft:

```sh
git fetch --tags origin
tag="v$(node -p 'require("./package.json").version')"
previous_tag=$(git describe --tags --abbrev=0 --match 'v*' "$tag^") || {
    echo "Could not resolve the previous tag from $tag." >&2
    exit 1
}

gh release create "$tag" \
    --draft \
    --generate-notes \
    --notes-start-tag "$previous_tag" \
    --title "$tag" \
    --verify-tag

mkdir -p tmp
gh release view "$tag" --json body --jq .body > "tmp/release-$tag.md"
git log --oneline "$previous_tag..$tag"
```

Review the commits since the previous tag and edit the generated notes in
`tmp/release-$tag.md`. Start with a short summary. Group related changes under
descriptive headings instead of using one generic `## Changes` section when a
release has multiple themes. Put user-visible changes first and maintenance
details afterward. Keep GitHub's `Full Changelog` link at the bottom when the
generated notes included one.

Do not include routine verification sections or lists of check commands in
public release notes. Report validation separately in the release handoff.

Update and inspect the draft:

```sh
tag="v$(node -p 'require("./package.json").version')"
gh release edit "$tag" --notes-file "tmp/release-$tag.md"
gh release view "$tag" --web
```

Publish only after the draft looks correct. Then verify the published release:

```sh
tag="v$(node -p 'require("./package.json").version')"
gh release edit "$tag" --draft=false
gh release view "$tag" --json isDraft,url
```

Confirm that `isDraft` is `false` and that the release URL resolves to the
intended tag.

## 9. Upgrade and verify Pi discovery

Update the installed package:

```sh
pi update npm:@mwolson-org/pi-xai-ws
```

Start a fresh Pi process and a fresh session. Confirm that Pi discovers the new
package version and resolves `xai/grok-4.6` to the extension's
`openai-responses` stream. Run one short prompt with debug logging enabled.

Only investigate or rebuild a downstream host application if that fresh process
still loads the previous package. Package-only releases should normally require
no host rebuild.
