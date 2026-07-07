# anthropic-metadata-user-id

A pi extension that adapts every selected `anthropic-messages` model request to look like Claude Code traffic while preserving pi's normal tool execution.

It currently does six things:

1. Injects Anthropic request-body `metadata.user_id` as a JSON string.
2. Registers Claude Code-style request headers for the active Anthropic provider.
3. Forces an `Authorization: Bearer <apiKey>` header for every `anthropic-messages` provider it manages (see [Bearer auth header](#bearer-auth-header)).
4. Rewrites outgoing tool names to Claude Code-style names.
5. Restores rewritten tool-call names during streaming and in the final assistant message before pi renders or dispatches tools.
6. Forces Claude Code-style adaptive thinking fields in the outgoing request body.

The injected `metadata.user_id` is a JSON string because the upstream service parses it server-side:

```json
{
  "device_id": "<stable random 64-char hex id>",
  "account_uuid": "",
  "session_id": "<current pi session id>"
}
```

## Claude Code headers

For `anthropic-messages` models, the extension registers these provider headers:

```text
user-agent: claude-cli/<latest @anthropic-ai/claude-code version> (external, cli)
X-Claude-Code-Session-Id: <current pi session id>
```

Header names are case-insensitive; the extension writes `user-agent` in lowercase so it reliably overrides pi's built-in Anthropic OAuth header key.

The Claude Code version is resolved on extension load from:

```text
https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest
```

If npm is unavailable or the request times out, it falls back to the bundled version `2.1.170`.

For tests or pinned deployments, override it with:

```bash
PI_CLAUDE_CODE_VERSION=2.1.170
```

The fetch timeout defaults to 1500 ms and can be adjusted with:

```bash
PI_CLAUDE_CODE_VERSION_FETCH_TIMEOUT_MS=3000
```

## Bearer auth header

For every `anthropic-messages` provider this extension manages that has a resolvable API key, the extension sets `authHeader: true` when re-registering the provider. pi's model registry turns that into an outgoing request header:

```text
Authorization: Bearer <resolved apiKey>
```

This is **additive**: pi still passes the same API key to the Anthropic SDK, which continues to send `x-api-key: <key>`. Both headers travel together, so the request keeps `x-api-key` authentication while also presenting a `Bearer` token — useful for Anthropic-compatible proxies that authenticate via `Authorization: Bearer`.

The bearer header is forced for *all* `anthropic-messages` providers the extension touches when an API key is available. When no API key can be resolved (for example, a provider relying on header-only auth), the extension does not force `authHeader`, so pi does not raise `No API key found`.

The value used is the provider's resolved API key, obtained through the same `apiKey`/`authHeader`/`headers` preservation mechanism described under [Provider auth preservation](#provider-auth-preservation).

## Tool-name adaptation

Outgoing Anthropic request payloads are rewritten with two rules:

```text
# pi native tools
read              -> Read
bash              -> Bash
edit              -> Edit
write             -> Write
grep              -> Grep
find              -> Find
ls                -> Ls

# extension / MCP-like tools
ask_user_question -> mcp__ask_user_question
init_experiment   -> mcp__init_experiment
```

The pi native tool set is exactly:

```text
read, bash, edit, write, grep, find, ls
```

The extension rewrites:

- `tools[].name`
- `tool_choice.name`
- historical Anthropic `messages[].content[]` blocks with `type: "tool_use"`

When the model responds with rewritten tool calls, the extension rewrites them back during `message_update` before pi creates TUI tool-rendering components, and again during `message_end` before pi dispatches tools:

```text
Read                    -> read
mcp__ask_user_question  -> ask_user_question
mcp__init_experiment    -> init_experiment
```

This keeps upstream Claude Code-style traffic while ensuring pi still executes the original pi tool names.

## Thinking adaptation

For every `anthropic-messages` request, the extension replaces pi's default thinking payload:

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 16384,
    "display": "summarized"
  }
}
```

with a dynamic effort derived from the user's currently selected pi thinking level:

```json
{
  "thinking": {
    "type": "adaptive"
  },
  "output_config": {
    "effort": "<selected effort>"
  }
}
```

The mapping is:

```text
off     -> low
minimal -> low
low     -> low
medium  -> medium
high    -> high
xhigh   -> xhigh
```

## Provider auth preservation

pi's runtime `registerProvider({ headers })` replaces the provider request config rather than merging it. To avoid breaking custom providers such as `guda-anthropic`, this extension reads the current provider request config and re-registers headers together with the existing `apiKey` and `authHeader` values. In addition, when an API key is resolvable the extension forces `authHeader: true` so pi adds the [`Authorization: Bearer`](#bearer-auth-header) header (see above).

Only models with `api === "anthropic-messages"` are affected. Other providers are skipped.

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

The test loads the TypeScript extension through `jiti`, verifies random `device_id` creation, checks `metadata.user_id` injection, verifies Claude Code headers, auth preservation, and forced `Authorization: Bearer` header registration, checks bidirectional tool-name mapping, and skips non-`anthropic-messages` models.
