# Claude Code OpenViking 插件

这是基于官方 `examples/claude-code-memory-plugin` 复制出来的定制版，功能保持官方 Claude Code 插件行为，只调整仓库来源、安装入口和 OpenViking session 命名。

## 安装

推荐使用仓库统一入口：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/scripts/install.sh) claude
```

也可以只运行 Claude Code 插件安装脚本：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/claude/setup-helper/install.sh)
```

安装后按提示执行：

```bash
source ~/.zshrc
```

然后进入 Claude Code，用 `/plugins`、`/mcp` 和 `/openviking-memory:ov` 检查插件状态。

## Session 命名

本定制版使用：

```text
<user>-claude-<claude-session-id>
<user>-claude-<claude-session-id>__<agent-id>
```

`<user>` 优先来自 `OPENVIKING_USER`，否则读取 `~/.openviking/ovcli.conf` 中的 `user` 字段。旧官方插件产生的 `cc-...` session 不会自动重命名。

## 功能

核心 hook：

- `UserPromptSubmit`：自动召回 OpenViking 记忆并注入上下文。
- `Stop`：每轮回复结束后增量写入 OpenViking session。
- `PreCompact`：上下文压缩前提交 session。
- `SessionStart`：会话启动时注入 profile / archive，并回放 pending queue。
- `SessionEnd`：会话结束时提交 session。
- `SubagentStart` / `SubagentStop`：为 Claude subagent 创建独立 OpenViking session 并写入。

附加能力：

- 配置 OpenViking `/mcp`，支持手动搜索、读取和写入。
- 提供 `/openviking-memory:ov` 命令。
- 可选 statusline，用于显示 OpenViking 状态。

## 配置规范

只使用当前员工自己的 USER API Key，不要把 root/admin key 配到日常 Claude Code 客户端。

服务器地址和 API key 必须对应同一套 OpenViking 服务：

```json
{
  "url": "http://your-openviking-server:1933",
  "api_key": "your-user-api-key",
  "account": "your-account",
  "user": "your-user-id"
}
```

配置文件默认位置：

```text
~/.openviking/ovcli.conf
```

调试日志：

```bash
OPENVIKING_DEBUG=1 claude
```

日志默认写入：

```text
~/.openviking/logs/cc-hooks.log
```
