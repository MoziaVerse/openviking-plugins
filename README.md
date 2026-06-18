# OpenViking Plugins

这是公司内部维护的 OpenViking Agent 插件仓库，统一存放 Codex 和 OpenCode 的 OpenViking 记忆插件。

当前包含：

- `codex/`：基于官方 Codex memory plugin 复制并定制。
- `opencode/`：OpenCode memory plugin，对齐 Codex 插件核心 hook 行为。
- `scripts/install.sh`：统一安装入口。

## 统一安装

仓库是私有仓库时，先准备 GitHub token：

```bash
export GITHUB_TOKEN="$(gh auth token)"
```

安装 Codex 插件：

```bash
bash <(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/scripts/install.sh) codex
```

安装 OpenCode 插件：

```bash
bash <(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/scripts/install.sh) opencode
```

两个都安装：

```bash
bash <(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/scripts/install.sh) all
```

如果仓库改成公开，可以去掉 `GITHUB_TOKEN` header。

## Session 命名

本仓库统一使用“用户 + 工具 + session id”的 OpenViking session 命名方式。

| 工具 | OpenViking session id |
| --- | --- |
| Codex | `<user>-codex-<codex-session-id>` |
| OpenCode | `<user>-opencode-<opencode-session-id>` |

`<user>` 来自 `OPENVIKING_USER` 或 `~/.openviking/ovcli.conf` 中的 `user` 字段。Codex 运行时由 wrapper 注入，OpenCode 插件直接读取配置。

## 配置规范

推荐使用当前员工自己的 OpenViking USER API Key，不要把 root/admin key 配到日常 AI 客户端。

配置优先级以各插件 installer 为准，默认都支持：

1. 环境变量：`OPENVIKING_URL`、`OPENVIKING_API_KEY`、`OPENVIKING_ACCOUNT`、`OPENVIKING_USER`
2. OpenViking CLI 配置：`~/.openviking/ovcli.conf`

服务器地址和 API key 必须对应同一套 OpenViking 服务，避免写入到错误服务器。

`~/.openviking/ovcli.conf` 示例：

```json
{
  "url": "http://your-openviking-server:1933",
  "api_key": "your-user-api-key",
  "account": "your-account",
  "user": "your-user-id",
  "agent_id": "default"
}
```

## 插件说明

### Codex

路径：[codex/](./codex/)

核心 hook：

- `UserPromptSubmit`：自动召回 OpenViking 记忆并注入上下文。
- `Stop`：每轮回复结束后增量写入 OpenViking session。
- `PreCompact`：上下文压缩前提交 session。
- `SessionStart`：处理启动、清空、恢复时的上下文衔接和孤儿 session 回收。

Codex 插件还会配置 OpenViking `/mcp`，用于手动搜索、读取、写入和删除记忆。

### OpenCode

路径：[opencode/](./opencode/)

核心 hook：

- `chat.message`：对标 Codex `UserPromptSubmit`，自动召回并注入上下文。
- `session.idle`：对标 Codex `Stop`，回合结束后增量写入。
- `experimental.session.compacting`：对标 Codex `PreCompact`，压缩前提交。

OpenCode 插件不额外提供 `openviking_*` 或 `mem*` 工具。手动读写请单独配置 OpenViking MCP。

## 本地开发

安装依赖：

```bash
npm install
```

检查 OpenCode 插件类型：

```bash
npm run typecheck
```

本地安装 OpenCode 插件：

```bash
npm run install:opencode:local
```

运行 OpenCode mock 验证：

```bash
npm run smoke:opencode:docker
```

## 目录结构

```text
openviking-plugins/
├── codex/
├── opencode/
├── scripts/
│   └── install.sh
├── package.json
└── README.md
```
