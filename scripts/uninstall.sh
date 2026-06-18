#!/usr/bin/env bash
set -euo pipefail

REPO_DEFAULT="MoziaVerse/openviking-plugins"
REF_DEFAULT="main"

REPO="${OPENVIKING_PLUGINS_REPO:-$REPO_DEFAULT}"
REF="${OPENVIKING_PLUGINS_REF:-$REF_DEFAULT}"
TARGET="${1:-}"

usage() {
  cat <<EOF
OpenViking 插件卸载器

用法：
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/uninstall.sh) claude
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/uninstall.sh) codex
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/uninstall.sh) opencode
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/uninstall.sh) all

目标：
  claude     卸载 Claude Code 记忆插件。
  codex      卸载 Codex 记忆插件。
  opencode   卸载 OpenCode 记忆插件。
  all        卸载全部插件。

常用选项：
  --dry-run      只打印计划执行的操作，不实际修改。
  --remove-repo  同时删除 ~/.openviking/openviking-plugins-repo。

环境变量：
  OPENVIKING_PLUGINS_REPO                    GitHub 仓库，默认：${REPO_DEFAULT}
  OPENVIKING_PLUGINS_REF                     Git 引用，默认：main
  OPENVIKING_PLUGINS_CLAUDE_UNINSTALL_URL    Claude Code 卸载脚本直连 URL
  OPENVIKING_PLUGINS_CODEX_UNINSTALL_URL     Codex 卸载脚本直连 URL
  OPENVIKING_PLUGINS_OPENCODE_UNINSTALL_URL  OpenCode 卸载脚本直连 URL

不会删除 ~/.openviking/ovcli.conf，也不会删除 OpenViking 服务端数据。
目标后面的额外参数会继续传给对应插件的卸载脚本。
EOF
}

if [[ "$TARGET" == "-h" || "$TARGET" == "--help" || -z "$TARGET" ]]; then
  usage
  exit 0
fi

shift || true

info() {
  printf '[openviking-plugins] %s\n' "$*"
}

die() {
  printf '[openviking-plugins] 错误：%s\n' "$*" >&2
  exit 1
}

download_uninstaller() {
  local url="$1"
  local dest="$2"
  curl -fsSL "$url" -o "$dest"
}

run_uninstaller() {
  local name="$1"
  local default_url="$2"
  local url="$default_url"
  local tmp
  shift 2

  case "$name" in
    claude)
      url="${OPENVIKING_PLUGINS_CLAUDE_UNINSTALL_URL:-$default_url}"
      ;;
    codex)
      url="${OPENVIKING_PLUGINS_CODEX_UNINSTALL_URL:-$default_url}"
      ;;
    opencode)
      url="${OPENVIKING_PLUGINS_OPENCODE_UNINSTALL_URL:-$default_url}"
      ;;
  esac

  tmp="$(mktemp)"
  trap 'rm -f "'"$tmp"'"' RETURN
  info "正在卸载 $name"
  info "  $url"
  download_uninstaller "$url" "$tmp"
  bash "$tmp" "$@"
  rm -f "$tmp"
  trap - RETURN
}

CLAUDE_URL="https://raw.githubusercontent.com/${REPO}/${REF}/claude/setup-helper/uninstall.sh"
CODEX_URL="https://raw.githubusercontent.com/${REPO}/${REF}/codex/setup-helper/uninstall.sh"
OPENCODE_URL="https://raw.githubusercontent.com/${REPO}/${REF}/opencode/setup-helper/uninstall.sh"

case "$TARGET" in
  claude)
    run_uninstaller claude "$CLAUDE_URL" "$@"
    ;;
  codex)
    run_uninstaller codex "$CODEX_URL" "$@"
    ;;
  opencode)
    run_uninstaller opencode "$OPENCODE_URL" "$@"
    ;;
  all)
    run_uninstaller claude "$CLAUDE_URL" "$@"
    run_uninstaller codex "$CODEX_URL" "$@"
    run_uninstaller opencode "$OPENCODE_URL" "$@"
    ;;
  *)
    die "未知卸载目标：$TARGET"
    ;;
esac
