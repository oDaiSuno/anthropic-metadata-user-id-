# anthropic-metadata-user-id

A pi extension that injects Anthropic Messages request-body `metadata.user_id` for every selected `anthropic-messages` model.

The injected `user_id` is a JSON string because the upstream service parses it server-side:

```json
{
  "device_id": "<stable random 64-char hex id>",
  "account_uuid": "",
  "session_id": "<current pi session id>"
}
```

## Install from GitHub

```bash
pi install git:github.com/oDaiSuno/anthropic-metadata-user-id-
```

For one-off testing without installing:

```bash
pi -e git:github.com/oDaiSuno/anthropic-metadata-user-id-
```

## Local development install

This repository can also be placed directly at:

```text
~/.pi/agent/extensions/anthropic-metadata-user-id/index.ts
```

pi auto-discovers `~/.pi/agent/extensions/*/index.ts`. If pi is already running, use `/reload`; otherwise restart pi.

## State

On first extension load, `device_id` is generated with:

```ts
randomBytes(32).toString("hex")
```

It is persisted to:

```text
~/.pi/agent/extensions/anthropic-metadata-user-id/state.json
```

There is no default `DEVICE_ID`. Deleting `state.json` intentionally rotates the device id on the next load.

For tests only, override the state path with:

```bash
PI_ANTHROPIC_METADATA_STATE_FILE=/tmp/state.json
```

## Optional account UUID

Set `PI_METADATA_ACCOUNT_UUID` if you want a non-empty `account_uuid`. If unset, `account_uuid` is the empty string.

## Test

```bash
npm test
```

The test loads the TypeScript extension through `jiti`, verifies random `device_id` creation, checks `metadata.user_id` injection, preserves existing metadata, and skips non-`anthropic-messages` models.
