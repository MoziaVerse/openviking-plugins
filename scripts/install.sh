#!/usr/bin/env bash
set -euo pipefail

REPO_DEFAULT="MoziaVerse/openviking-plugins"
REF_DEFAULT="main"

REPO="${OPENVIKING_PLUGINS_REPO:-$REPO_DEFAULT}"
REF="${OPENVIKING_PLUGINS_REF:-$REF_DEFAULT}"
TARGET="${1:-}"

usage() {
  cat <<EOF
OpenViking 插件安装器

用法：
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/install.sh) claude
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/install.sh) codex
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/install.sh) opencode
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/install.sh) all

目标：
  claude     安装 Claude Code 记忆插件。
  codex      安装 Codex 记忆插件。
  opencode   安装 OpenCode 记忆插件。
  all        安装全部插件。

环境变量：
  OPENVIKING_PLUGINS_REPO                  GitHub 仓库，默认：${REPO_DEFAULT}
  OPENVIKING_PLUGINS_REF                   Git 引用，默认：main
  OPENVIKING_PLUGINS_CLAUDE_INSTALL_URL    Claude Code 安装脚本直连 URL
  OPENVIKING_PLUGINS_CODEX_INSTALL_URL     Codex 安装脚本直连 URL
  OPENVIKING_PLUGINS_OPENCODE_INSTALL_URL  OpenCode 安装脚本直连 URL

目标后面的额外参数会继续传给对应插件的安装脚本。
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

download_installer() {
  local url="$1"
  local dest="$2"
  curl -fsSL "$url" -o "$dest"
}

run_installer() {
  local name="$1"
  local default_url="$2"
  local url="$default_url"
  local tmp
  shift 2

  case "$name" in
    claude)
      url="${OPENVIKING_PLUGINS_CLAUDE_INSTALL_URL:-$default_url}"
      ;;
    codex)
      url="${OPENVIKING_PLUGINS_CODEX_INSTALL_URL:-$default_url}"
      ;;
    opencode)
      url="${OPENVIKING_PLUGINS_OPENCODE_INSTALL_URL:-$default_url}"
      ;;
  esac

  tmp="$(mktemp)"
  trap 'rm -f "'"$tmp"'"' RETURN
  info "正在安装 $name"
  info "  $url"
  download_installer "$url" "$tmp"
  bash "$tmp" "$@"
  rm -f "$tmp"
  trap - RETURN
}

CLAUDE_URL="https://raw.githubusercontent.com/${REPO}/${REF}/claude/setup-helper/install.sh"
CODEX_URL="https://raw.githubusercontent.com/${REPO}/${REF}/codex/setup-helper/install.sh"
OPENCODE_URL="https://raw.githubusercontent.com/${REPO}/${REF}/opencode/setup-helper/install.sh"

case "$TARGET" in
  claude)
    run_installer claude "$CLAUDE_URL" "$@"
    ;;
  codex)
    run_installer codex "$CODEX_URL" "$@"
    ;;
  opencode)
    run_installer opencode "$OPENCODE_URL" "$@"
    ;;
  all)
    run_installer claude "$CLAUDE_URL" "$@"
    run_installer codex "$CODEX_URL" "$@"
    run_installer opencode "$OPENCODE_URL" "$@"
    ;;
  *)
    die "未知安装目标：$TARGET"
    ;;
esac
