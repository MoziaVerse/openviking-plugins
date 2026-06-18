# OpenViking OpenCode Memory Plugin

在 OpenCode 中复刻 Codex OpenViking memory plugin 的核心能力：自动召回、自动记录、压缩前提交、手动工具读写。

## 功能

- `chat.message`：每次用户提交消息时自动检索 OpenViking，并注入 `<relevant-memories>` 上下文。
- `message.updated` / `message.part.updated` / `session.idle`：增量捕获用户和 assistant 文本，写入 OpenViking session。
- `experimental.session.compacting`：OpenCode 压缩前补抓消息并提交 OpenViking session。
- 确定性 session 命名：默认 `{user}-opencode-{session}`，可改 `sessionIdTemplate`。
- `shell.env`：向 shell 工具注入 OpenViking 地址、API key、account、user、agent。
- `openviking_*` 工具：覆盖 Codex 插件通过 MCP 暴露的常用读写能力。
- 兼容旧工具：保留 `memsearch`、`memread`、`membrowse`、`memcommit`。

## 安装

```bash
cd ~/Documents/Github/openviking-opencode-plugins
npm install
npm run typecheck
npm run install:local
```

插件会安装到：

```text
~/.config/opencode/plugins/openviking-memory.ts
```

如果目标目录已有 `openviking-config.json`，安装脚本不会覆盖。

## 配置优先级

从高到低：

1. 环境变量：`OPENVIKING_URL`、`OPENVIKING_API_KEY`、`OPENVIKING_ACCOUNT`、`OPENVIKING_USER`、`OPENVIKING_AGENT_ID`
2. 插件配置：`~/.config/opencode/plugins/openviking-config.json`
3. OpenViking CLI 配置：`~/.openviking/ovcli.conf`
4. 默认值：`http://localhost:1933`

推荐把真实 key 放在 `~/.openviking/ovcli.conf` 或环境变量里，不要提交到 git。

## 配置示例

```json
{
  "endpoint": "http://localhost:1933",
  "apiKey": "",
  "account": "default",
  "user": "opencode",
  "agent": "opencode",
  "enabled": true,
  "timeoutMs": 30000,
  "sessionIdTemplate": "{user}-{tool}-{session}",
  "autoCommitOnCompact": true,
  "compactKeepRecentCount": 0,
  "autoCommit": {
    "enabled": true,
    "intervalMinutes": 10
  },
  "autoRecall": {
    "enabled": true,
    "limit": 6,
    "scoreThreshold": 0.15,
    "maxContentChars": 500,
    "preferAbstract": true,
    "tokenBudget": 2000
  }
}
```

## 工具

主要工具：

- `openviking_search`：带 session context 的深度检索。
- `openviking_find`：快速语义检索。
- `openviking_read`：读取一个或多个 `viking://` 文件。
- `openviking_list`：列目录。
- `openviking_grep`：正则搜索内容。
- `openviking_glob`：按 glob 找文件。
- `openviking_remember`：主动写入长期记忆。
- `openviking_commit`：提交当前 session 并触发记忆提取。
- `openviking_add_resource`：添加远程资源。
- `openviking_forget`：删除指定 `viking://` URI。
- `openviking_health`：检查服务健康。

兼容工具：

- `memsearch`
- `memread`
- `membrowse`
- `memcommit`

## 对齐 Codex 插件

| Codex 插件能力 | OpenCode 实现 |
| --- | --- |
| `UserPromptSubmit` 自动召回 | `chat.message` |
| `Stop` 增量捕获 | `message.*` 事件 + `session.idle` catch-up |
| `PreCompact` 提交 | `experimental.session.compacting` |
| MCP 手动读写 | `openviking_*` 自定义工具，或单独配置 OpenCode MCP |
| wrapper 注入环境变量 | `shell.env` |

OpenCode 没有 Codex 完全同名的 `SessionStart(source=startup|clear|resume)`，所以静默退出后的兜底主要靠本地 session map、自动 commit 轮询、`session.deleted`、`session.error` 和 `dispose`。

## 运行时文件

插件运行后会在插件文件旁边生成：

- `openviking-config.json`
- `openviking-memory.log`
- `openviking-session-map.json`

这些文件已在 `.gitignore` 中排除。
