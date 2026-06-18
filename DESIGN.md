# Design

## Goal

Replicate the Codex OpenViking memory plugin behavior in OpenCode using OpenCode's plugin hooks.

## Hook Mapping

| Codex plugin | Purpose | OpenCode implementation |
| --- | --- | --- |
| `SessionStart(startup|clear)` | Commit likely orphaned previous session | Local session map plus auto-commit timer, `session.deleted`, `session.error`, `dispose` |
| `UserPromptSubmit` | Search memories and inject context | `chat.message` mutates `output.parts` with a synthetic `<relevant-memories>` text part |
| `Stop` | Append latest user/assistant turns without committing | `message.updated`, `message.part.updated`, and `session.idle` SDK catch-up |
| `PreCompact` | Catch up transcript and commit before compaction | `experimental.session.compacting` |
| MCP `/mcp` tools | Manual read/write/search/delete/resource tools | Prefixed custom tools: `openviking_*` |
| Shell wrapper env | Supply URL/API key/account/user/agent | `shell.env` |

## Session IDs

The OpenViking session id is deterministic. Default template:

```text
{user}-{tool}-{session}
```

For OpenCode this becomes:

```text
<user>-opencode-<opencode-session-id>
```

Supported placeholders:

- `{account}`
- `{user}`
- `{tool}`
- `{agent}`
- `{session}`

## Known Differences

OpenCode does not expose the exact Codex `SessionStart` source values (`startup`, `resume`, `clear`). The plugin therefore cannot perfectly reproduce Codex's active-window heuristic. It uses OpenCode lifecycle events and a persisted session map instead.

OpenCode plugin tools are prefixed as `openviking_*` to avoid shadowing built-in tools such as `read`.
