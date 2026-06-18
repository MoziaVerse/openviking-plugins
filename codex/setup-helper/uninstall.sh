#!/usr/bin/env bash
set -euo pipefail

OV_HOME="${OPENVIKING_HOME:-$HOME/.openviking}"
REPO_DIR="${OPENVIKING_REPO_DIR:-$OV_HOME/openviking-plugins-repo}"
MARKETPLACE_NAME="${OPENVIKING_CODEX_MARKETPLACE_NAME:-openviking-plugins-local}"
MARKETPLACE_ROOT="${OPENVIKING_CODEX_MARKETPLACE_ROOT:-$HOME/.codex/${MARKETPLACE_NAME}-marketplace}"
PLUGIN_NAME="openviking-memory"
PLUGIN_ID="${PLUGIN_NAME}@${MARKETPLACE_NAME}"
CODEX_CONFIG="${CODEX_CONFIG_FILE:-$HOME/.codex/config.toml}"
WRAPPER_MARKER_BEGIN="# >>> openviking-codex-plugin >>>"
WRAPPER_MARKER_END="# <<< openviking-codex-plugin <<<"

DRY_RUN=0
REMOVE_REPO=0

usage() {
  cat <<EOF
OpenViking Codex 插件卸载器

用法：
  bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/codex/setup-helper/uninstall.sh)

选项：
  --dry-run      只打印计划执行的操作，不实际修改。
  --remove-repo  同时删除 ~/.openviking/openviking-plugins-repo。
  -h, --help     显示帮助。

不会删除 ~/.openviking/ovcli.conf，也不会删除 OpenViking 服务端数据。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --remove-repo)
      REMOVE_REPO=1
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

if [ -t 1 ]; then
  GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RESET=$'\033[0m'
else
  GREEN=''; YELLOW=''; RESET=''
fi
info() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!!%s  %s\n' "$YELLOW" "$RESET" "$*" >&2; }

run_or_print() {
  if [[ "$DRY_RUN" == "1" ]]; then
    info "将执行：$*"
  else
    "$@" || true
  fi
}

strip_marker_block() {
  local file="$1" begin="$2" end="$3"
  [ -f "$file" ] || return 0
  if ! grep -qF "$begin" "$file"; then
    return 0
  fi
  if ! grep -qF "$end" "$file"; then
    warn "$file 中存在开始标记但缺少结束标记，跳过自动修改。"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    info "将从 $file 移除 OpenViking 加载片段"
    return 0
  fi
  awk -v b="$begin" -v e="$end" '
    $0 == b {skip=1; next}
    $0 == e {skip=0; next}
    !skip
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  info "已从 $file 移除 OpenViking 加载片段"
}

remove_codex_config_block() {
  [ -f "$CODEX_CONFIG" ] || return 0
  if [[ "$DRY_RUN" == "1" ]]; then
    info "将从 $CODEX_CONFIG 移除插件启用配置（如存在）"
    return 0
  fi
  node - "$CODEX_CONFIG" "$PLUGIN_ID" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const pluginId = process.argv[3];
let text = "";
try { text = fs.readFileSync(file, "utf8"); } catch { process.exit(0); }
const lines = text.split(/\n/);
const header = `[plugins."${pluginId}"]`;
const out = [];
let skip = false;
for (const line of lines) {
  if (line.trim() === header) {
    skip = true;
    continue;
  }
  if (skip && /^\s*\[/.test(line)) {
    skip = false;
  }
  if (!skip) out.push(line);
}
fs.writeFileSync(file, out.join("\n").replace(/\n*$/, "\n"));
NODE
  info "已清理 $CODEX_CONFIG 中的插件启用配置"
}

if command -v codex >/dev/null 2>&1; then
  run_or_print codex plugin remove "$PLUGIN_ID"
  run_or_print codex plugin marketplace remove "$MARKETPLACE_NAME"
else
  warn "未找到 codex CLI，跳过 CLI 卸载步骤。"
fi

remove_codex_config_block

if [[ "$DRY_RUN" == "1" ]]; then
  info "将删除插件市场目录：$MARKETPLACE_ROOT"
  info "将删除插件缓存目录：$HOME/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME"
else
  rm -rf "$MARKETPLACE_ROOT" "$HOME/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME"
  info "已删除插件市场目录和插件缓存"
fi

strip_marker_block "$HOME/.zshrc" "$WRAPPER_MARKER_BEGIN" "$WRAPPER_MARKER_END"
strip_marker_block "$HOME/.bashrc" "$WRAPPER_MARKER_BEGIN" "$WRAPPER_MARKER_END"

if [[ "$REMOVE_REPO" == "1" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    info "将删除源码目录：$REPO_DIR"
  else
    rm -rf "$REPO_DIR"
    info "已删除源码目录：$REPO_DIR"
  fi
else
  info "保留源码目录：$REPO_DIR"
fi

info "卸载完成。未删除 OpenViking 配置和服务端数据。"
