# Design

## Goal

Match the Codex OpenViking memory plugin's core behavior in OpenCode without extra local tools or background features.

## Hook Mapping

| Codex plugin | Purpose | OpenCode implementation |
| --- | --- | --- |
| `UserPromptSubmit` | Search memories and inject context | `chat.message` injects synthetic `<openviking-context>` text |
| `Stop` | Append completed turns without committing | `session.idle` fetches OpenCode messages and appends new user/assistant text |
| `PreCompact` | Catch up transcript and commit before compaction | `experimental.session.compacting` |
| MCP `/mcp` tools | Manual read/write/search/delete/resource tools | Configure OpenViking MCP separately |

## Removed Non-Codex Features

- No `message.updated` or `message.part.updated` writes.
- No custom `openviking_*` tools.
- No compatibility `mem*` tools.
- No interval auto-commit scheduler.
- No `session.deleted` or `session.error` commit behavior.
- No `shell.env` injection.
- No system prompt transform.

## Session IDs

The OpenViking session id is deterministic:

```text
<safe-user>-opencode-<safe-opencode-session-id>
```

This keeps the same deterministic-session idea as Codex while making Studio browsing easier by grouping sessions by user and tool.

## Known Difference

OpenCode does not expose Codex's exact `SessionStart(source=startup|clear|resume)` hook. This plugin does not implement a replacement heuristic, so session recovery after silent process exit should be handled by OpenViking MCP/CLI operations or a future explicit OpenCode hook if one becomes available.
