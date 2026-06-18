#!/usr/bin/env bash
set -euo pipefail

REPO_DEFAULT="MoziaVerse/openviking-plugins"
REF_DEFAULT="main"

REPO="${OPENVIKING_PLUGINS_REPO:-$REPO_DEFAULT}"
REF="${OPENVIKING_PLUGINS_REF:-$REF_DEFAULT}"
OV_HOME="${OPENVIKING_HOME:-$HOME/.openviking}"
REPO_DIR="${OPENVIKING_REPO_DIR:-$OV_HOME/openviking-plugins-repo}"
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
  OPENVIKING_REPO_DIR                      本地插件源码目录，默认：~/.openviking/openviking-plugins-repo

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

prepare_repo() {
  local repo_url="https://github.com/${REPO}.git"
  command -v git >/dev/null 2>&1 || die "未找到 git，请先安装 git"

  if [[ -d "$REPO_DIR/.git" ]]; then
    info "正在更新本地插件源码"
    git -C "$REPO_DIR" fetch --depth 1 origin "$REF"
    git -C "$REPO_DIR" reset --hard FETCH_HEAD
    return
  fi

  if [[ -e "$REPO_DIR" ]]; then
    die "$REPO_DIR 已存在，但不是 Git 工作区。请移走该目录，或设置 OPENVIKING_REPO_DIR。"
  fi

  info "正在克隆插件源码"
  info "  $repo_url ($REF)"
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --depth 1 "$repo_url" "$REPO_DIR"
  git -C "$REPO_DIR" fetch --depth 1 origin "$REF"
  git -C "$REPO_DIR" reset --hard FETCH_HEAD
}

override_url_for() {
  local name="$1"
  case "$name" in
    claude) printf '%s' "${OPENVIKING_PLUGINS_CLAUDE_INSTALL_URL:-}" ;;
    codex) printf '%s' "${OPENVIKING_PLUGINS_CODEX_INSTALL_URL:-}" ;;
    opencode) printf '%s' "${OPENVIKING_PLUGINS_OPENCODE_INSTALL_URL:-}" ;;
  esac
}

run_installer() {
  local name="$1"
  local default_url="$2"
  local url
  local tmp
  shift 2

  url="$(override_url_for "$name")"
  if [[ -z "$url" ]]; then
    local local_installer="$REPO_DIR/$name/setup-helper/install.sh"
    info "正在安装 $name"
    prepare_repo
    [[ -f "$local_installer" ]] || die "未找到安装脚本：$local_installer"
    info "使用本地安装脚本，避免 GitHub raw 缓存"
    info "  $local_installer"
    OPENVIKING_REPO_DIR="$REPO_DIR" \
    OPENVIKING_REPO_URL="https://github.com/${REPO}.git" \
    OPENVIKING_REPO_BRANCH="$REF" \
      bash "$local_installer" "$@"
    return
  fi

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
