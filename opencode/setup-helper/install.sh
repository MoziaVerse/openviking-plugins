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
OpenViking OpenCode plugin installer

Usage:
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/opencode/setup-helper/install.sh)

Options:
  --dry-run      Print planned actions only.
  --uninstall    Remove the installed plugin file.
  -h, --help     Show this help.

Environment:
  OPENVIKING_OPENCODE_REPO          GitHub repo, default: ${REPO_DEFAULT}
  OPENVIKING_OPENCODE_REF           Git ref, default: main
  OPENVIKING_OPENCODE_PLUGIN_URL    Direct plugin download URL
  OPENVIKING_OPENCODE_PLUGIN_DIR    Install dir, default: ~/.config/opencode/plugins
  GITHUB_TOKEN / GH_TOKEN           Token for private GitHub raw downloads

Optional ovcli bootstrap:
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
      echo "Unknown option: $1" >&2
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
  printf '[openviking-opencode] WARN: %s\n' "$*" >&2
}

die() {
  printf '[openviking-opencode] ERROR: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
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
      info "OpenCode detected: $candidate"
      return 0
    fi
  done

  warn "opencode was not found or failed to run; install/fix OpenCode before using the plugin"
}

download_file() {
  local url="$1"
  local dest="$2"
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  local args=(-fsSL)
  if [[ -n "$token" ]]; then
    args+=(-H "Authorization: Bearer ${token}")
  fi
  curl "${args[@]}" "$url" -o "$dest"
}

has_ovcli_config() {
  [[ -f "$OVCLI_FILE" ]] && grep -Eq '"(api_key|apiKey)"[[:space:]]*:' "$OVCLI_FILE"
}

write_ovcli_config() {
  local url="${OPENVIKING_URL:-${OPENVIKING_BASE_URL:-}}"
  local api_key="${OPENVIKING_API_KEY:-${OPENVIKING_BEARER_TOKEN:-}}"

  [[ "${OPENVIKING_OPENCODE_WRITE_OVCLI:-0}" == "1" ]] || return 0
  [[ -n "$url" ]] || die "OPENVIKING_OPENCODE_WRITE_OVCLI=1 requires OPENVIKING_URL or OPENVIKING_BASE_URL"
  [[ -n "$api_key" ]] || die "OPENVIKING_OPENCODE_WRITE_OVCLI=1 requires OPENVIKING_API_KEY or OPENVIKING_BEARER_TOKEN"
  need_command node

  if [[ "$DRY_RUN" == "1" ]]; then
    info "would write OpenViking CLI config: $OVCLI_FILE"
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
  info "wrote OpenViking CLI config: $OVCLI_FILE"
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
      info "would remove $target"
    else
      rm -f "$target"
      info "removed $target"
    fi
    return 0
  fi

  info "plugin URL: $PLUGIN_URL"
  info "install dir: $PLUGIN_DIR"

  if [[ "$DRY_RUN" == "1" ]]; then
    info "would download plugin and install $target"
  else
    mkdir -p "$PLUGIN_DIR"
    download_file "$PLUGIN_URL" "$tmp"
    if [[ -f "$target" ]]; then
      if cmp -s "$tmp" "$target"; then
        info "plugin already up to date: $target"
      else
        cp -p "$target" "${target}.bak.$(date +%Y%m%d%H%M%S)"
        install -m 0644 "$tmp" "$target"
        info "updated plugin: $target"
      fi
    else
      install -m 0644 "$tmp" "$target"
      info "installed plugin: $target"
    fi
  fi

  if [[ -n "${OPENVIKING_API_KEY:-${OPENVIKING_BEARER_TOKEN:-}}" ]]; then
    info "OpenViking credentials: using environment variables"
  elif has_ovcli_config; then
    info "OpenViking credentials: using $OVCLI_FILE"
  else
    warn "no OpenViking user API key found; set OPENVIKING_API_KEY or configure $OVCLI_FILE"
  fi

  info "done. Start OpenCode with: opencode"
  info "debug logs: OPENVIKING_DEBUG=1 opencode"
}

install_plugin
