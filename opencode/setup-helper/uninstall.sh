#!/usr/bin/env bash
set -euo pipefail

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
PLUGIN_DIR="${OPENVIKING_OPENCODE_PLUGIN_DIR:-$CONFIG_HOME/opencode/plugins}"
PLUGIN_NAME="openviking-memory.ts"
DRY_RUN=0

usage() {
  cat <<EOF
OpenViking OpenCode 插件卸载器

用法：
  bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/opencode/setup-helper/uninstall.sh)

选项：
  --dry-run      只打印计划执行的操作，不实际修改。
  -h, --help     显示帮助。

环境变量：
  OPENVIKING_OPENCODE_PLUGIN_DIR    插件目录，默认：~/.config/opencode/plugins

不会删除 ~/.openviking/ovcli.conf，也不会删除 OpenViking 服务端数据。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知选项：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

info() {
  printf '[openviking-opencode] %s\n' "$*"
}

target="$PLUGIN_DIR/$PLUGIN_NAME"
if [[ "$DRY_RUN" == "1" ]]; then
  info "将删除插件文件：$target"
else
  rm -f "$target"
  info "已删除插件文件：$target"
fi

info "卸载完成。未删除 OpenViking 配置和服务端数据。"
