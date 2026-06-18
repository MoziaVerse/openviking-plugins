#!/usr/bin/env bash
set -euo pipefail

REPO_DEFAULT="MoziaVerse/openviking-plugins"
REF_DEFAULT="main"

REPO="${OPENVIKING_PLUGINS_REPO:-$REPO_DEFAULT}"
REF="${OPENVIKING_PLUGINS_REF:-$REF_DEFAULT}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
TARGET="${1:-}"

usage() {
  cat <<EOF
OpenViking plugins installer

Usage:
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/install.sh) codex
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/install.sh) opencode
  bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/install.sh) all

Private repository:
  export GITHUB_TOKEN="\$(gh auth token)"
  bash <(curl -fsSL -H "Authorization: Bearer \$GITHUB_TOKEN" https://raw.githubusercontent.com/${REPO_DEFAULT}/main/scripts/install.sh) codex

Targets:
  codex      Install the Codex memory plugin.
  opencode   Install the OpenCode memory plugin.
  all        Install both plugins.

Environment:
  OPENVIKING_PLUGINS_REPO                  GitHub repo, default: ${REPO_DEFAULT}
  OPENVIKING_PLUGINS_REF                   Git ref, default: main
  OPENVIKING_PLUGINS_CODEX_INSTALL_URL     Direct Codex installer URL
  OPENVIKING_PLUGINS_OPENCODE_INSTALL_URL  Direct OpenCode installer URL
  GITHUB_TOKEN / GH_TOKEN                  Token for private GitHub raw downloads

Extra arguments after the target are passed to the target installer.
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
  printf '[openviking-plugins] ERROR: %s\n' "$*" >&2
  exit 1
}

download_installer() {
  local url="$1"
  local dest="$2"
  local args=(-fsSL)
  if [[ -n "$TOKEN" ]]; then
    args+=(-H "Authorization: Bearer ${TOKEN}")
  fi
  curl "${args[@]}" "$url" -o "$dest"
}

run_installer() {
  local name="$1"
  local default_url="$2"
  local url="$default_url"
  local tmp
  shift 2

  case "$name" in
    codex)
      url="${OPENVIKING_PLUGINS_CODEX_INSTALL_URL:-$default_url}"
      ;;
    opencode)
      url="${OPENVIKING_PLUGINS_OPENCODE_INSTALL_URL:-$default_url}"
      ;;
  esac

  tmp="$(mktemp)"
  trap 'rm -f "'"$tmp"'"' RETURN
  info "Installing $name"
  info "  $url"
  download_installer "$url" "$tmp"
  bash "$tmp" "$@"
  rm -f "$tmp"
  trap - RETURN
}

CODEX_URL="https://raw.githubusercontent.com/${REPO}/${REF}/codex/setup-helper/install.sh"
OPENCODE_URL="https://raw.githubusercontent.com/${REPO}/${REF}/opencode/setup-helper/install.sh"

case "$TARGET" in
  codex)
    run_installer codex "$CODEX_URL" "$@"
    ;;
  opencode)
    run_installer opencode "$OPENCODE_URL" "$@"
    ;;
  all)
    run_installer codex "$CODEX_URL" "$@"
    run_installer opencode "$OPENCODE_URL" "$@"
    ;;
  *)
    die "unknown target: $TARGET"
    ;;
esac
