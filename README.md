# OpenViking OpenCode Memory Plugin

Codex-aligned OpenViking memory integration for OpenCode.

See [README_CN.md](./README_CN.md) for the primary Chinese documentation.

## What It Does

- Auto-recalls relevant memories on `chat.message`, matching Codex `UserPromptSubmit`.
- Captures completed user/assistant turns only on `session.idle`, matching Codex `Stop`.
- Commits the OpenViking session before OpenCode compaction via `experimental.session.compacting`, matching Codex `PreCompact`.
- Uses deterministic OpenViking session ids: `<user>-opencode-<opencode-session-id>`.

It intentionally does not expose custom `openviking_*` or `mem*` tools. Manual read/write/search/delete/resource operations should come from the OpenViking MCP integration.

## Install

```bash
npm install
npm run typecheck
npm run install:local
```

The install script copies `openviking-memory.ts` to `~/.config/opencode/plugins/`.

## Configuration

Resolution order:

1. Environment variables: `OPENVIKING_URL`, `OPENVIKING_API_KEY`, `OPENVIKING_ACCOUNT`, `OPENVIKING_USER`
2. `~/.openviking/ovcli.conf`
3. Optional `~/.config/opencode/plugins/openviking-config.json`
4. Built-in default `http://127.0.0.1:1933`

Do not commit real API keys.
