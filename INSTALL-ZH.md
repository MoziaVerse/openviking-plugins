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
~/.config/opencode/plugins/openviking-config.json
```

已有 `openviking-config.json` 时不会覆盖。

推荐使用 `~/.openviking/ovcli.conf` 或环境变量提供真实配置：

```bash
export OPENVIKING_URL="http://your-openviking-server:1933"
export OPENVIKING_API_KEY="your-user-api-key"
export OPENVIKING_ACCOUNT="default"
export OPENVIKING_USER="your-user-id"
export OPENVIKING_AGENT_ID="opencode"
```

注意：服务器地址和 API key 必须属于同一个 OpenViking 服务。不要把 root/admin key 配到日常 OpenCode 客户端。

验证：

```bash
curl "$OPENVIKING_URL/health"
opencode
```

进入 OpenCode 后可以让模型调用：

- `openviking_health`
- `openviking_search`
- `openviking_commit`
