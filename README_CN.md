# OpenViking OpenCode Memory Plugin

在 OpenCode 中对齐 Codex OpenViking memory plugin 的核心 hook 行为：自动召回、回合结束记录、压缩前提交。

## 功能

- `chat.message`：对标 Codex `UserPromptSubmit`，用户消息进入模型前检索 OpenViking，并注入 `<openviking-context>` 上下文。
- `session.idle`：对标 Codex `Stop`，回合结束后从 OpenCode session 读取完整 user/assistant 文本，增量写入 OpenViking session。
- `experimental.session.compacting`：对标 Codex `PreCompact`，压缩前补抓消息并提交 OpenViking session。
- 确定性 session 命名：OpenCode session `abc` 对应 OpenViking session `oc-abc`。

本插件不再实现 `message.updated` / `message.part.updated` 写入，不提供 `openviking_*` 或 `mem*` 工具，不做定时 commit，也不注入 `shell.env`。手动读写请单独配置 OpenViking MCP。

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

## 配置优先级

从高到低：

1. 环境变量：`OPENVIKING_URL`、`OPENVIKING_API_KEY`、`OPENVIKING_ACCOUNT`、`OPENVIKING_USER`
2. OpenViking CLI 配置：`~/.openviking/ovcli.conf`
3. 可选插件配置：`~/.config/opencode/plugins/openviking-config.json`
4. 默认值：`http://127.0.0.1:1933`

推荐把真实 key 放在 `~/.openviking/ovcli.conf` 或环境变量里，不要提交到 git。服务器地址和 API key 必须对应同一个 OpenViking 服务。安装脚本不会自动创建默认配置，避免默认 localhost 覆盖当前 ovcli 配置。

## 配置示例

```json
{
  "endpoint": "http://localhost:1933",
  "apiKey": "",
  "account": "default",
  "user": "opencode",
  "timeoutMs": 15000,
  "captureTimeoutMs": 30000,
  "autoRecall": {
    "enabled": true,
    "limit": 6,
    "scoreThreshold": 0.35
  },
  "captureAssistantTurns": true,
  "captureMaxLength": 24000,
  "autoCommitOnCompact": true,
  "debug": false
}
```

## 对齐 Codex 插件

| Codex 插件能力 | OpenCode 实现 |
| --- | --- |
| `UserPromptSubmit` 自动召回 | `chat.message` |
| `Stop` 回合结束增量捕获 | `session.idle` |
| `PreCompact` 压缩前提交 | `experimental.session.compacting` |
| MCP 手动读写 | 单独配置 OpenViking MCP |

OpenCode 没有 Codex 完全同名的 `SessionStart(source=startup|clear|resume)`，所以这个插件不实现额外的 SessionStart 启发式回收，避免偏离 Codex 的核心 hook 行为。

## 运行时文件

插件运行后会写入：

```text
~/.openviking/opencode-plugin-state/
```

设置 `OPENVIKING_DEBUG=1` 后，会写入调试日志：

```text
~/.openviking/logs/opencode-hooks.log
```
