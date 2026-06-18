# OpenViking Codex 记忆插件

本目录基于官方 `examples/codex-memory-plugin` 复制，并做公司内部定制。

主要定制：

- OpenViking session id 从官方 `cx-<codex-session-id>` 改为 `<user>-codex-<codex-session-id>`。
- 默认安装源改为 `MoziaVerse/openviking-plugins`。
- 支持私有仓库安装时通过 `GITHUB_TOKEN` / `GH_TOKEN` 读取源码。

## 安装

推荐从仓库根目录统一入口安装：

```bash
export GITHUB_TOKEN="$(gh auth token)"
bash <(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/scripts/install.sh) codex
```

也可以直接运行 Codex installer：

```bash
export GITHUB_TOKEN="$(gh auth token)"
bash <(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/codex/setup-helper/install.sh)
```

安装完成后，按提示 `source ~/.zshrc` 或新开终端，然后启动：

```bash
codex
```

首次启动时如果提示 hooks 需要审批，请在 Codex 内输入 `/hooks` 完成审批。

## 工作原理

核心 hook：

- `UserPromptSubmit`：用户输入前搜索 OpenViking 并注入 `<openviking-context>`。
- `Stop`：每轮回复结束后，把新增 user/assistant turns 追加到 OpenViking session。
- `PreCompact`：上下文压缩前提交 OpenViking session，触发记忆抽取。
- `SessionStart`：新建、清空、恢复 session 时处理孤儿 session 回收和历史摘要注入。

Codex 插件还会配置 OpenViking `/mcp`，让模型可以主动使用 `search`、`store`、`read`、`list`、`forget` 等工具。

## Session 命名

新建的 OpenViking session 使用：

```text
<user>-codex-<codex-session-id>
```

例如：

```text
user01-codex-ses_xxx
```

`<user>` 来自 Codex wrapper 注入的 `OPENVIKING_USER`，通常由 `~/.openviking/ovcli.conf` 解析得到。若没有 user，则回退到 `OPENVIKING_ACCOUNT`，再回退到 `codex`。

已有官方 `cx-...` session 不会自动改名。已经存在于本地 state file 的旧 session 会继续使用旧 id，避免未提交内容被孤立；新的 Codex session 会使用新命名。

## 配置

优先使用当前用户自己的 USER API Key。不要把 root/admin key 配到日常 Codex。

常用配置文件：

```text
~/.openviking/ovcli.conf
```

示例：

```json
{
  "url": "http://your-openviking-server:1933",
  "api_key": "your-user-api-key",
  "account": "your-account",
  "user": "your-user-id",
  "agent_id": "default"
}
```

服务器地址和 API key 必须对应同一套 OpenViking 服务。

## 调试

启动前设置：

```bash
export OPENVIKING_DEBUG=1
```

日志位置：

```text
~/.openviking/logs/codex-hooks.log
```

## 上游来源

上游目录：

```text
volcengine/OpenViking/examples/codex-memory-plugin
```

同步上游时，请保留本仓库的 session 命名定制和安装源定制。
