# OpenViking OpenCode Memory Plugin

Codex-style OpenViking memory integration for OpenCode.

See [README_CN.md](./README_CN.md) for the primary Chinese documentation.

## What It Does

- Auto-recalls relevant memories on `chat.message`.
- Captures user and assistant messages through `message.*` events plus `session.idle` catch-up.
- Commits the mapped OpenViking session before OpenCode compaction via `experimental.session.compacting`.
- Uses deterministic session ids, defaulting to `{user}-opencode-{session}`.
- Injects OpenViking connection environment through `shell.env`.
- Exposes `openviking_*` tools for manual search, read, store, list, grep, glob, forget, add-resource, health, and commit.

## Install

```bash
npm install
npm run typecheck
npm run install:local
```

The install script copies `openviking-memory.ts` to `~/.config/opencode/plugins/` and creates `openviking-config.json` only when it does not already exist.

## Configuration

Resolution order:

1. Environment variables: `OPENVIKING_URL`, `OPENVIKING_API_KEY`, `OPENVIKING_ACCOUNT`, `OPENVIKING_USER`, `OPENVIKING_AGENT_ID`
2. `~/.config/opencode/plugins/openviking-config.json`
3. `~/.openviking/ovcli.conf`
4. Built-in default `http://localhost:1933`

Do not commit real API keys.
