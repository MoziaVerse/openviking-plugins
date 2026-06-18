# 安装说明

推荐使用 curl 一键安装：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/scripts/install.sh) opencode
```

插件会安装到：

```text
~/.config/opencode/plugins/openviking-memory.ts
```

配置优先级：

1. 环境变量：`OPENVIKING_URL`、`OPENVIKING_API_KEY`、`OPENVIKING_ACCOUNT`、`OPENVIKING_USER`
2. `~/.openviking/ovcli.conf`
3. `~/.config/opencode/plugins/openviking-config.json`
4. 默认地址：`http://127.0.0.1:1933`

注意：服务器地址和 API key 必须属于同一个 OpenViking 服务。不要把 root/admin key 配到日常 OpenCode 客户端。

本地开发安装：

```bash
npm install
npm run typecheck
npm run install:opencode:local
```

卸载：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/scripts/install.sh) opencode --uninstall
```
