# OpenViking OpenCode 记忆插件

本插件为 [OpenCode](https://opencode.ai/) 提供对齐 Codex OpenViking memory plugin 的跨会话记忆能力。安装后，OpenCode 会在用户消息进入模型前自动召回相关记忆，在每轮对话结束后写入当前 session，并在上下文压缩前提交给 OpenViking 记忆抽取器。

源码：[MoziaVerse/openviking-opencode-plugins](https://github.com/MoziaVerse/openviking-opencode-plugins)

## 安装

公开仓库或可直接访问 GitHub raw 时：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-opencode-plugins/main/scripts/install.sh)
```

如果仓库是私有仓库，先准备有仓库读取权限的 GitHub token：

```bash
export GITHUB_TOKEN="$(gh auth token)"
bash <(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/MoziaVerse/openviking-opencode-plugins/main/scripts/install.sh)
```

脚本会把插件安装到：

```text
~/.config/opencode/plugins/openviking-memory.ts
```

安装过程是幂等的。目标文件已存在且内容不同的时候，脚本会先生成 `.bak.<时间戳>` 备份再覆盖。

## 配置

推荐使用当前用户自己的 OpenViking USER API Key，不要把 root/admin key 配到日常 OpenCode 客户端。

插件读取配置的优先级如下：

1. 环境变量：`OPENVIKING_URL`、`OPENVIKING_API_KEY`、`OPENVIKING_ACCOUNT`、`OPENVIKING_USER`
2. OpenViking CLI 配置：`~/.openviking/ovcli.conf`
3. 可选插件配置：`~/.config/opencode/plugins/openviking-config.json`
4. 默认地址：`http://127.0.0.1:1933`

服务器地址和 API key 必须对应同一套 OpenViking 服务，避免插件写入到错误服务器。

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

也可以在安装时用环境变量创建 `ovcli.conf`：

```bash
export GITHUB_TOKEN="$(gh auth token)"
OPENVIKING_OPENCODE_WRITE_OVCLI=1 \
OPENVIKING_URL="http://your-openviking-server:1933" \
OPENVIKING_API_KEY="your-user-api-key" \
OPENVIKING_ACCOUNT="your-account" \
OPENVIKING_USER="your-user-id" \
bash <(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/MoziaVerse/openviking-opencode-plugins/main/scripts/install.sh)
```

已有 `ovcli.conf` 时，写入模式会先备份旧文件。

## 验证

确认 OpenViking 服务可达：

```bash
curl "$(jq -r '.url' ~/.openviking/ovcli.conf)/health"
```

启动 OpenCode：

```bash
opencode
```

设置调试日志：

```bash
OPENVIKING_DEBUG=1 opencode
```

日志会写入：

```text
~/.openviking/logs/opencode-hooks.log
```

## 工作原理

| Codex 插件能力 | OpenCode 实现 |
| --- | --- |
| `UserPromptSubmit` 自动召回 | `chat.message` |
| `Stop` 回合结束增量捕获 | `session.idle` |
| `PreCompact` 压缩前提交 | `experimental.session.compacting` |
| MCP 手动读写 | 单独配置 OpenViking MCP |

OpenViking session 命名规则：

```text
<user>-opencode-<opencode-session-id>
```

例如 OpenCode session `ses_xxx` 会写入：

```text
viking://user/<user>/sessions/<user>-opencode-ses_xxx
```

本插件只保留对齐 Codex 的核心 hook 行为：

- 不使用 `message.updated` / `message.part.updated` 高频写入
- 不提供 `openviking_*` 或 `mem*` 工具
- 不注入 `shell.env`
- 不做定时 commit

手动搜索、读写、删除、资源管理等能力请单独配置 OpenViking MCP。

## 手动安装

本地开发或不使用 curl 时：

```bash
git clone https://github.com/MoziaVerse/openviking-opencode-plugins.git
cd openviking-opencode-plugins
npm install
npm run typecheck
npm run install:local
```

卸载 curl 安装的插件：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-opencode-plugins/main/scripts/install.sh) --uninstall
```

私有仓库同样需要带 `GITHUB_TOKEN`。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `OPENVIKING_URL` / `OPENVIKING_BASE_URL` | OpenViking 服务地址 |
| `OPENVIKING_API_KEY` / `OPENVIKING_BEARER_TOKEN` | 当前用户的 USER API Key |
| `OPENVIKING_ACCOUNT` | OpenViking account |
| `OPENVIKING_USER` | 当前用户 ID |
| `OPENVIKING_CLI_CONFIG_FILE` | 指定 `ovcli.conf` 路径 |
| `OPENVIKING_AUTO_RECALL` | 是否启用自动召回，默认启用 |
| `OPENVIKING_RECALL_LIMIT` | 自动召回条数，默认 `6` |
| `OPENVIKING_SCORE_THRESHOLD` | 召回分数阈值，默认 `0.35` |
| `OPENVIKING_CAPTURE_ASSISTANT_TURNS` | 是否记录 assistant 回复，默认启用 |
| `OPENVIKING_CAPTURE_MAX_LENGTH` | 单次捕获最大长度，默认 `24000` |
| `OPENVIKING_AUTO_COMMIT_ON_COMPACT` | 压缩前是否提交，默认启用 |
| `OPENVIKING_DEBUG` | 是否写调试日志 |

## 故障排查

| 现象 | 可能原因 | 处理方式 |
| --- | --- | --- |
| OpenViking 中没有 session | 插件未安装到 OpenCode 全局插件目录 | 检查 `~/.config/opencode/plugins/openviking-memory.ts` |
| Hook 报 401 | API key 和服务器地址不匹配，或使用了错误用户 key | 检查 `~/.openviking/ovcli.conf` |
| 写入到 localhost | 未配置真实服务器地址 | 设置 `OPENVIKING_URL` 或修改 `ovcli.conf` |
| `curl` 安装报 404 | 私有仓库未带 token，或 token 无权限 | 使用 `GITHUB_TOKEN` / `GH_TOKEN` |
| OpenCode 没有加载插件 | 使用了异常的 OpenCode 二进制或版本过旧 | 确认 `opencode --version` 能正常输出 |
