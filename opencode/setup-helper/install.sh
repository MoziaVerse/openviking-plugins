#!/usr/bin/env bash
set -euo pipefail

REPO_DEFAULT="MoziaVerse/openviking-plugins"
REF_DEFAULT="main"
PLUGIN_NAME="openviking-memory.ts"

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
PLUGIN_DIR="${OPENVIKING_OPENCODE_PLUGIN_DIR:-$CONFIG_HOME/opencode/plugins}"
OVCLI_FILE="${OPENVIKING_CLI_CONFIG_FILE:-$HOME/.openviking/ovcli.conf}"
REPO="${OPENVIKING_OPENCODE_REPO:-$REPO_DEFAULT}"
REF="${OPENVIKING_OPENCODE_REF:-$REF_DEFAULT}"
PLUGIN_URL="${OPENVIKING_OPENCODE_PLUGIN_URL:-https://raw.githubusercontent.com/${REPO}/${REF}/opencode/${PLUGIN_NAME}}"

DRY_RUN=0
UNINSTALL=0

usage() {
  cat <<EOF
OpenViking OpenCode 插件安装器

用法：
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/opencode/setup-helper/install.sh)

选项：
  --dry-run      只打印计划执行的操作，不实际修改。
  --uninstall    删除已安装的插件文件。
  -h, --help     显示帮助。

环境变量：
  OPENVIKING_OPENCODE_REPO          GitHub 仓库，默认：${REPO_DEFAULT}
  OPENVIKING_OPENCODE_REF           Git 引用，默认：main
  OPENVIKING_OPENCODE_PLUGIN_URL    插件文件直连下载 URL
  OPENVIKING_OPENCODE_PLUGIN_DIR    安装目录，默认：~/.config/opencode/plugins

可选 ovcli 配置初始化：
  OPENVIKING_OPENCODE_WRITE_OVCLI=1
  OPENVIKING_URL / OPENVIKING_BASE_URL
  OPENVIKING_API_KEY / OPENVIKING_BEARER_TOKEN
  OPENVIKING_ACCOUNT
  OPENVIKING_USER
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --uninstall)
      UNINSTALL=1
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

warn() {
  printf '[openviking-opencode] 警告：%s\n' "$*" >&2
}

die() {
  printf '[openviking-opencode] 错误：%s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少必需命令：$1"
}

maybe_check_opencode() {
  local candidates=()
  local path_candidate=""
  local candidate
  local seen=":"

  [[ -n "${OPENVIKING_OPENCODE_BIN:-}" ]] && candidates+=("$OPENVIKING_OPENCODE_BIN")
  [[ -x "$HOME/.opencode/bin/opencode" ]] && candidates+=("$HOME/.opencode/bin/opencode")
  path_candidate="$(command -v opencode 2>/dev/null || true)"
  [[ -n "$path_candidate" ]] && candidates+=("$path_candidate")
  [[ -x "/opt/homebrew/bin/opencode" ]] && candidates+=("/opt/homebrew/bin/opencode")
  [[ -x "/usr/local/bin/opencode" ]] && candidates+=("/usr/local/bin/opencode")

  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" ]] || continue
    case "$seen" in
      *":$candidate:"*) continue ;;
    esac
    seen="${seen}${candidate}:"
    if "$candidate" --version >/dev/null 2>&1; then
      info "已检测到 OpenCode：$candidate"
      return 0
    fi
  done

  warn "未找到 opencode，或 opencode 无法运行；使用插件前请先安装或修复 OpenCode"
}

download_file() {
  local url="$1"
  local dest="$2"
  curl -fsSL "$url" -o "$dest"
}

has_ovcli_config() {
  [[ -f "$OVCLI_FILE" ]] && grep -Eq '"(api_key|apiKey)"[[:space:]]*:' "$OVCLI_FILE"
}

write_ovcli_config() {
  local url="${OPENVIKING_URL:-${OPENVIKING_BASE_URL:-}}"
  local api_key="${OPENVIKING_API_KEY:-${OPENVIKING_BEARER_TOKEN:-}}"

  [[ "${OPENVIKING_OPENCODE_WRITE_OVCLI:-0}" == "1" ]] || return 0
  [[ -n "$url" ]] || die "OPENVIKING_OPENCODE_WRITE_OVCLI=1 需要 OPENVIKING_URL 或 OPENVIKING_BASE_URL"
  [[ -n "$api_key" ]] || die "OPENVIKING_OPENCODE_WRITE_OVCLI=1 需要 OPENVIKING_API_KEY 或 OPENVIKING_BEARER_TOKEN"
  need_command node

  if [[ "$DRY_RUN" == "1" ]]; then
    info "将写入 OpenViking CLI 配置：$OVCLI_FILE"
    return 0
  fi

  mkdir -p "$(dirname "$OVCLI_FILE")"
  if [[ -f "$OVCLI_FILE" ]]; then
    cp -p "$OVCLI_FILE" "${OVCLI_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  fi

  OPENVIKING_OVCLI_FILE="$OVCLI_FILE" node <<'NODE'
const fs = require("node:fs")
const file = process.env.OPENVIKING_OVCLI_FILE
const config = {
  url: process.env.OPENVIKING_URL || process.env.OPENVIKING_BASE_URL,
  api_key: process.env.OPENVIKING_API_KEY || process.env.OPENVIKING_BEARER_TOKEN,
  account: process.env.OPENVIKING_ACCOUNT || "default",
  user: process.env.OPENVIKING_USER || process.env.USER || "opencode",
  agent_id: process.env.OPENVIKING_AGENT_ID || "default",
}
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
NODE
  chmod 600 "$OVCLI_FILE"
  info "已写入 OpenViking CLI 配置：$OVCLI_FILE"
}

install_plugin() {
  local target="$PLUGIN_DIR/$PLUGIN_NAME"
  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "'"$tmp"'"' EXIT

  need_command curl
  maybe_check_opencode
  write_ovcli_config

  if [[ "$UNINSTALL" == "1" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      info "将删除 $target"
    else
      rm -f "$target"
      info "已删除 $target"
    fi
    return 0
  fi

  info "插件下载地址：$PLUGIN_URL"
  info "安装目录：$PLUGIN_DIR"

  if [[ "$DRY_RUN" == "1" ]]; then
    info "将下载插件并安装到 $target"
  else
    mkdir -p "$PLUGIN_DIR"
    download_file "$PLUGIN_URL" "$tmp"
    if [[ -f "$target" ]]; then
      if cmp -s "$tmp" "$target"; then
        info "插件已是最新：$target"
      else
        cp -p "$target" "${target}.bak.$(date +%Y%m%d%H%M%S)"
        install -m 0644 "$tmp" "$target"
        info "已更新插件：$target"
      fi
    else
      install -m 0644 "$tmp" "$target"
      info "已安装插件：$target"
    fi
  fi

  if [[ -n "${OPENVIKING_API_KEY:-${OPENVIKING_BEARER_TOKEN:-}}" ]]; then
    info "OpenViking 凭据：使用环境变量"
  elif has_ovcli_config; then
    info "OpenViking 凭据：使用 $OVCLI_FILE"
  else
    warn "未找到 OpenViking USER API Key；请设置 OPENVIKING_API_KEY 或配置 $OVCLI_FILE"
  fi

  info "安装完成。启动 OpenCode：opencode"
  info "调试日志开启方式：OPENVIKING_DEBUG=1 opencode"
}

install_plugin
