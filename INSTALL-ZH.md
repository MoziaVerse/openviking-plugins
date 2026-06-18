# 安装说明

```bash
cd ~/Documents/Github/openviking-opencode-plugins
npm install
npm run typecheck
npm run install:local
```

安装位置：

```text
~/.config/opencode/plugins/openviking-memory.ts
```

默认使用环境变量或 `~/.openviking/ovcli.conf`，安装脚本不会创建默认配置，避免覆盖当前服务器地址。

推荐使用 `~/.openviking/ovcli.conf` 或环境变量提供真实配置：

```bash
export OPENVIKING_URL="http://your-openviking-server:1933"
export OPENVIKING_API_KEY="your-user-api-key"
export OPENVIKING_ACCOUNT="default"
export OPENVIKING_USER="your-user-id"
```

注意：服务器地址和 API key 必须属于同一个 OpenViking 服务。不要把 root/admin key 配到日常 OpenCode 客户端。

验证：

```bash
curl "$OPENVIKING_URL/health"
opencode
```

插件只负责自动召回、`session.idle` 写入和压缩前提交。手动读写请单独配置 OpenViking MCP。
