# OpenViking OpenCode Memory Plugin

Codex-aligned OpenViking memory integration for OpenCode.

The primary documentation is maintained in Chinese: [README_CN.md](./README_CN.md).

## Quick Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-opencode-plugins/main/scripts/install.sh)
```

For a private GitHub repository:

```bash
export GITHUB_TOKEN="$(gh auth token)"
bash <(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/MoziaVerse/openviking-opencode-plugins/main/scripts/install.sh)
```

The installer copies `openviking-memory.ts` to:

```text
~/.config/opencode/plugins/openviking-memory.ts
```

## Configuration

Resolution order:

1. Environment variables: `OPENVIKING_URL`, `OPENVIKING_API_KEY`, `OPENVIKING_ACCOUNT`, `OPENVIKING_USER`
2. `~/.openviking/ovcli.conf`
3. Optional `~/.config/opencode/plugins/openviking-config.json`
4. Built-in default `http://127.0.0.1:1933`

Use each employee's own USER API Key. Do not configure root/admin keys in daily OpenCode clients.

## Behavior

- `chat.message`: auto-recall, matching Codex `UserPromptSubmit`.
- `session.idle`: completed turn capture, matching Codex `Stop`.
- `experimental.session.compacting`: catch up and commit, matching Codex `PreCompact`.
- OpenViking session id: `<user>-opencode-<opencode-session-id>`.

The plugin intentionally does not expose custom `openviking_*` or `mem*` tools. Manual memory operations should come from the OpenViking MCP integration.
