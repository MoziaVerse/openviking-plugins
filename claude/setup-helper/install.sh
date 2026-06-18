#!/usr/bin/env bash
#
# OpenViking Memory Plugin for Claude Code — interactive installer.
#
# One-liner:
#   bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/claude/setup-helper/install.sh)
#
# Steps (each is idempotent — re-running is safe):
#   1. Check OS (macOS / Linux only) and required tools.
#   2. Set up ~/.openviking/ovcli.conf — reuse if present, prompt otherwise.
#   3. Clone (or refresh) the OpenViking plugins repo to
#      ~/.openviking/openviking-plugins-repo.
#   4. Add a `claude` shell function to your rc that injects creds at invocation.
#   5. Install the plugin. On Claude Code >= 2.0 (with `claude plugin` support) we
#      use marketplace + plugin install. On older builds — or if marketplace is
#      unavailable — we fall back to legacy mode: `claude mcp add` + a merge into
#      ~/.claude/settings.json.
#
# Env overrides:
#   OPENVIKING_HOME            default: $HOME/.openviking
#   OPENVIKING_REPO_DIR        default: $OPENVIKING_HOME/openviking-plugins-repo
#   OPENVIKING_REPO_URL        default: https://github.com/MoziaVerse/openviking-plugins.git
#   OPENVIKING_REPO_BRANCH     default: main
#   OPENVIKING_REPO_ARCHIVE_URL  when set, fetch the source from this zip instead
#                                of git clone. Requires `unzip`.
#
# Targets bash 3.2+ (macOS /bin/bash) and Linux.

set -euo pipefail

OV_HOME="${OPENVIKING_HOME:-$HOME/.openviking}"
REPO_DIR="${OPENVIKING_REPO_DIR:-$OV_HOME/openviking-plugins-repo}"
REPO_URL="${OPENVIKING_REPO_URL:-https://github.com/MoziaVerse/openviking-plugins.git}"
REPO_BRANCH="${OPENVIKING_REPO_BRANCH:-main}"
REPO_ARCHIVE_URL="${OPENVIKING_REPO_ARCHIVE_URL:-}"
# Marks a $REPO_DIR populated from an archive (no .git). Lets re-runs refresh it
# safely while refusing to clobber a git checkout or unrelated user data.
ARCHIVE_MARKER='.openviking-archive-source'
# Honor OPENVIKING_CLI_CONFIG_FILE (the env var the `ov` CLI itself reads —
# crates/ov_cli/src/config.rs:6) so this installer matches CLI behavior.
OVCLI_CONF="${OPENVIKING_CLI_CONFIG_FILE:-$OV_HOME/ovcli.conf}"

MARKER_BEGIN='# >>> openviking claude-code memory plugin >>>'
MARKER_END='# <<< openviking claude-code memory plugin <<<'

if [ -t 1 ]; then
  CYAN=$'\033[0;36m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  CYAN=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
fi
info()    { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()    { printf '%s!!%s  %s\n' "$YELLOW" "$RESET" "$*"; }
err()     { printf '%sxx%s  %s\n' "$RED" "$RESET" "$*" >&2; }
ask()     { printf '%s??%s  %s' "$CYAN" "$RESET" "$*"; }
heading() { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }

# Download a source zip and lay it out at $REPO_DIR. The archive is `git
# archive` output: a single top-level repo dir, identical to a checkout minus
# .git.
fetch_archive() {
  local url="$1" dest="$2" tmp_zip tmp_dir top
  command -v unzip >/dev/null 2>&1 || { err '未找到 unzip；从归档安装时需要该命令。'; exit 1; }
  tmp_zip=$(mktemp "${TMPDIR:-/tmp}/ov-src.XXXXXX") || { err 'mktemp 执行失败'; exit 1; }
  tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/ov-src.XXXXXX") || { err 'mktemp 执行失败'; rm -f "$tmp_zip"; exit 1; }
  info "正在下载源码归档"
  info "  $url"
  curl -fsSL -o "$tmp_zip" "$url" || { err "下载失败：$url"; rm -rf "$tmp_zip" "$tmp_dir"; exit 1; }
  unzip -q "$tmp_zip" -d "$tmp_dir" || { err '解压失败，下载内容可能已损坏。'; rm -rf "$tmp_zip" "$tmp_dir"; exit 1; }
  top=$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  if [ -z "$top" ] || [ ! -d "$top/claude" ]; then
    err '源码归档结构异常：顶层目录中没有 claude/'
    rm -rf "$tmp_zip" "$tmp_dir"; exit 1
  fi
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  mv "$top" "$dest"
  : > "$dest/$ARCHIVE_MARKER"
  rm -rf "$tmp_zip" "$tmp_dir"
  info "源码已准备好：$dest"
}

# ----- 1. Environment check -----

heading '1. 环境检查'

case "$(uname -s)" in
  Darwin|Linux) info "OS: $(uname -s)" ;;
  *) err "不支持的操作系统：$(uname -s)。仅支持 macOS 和 Linux。"; exit 1 ;;
esac

missing=0
for cmd in git jq curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "未找到 ${cmd}。请安装后重新运行。"
    missing=1
  fi
done
[ "$missing" -eq 1 ] && exit 1

if command -v claude >/dev/null 2>&1; then
  CLAUDE_AVAILABLE=1
  info "claude CLI：$(claude --version 2>/dev/null || echo 未知)"
else
  CLAUDE_AVAILABLE=0
  warn "PATH 中未找到 claude CLI。最后会跳过插件安装步骤。"
  warn "请先安装 Claude Code：https://docs.claude.com/en/docs/claude-code/setup"
fi

# ----- 2. ovcli.conf -----

heading "2. OpenViking 客户端配置 ($OVCLI_CONF)"

mkdir -p "$OV_HOME"
chmod 700 "$OV_HOME" 2>/dev/null || true

CURRENT_URL=""
CURRENT_KEY=""
CURRENT_ACCOUNT=""
CURRENT_USER=""
CURRENT_PEER=""
if [ -f "$OVCLI_CONF" ]; then
  CURRENT_URL=$(jq -r '.url // ""' "$OVCLI_CONF" 2>/dev/null || true)
  CURRENT_KEY=$(jq -r '.api_key // ""' "$OVCLI_CONF" 2>/dev/null || true)
  if [ -n "$CURRENT_URL" ] && [ -n "$CURRENT_KEY" ]; then
    key_preview=$(printf '%s' "$CURRENT_KEY" | cut -c1-8)
    info "发现已有配置："
    info "  url     = $CURRENT_URL"
    info "  api_key = ${key_preview}…"
    ask '复用这些配置？[Y/n] '
    read -r reply || reply=""
    case "$reply" in
      n|N|no|No|NO) CURRENT_URL=""; CURRENT_KEY="" ;;
    esac
  fi
fi

if [ -z "$CURRENT_URL" ] || [ -z "$CURRENT_KEY" ]; then
  printf '%s请选择要连接的 OpenViking 服务：%s\n' "$BOLD" "$RESET"
  printf '  1) 自建 / 本地服务                              [默认：http://127.0.0.1:1933]\n'
  printf '  2) 火山引擎 OpenViking Cloud                    [https://api.vikingdb.cn-beijing.volces.com/openviking]\n'
  ask '[1/2，默认 1]：'
  read -r MODE_INPUT || MODE_INPUT=""
  case "$MODE_INPUT" in
    2)
      CURRENT_URL="https://api.vikingdb.cn-beijing.volces.com/openviking"
      info "使用火山引擎 OpenViking Cloud：$CURRENT_URL"
      KEY_PROMPT="API Key（火山引擎 OpenViking Cloud 必填）："
      ;;
    *)
      DEFAULT_URL="http://127.0.0.1:1933"
      ask "OpenViking 服务地址 [$DEFAULT_URL]："
      read -r URL_INPUT || URL_INPUT=""
      CURRENT_URL="${URL_INPUT:-$DEFAULT_URL}"
      KEY_PROMPT="API Key（本地匿名模式可留空）："
      ;;
  esac

  ask "$KEY_PROMPT"
  # -s: don't echo (hide secret); fall back if -s unsupported
  if read -rs API_INPUT 2>/dev/null; then
    printf '\n'
  else
    read -r API_INPUT || API_INPUT=""
  fi
  CURRENT_KEY="$API_INPUT"

  if [ -f "$OVCLI_CONF" ]; then
    backup="$OVCLI_CONF.bak.$(date +%s)"
    cp "$OVCLI_CONF" "$backup"
    info "已备份原配置 → $backup"
    tmp_conf=$(mktemp "$OVCLI_CONF.XXXXXX") || { err 'mktemp 执行失败'; exit 1; }
    jq --arg url "$CURRENT_URL" --arg key "$CURRENT_KEY" \
      '. + {url: $url, api_key: $key}' "$OVCLI_CONF" > "$tmp_conf"
    mv "$tmp_conf" "$OVCLI_CONF"
  else
    jq -n --arg url "$CURRENT_URL" --arg key "$CURRENT_KEY" \
      '{url: $url, api_key: $key}' > "$OVCLI_CONF"
  fi
  chmod 600 "$OVCLI_CONF"
  info "已写入 ${OVCLI_CONF}（权限 0600）"
fi

if [ -f "$OVCLI_CONF" ]; then
  CURRENT_URL=$(jq -r '.url // ""' "$OVCLI_CONF" 2>/dev/null || true)
  CURRENT_KEY=$(jq -r '.api_key // ""' "$OVCLI_CONF" 2>/dev/null || true)
  CURRENT_ACCOUNT=$(jq -r '.account // ""' "$OVCLI_CONF" 2>/dev/null || true)
  CURRENT_USER=$(jq -r '.user // ""' "$OVCLI_CONF" 2>/dev/null || true)
  CURRENT_PEER=$(jq -r '.peer_id // .agent_id // ""' "$OVCLI_CONF" 2>/dev/null || true)
fi

[ -n "$CURRENT_URL" ] && export OPENVIKING_URL="${OPENVIKING_URL:-$CURRENT_URL}"
[ -n "$CURRENT_KEY" ] && export OPENVIKING_API_KEY="${OPENVIKING_API_KEY:-$CURRENT_KEY}"
[ -n "$CURRENT_ACCOUNT" ] && export OPENVIKING_ACCOUNT="${OPENVIKING_ACCOUNT:-$CURRENT_ACCOUNT}"
[ -n "$CURRENT_USER" ] && export OPENVIKING_USER="${OPENVIKING_USER:-$CURRENT_USER}"
[ -n "$CURRENT_PEER" ] && export OPENVIKING_PEER_ID="${OPENVIKING_PEER_ID:-$CURRENT_PEER}"

# ----- 3. Clone / refresh repo -----

heading "3. OpenViking 插件源码仓库 ($REPO_DIR)"

if [ -n "$REPO_ARCHIVE_URL" ]; then
  # Archive mode (GitHub-free): refuse to overwrite anything we didn't create.
  if [ -e "$REPO_DIR" ] && [ ! -f "$REPO_DIR/$ARCHIVE_MARKER" ]; then
    err "$REPO_DIR 已存在，且不是由归档安装创建。请移走该目录，或设置 OPENVIKING_REPO_DIR。"
    exit 1
  fi
  fetch_archive "$REPO_ARCHIVE_URL" "$REPO_DIR"
elif [ -d "$REPO_DIR/.git" ]; then
  info "正在更新已有工作区"
  git -C "$REPO_DIR" fetch --depth 1 origin "$REPO_BRANCH"
  git -C "$REPO_DIR" reset --hard "FETCH_HEAD"
else
  if [ -e "$REPO_DIR" ]; then
    err "$REPO_DIR 已存在，但不是 Git 工作区。请移走该目录，或设置 OPENVIKING_REPO_DIR。"
    exit 1
  fi
  info "正在克隆 ${REPO_URL}（分支 ${REPO_BRANCH}，depth 1）"
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR"
fi

# ----- 4. Shell rc wrapper -----
#
# Source of truth: setup-helper/wrapper.sh in the plugin checkout. The
# user's shell rc just sources that file directly — no copy step, so any
# updates land via the next `git fetch + reset --hard` the installer
# already runs above. Same pattern pyenv / nvm / fnm use, except we don't
# even need an intermediate copy in $HOME.

heading '4. Shell 配置 — claude 函数包装'

PLUGIN_DIR="$REPO_DIR/claude"
WRAPPER_SRC="$PLUGIN_DIR/setup-helper/wrapper.sh"
if [ ! -f "$WRAPPER_SRC" ]; then
  err "未找到 wrapper 源文件：$WRAPPER_SRC"
  exit 1
fi

render_mcp_config() {
  local mcp_json="$PLUGIN_DIR/.mcp.json"
  local base_url="${OPENVIKING_URL:-${CURRENT_URL:-http://127.0.0.1:1933}}"
  local api_key="${OPENVIKING_API_KEY:-${CURRENT_KEY:-}}"
  local account="${OPENVIKING_ACCOUNT:-${CURRENT_ACCOUNT:-}}"
  local user="${OPENVIKING_USER:-${CURRENT_USER:-}}"
  local mcp_url tmp
  base_url="${base_url%/}"
  mcp_url="$base_url/mcp"
  if [ ! -f "$mcp_json" ]; then
    err "未找到 MCP 配置文件：$mcp_json"
    exit 1
  fi
  tmp=$(mktemp "$mcp_json.XXXXXX") || { err 'mktemp 执行失败'; exit 1; }
  jq \
    --arg url "$mcp_url" \
    --arg auth "${api_key:+Bearer $api_key}" \
    --arg account "$account" \
    --arg user "$user" \
    '
      .openviking.url = $url
      | .openviking.headers = (.openviking.headers // {})
      | if $auth != "" then .openviking.headers.Authorization = $auth else del(.openviking.headers.Authorization) end
      | if $account != "" then .openviking.headers["X-OpenViking-Account"] = $account else del(.openviking.headers["X-OpenViking-Account"]) end
      | if $user != "" then .openviking.headers["X-OpenViking-User"] = $user else del(.openviking.headers["X-OpenViking-User"]) end
    ' "$mcp_json" > "$tmp"
  mv "$tmp" "$mcp_json"
  chmod 600 "$mcp_json" 2>/dev/null || true
  info "已渲染 Claude MCP 地址和认证头：$mcp_url（token 不显示）"
}

render_mcp_config

case "${SHELL:-}" in
  */zsh)  RC="$HOME/.zshrc" ;;
  */bash) RC="$HOME/.bashrc" ;;
  *)
    if   [ -f "$HOME/.zshrc" ];  then RC="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then RC="$HOME/.bashrc"
    else RC=""; fi
    ;;
esac

# Extra launch commands to wrap besides `claude` — e.g. a custom wrapper
# `cc-custom`, or a multi-word launcher matched on its sub-command.
# Persisted in the rc marker block as OPENVIKING_CC_WRAP_EXTRA; the wrapper
# reads it and injects credentials into matching invocations only.
heading '4b. 额外启动命令（可选）'
# Seed from this run's env var (automation path), else the value already in
# the rc (re-run path). The interactive prompt below can still override it.
WRAP_EXTRA="${OPENVIKING_CC_WRAP_EXTRA:-}"
if [ -z "$WRAP_EXTRA" ] && [ -n "$RC" ] && [ -f "$RC" ]; then
  WRAP_EXTRA=$(awk -F"'" '/^OPENVIKING_CC_WRAP_EXTRA=/{print $2; exit}' "$RC" 2>/dev/null || true)
fi
info '是否也为其他启动命令注入 OpenViking 凭据？例如自定义 wrapper `cc-custom`。'
info '多词启动器会按子命令匹配；该命令的其他用法会原样放行。'
if [ -n "$WRAP_EXTRA" ]; then
  info "当前配置：$WRAP_EXTRA"
  ask '命令列表（用 ; 分隔；留空=保留，- =清空）：'
else
  ask '命令列表（用 ; 分隔，例如 "cc-custom"；留空=跳过）：'
fi
read -r WRAP_INPUT || WRAP_INPUT=""
case "$WRAP_INPUT" in
  "") : ;;
  -)  WRAP_EXTRA="" ;;
  *)  WRAP_EXTRA="$WRAP_INPUT" ;;
esac
# Normalize each ';'-entry: strip single quotes (keep the rc line safely
# single-quotable), trim, collapse internal whitespace, drop empties.
if [ -n "$WRAP_EXTRA" ]; then
  WRAP_EXTRA=$(printf '%s' "$WRAP_EXTRA" | awk -F';' '{
    out="";
    for (i = 1; i <= NF; i++) {
      s = $i; gsub(/\047/, "", s); gsub(/^[ \t]+|[ \t]+$/, "", s); gsub(/[ \t]+/, " ", s);
      if (s != "") out = (out == "" ? s : out ";" s);
    }
    print out;
  }')
  [ -n "$WRAP_EXTRA" ] && info "将包装这些命令：$WRAP_EXTRA"
fi

# The user's shell rc gets a single one-line source hook pointing at the
# wrapper source in the cloned plugin checkout. Hook content stays stable
# across installs (only the absolute path matters), so the marker
# replacement only triggers a legacy-cleanup pass once when upgrading from
# a pre-split install that inlined the full wrapper into the rc.
SOURCE_HOOK="[ -f \"$WRAPPER_SRC\" ] && . \"$WRAPPER_SRC\""
if [ -n "$WRAP_EXTRA" ]; then
  SOURCE_BLOCK="$MARKER_BEGIN
OPENVIKING_CC_WRAP_EXTRA='$WRAP_EXTRA'
$SOURCE_HOOK
$MARKER_END"
else
  SOURCE_BLOCK="$MARKER_BEGIN
$SOURCE_HOOK
$MARKER_END"
fi

if [ -z "$RC" ]; then
  warn '未检测到 shell rc 文件。请手动把下面片段加入你的 rc 文件：'
  warn ''
  while IFS= read -r line; do warn "  $line"; done <<< "$SOURCE_BLOCK"
else
  touch "$RC"
  if grep -qF "$MARKER_BEGIN" "$RC"; then
    info "正在替换 $RC 中的 OpenViking 加载片段"
    # Strip existing block (whether it's the new one-liner or an old
    # inline-wrapper block from a previous version).
    awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
      $0 == b {skip=1; next}
      $0 == e {skip=0; next}
      !skip
    ' "$RC" > "$RC.tmp" && mv "$RC.tmp" "$RC"
  else
    info "正在向 $RC 追加 OpenViking 加载片段"
  fi
  printf '\n%s\n' "$SOURCE_BLOCK" >> "$RC"
fi

# ----- 5. Plugin install -----
#
# `claude plugin` was introduced in Claude Code 2.0 (2025-10). Older builds only
# expose `claude mcp add` and the hooks system. We detect the major version and
# offer a legacy install path that wires the same functionality through
# `claude mcp add` + a merge into ~/.claude/settings.json.
#
# Note on `--scope`:
#   - `claude mcp add --scope user` has been supported since MCP first shipped,
#     and the default (`local`) ties the server to one project, so we DO pass it.
#   - `claude plugin install` / `claude plugin marketplace add` already default to
#     user scope, and the `--scope` flag is rejected by older 2.0.x builds (e.g.
#     2.0.76). We omit it.

heading '5. 插件安装'

# Probe for `claude plugin` support directly rather than parsing --version output.
# The version-string format isn't a stable contract; the subcommand's existence is.
has_plugin_subcommand() {
  claude plugin --help >/dev/null 2>&1
}

install_legacy() {
  local plugin_dir="$PLUGIN_DIR"
  local hooks_src="$plugin_dir/hooks/hooks.json"
  local settings="$HOME/.claude/settings.json"
  local legacy_base_url="${OPENVIKING_URL:-${CURRENT_URL:-http://127.0.0.1:1933}}"
  local api_key="${OPENVIKING_API_KEY:-${CURRENT_KEY:-}}"
  local account="${OPENVIKING_ACCOUNT:-${CURRENT_ACCOUNT:-}}"
  local user="${OPENVIKING_USER:-${CURRENT_USER:-}}"
  local ts; ts=$(date +%Y%m%d-%H%M%S)
  local -a mcp_headers=()
  legacy_base_url="${legacy_base_url%/}"

  info "兼容模式：注册 MCP 服务，并把 hooks 合并到 $settings"

  # 1) MCP server. Render the current USER API Key into Claude's local MCP
  # config so authentication does not depend on the shell wrapper being active.
  [ -n "$api_key" ] && mcp_headers+=(--header "Authorization: Bearer $api_key")
  [ -n "$account" ] && mcp_headers+=(--header "X-OpenViking-Account: $account")
  [ -n "$user" ] && mcp_headers+=(--header "X-OpenViking-User: $user")
  info 'claude mcp add openviking（用户作用域）'
  claude mcp remove openviking -s user >/dev/null 2>&1 || true
  claude mcp add --scope user --transport http openviking \
    "$legacy_base_url/mcp" \
    "${mcp_headers[@]}" || {
      err 'claude mcp add 执行失败'
      return 1
    }

  # 2) Hooks: replace ${CLAUDE_PLUGIN_ROOT} (only expanded by 2.0+ plugin loader)
  # with an absolute path, then merge into ~/.claude/settings.json. Back up
  # first; verify the merged JSON before overwriting.
  if [ ! -f "$hooks_src" ]; then
    err "未找到 hooks 源文件：$hooks_src"
    return 1
  fi
  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || echo '{}' > "$settings"
  cp -p "$settings" "$settings.bak.$ts"
  info "已备份：$settings.bak.$ts"

  # mktemp instead of `$$` — predictable PID-based names are vulnerable to
  # symlink races on shared /tmp.
  local tmp_h tmp_s
  tmp_h=$(mktemp "${TMPDIR:-/tmp}/ov-hooks.XXXXXX") || { err 'mktemp 执行失败'; return 1; }
  tmp_s=$(mktemp "${TMPDIR:-/tmp}/ov-settings.XXXXXX") || { err 'mktemp 执行失败'; rm -f "$tmp_h"; return 1; }

  # Replace ${CLAUDE_PLUGIN_ROOT} via jq, not sed — $plugin_dir comes from a
  # user-configurable env var and may contain &, |, or \ which would corrupt
  # sed substitution.
  if ! jq --arg root "$plugin_dir" \
      'walk(if type == "string" then gsub("\\$\\{CLAUDE_PLUGIN_ROOT\\}"; $root) else . end)' \
      "$hooks_src" > "$tmp_h" 2>/dev/null; then
    err "展开 $hooks_src 中的 CLAUDE_PLUGIN_ROOT 失败"
    rm -f "$tmp_h" "$tmp_s"
    return 1
  fi

  # Shallow merge — keep user's other hook events; same-event keys get overwritten.
  # Explicit error branch so a malformed settings.json doesn't kill the whole
  # script via `set -e` and skip our cleanup.
  if ! jq --slurpfile h "$tmp_h" '.hooks = ((.hooks // {}) * $h[0].hooks)' \
      "$settings" > "$tmp_s" 2>/dev/null; then
    err "合并 hooks 到 ${settings} 失败；原文件未修改（临时文件：${tmp_s}）"
    rm -f "$tmp_h"
    return 1
  fi
  mv "$tmp_s" "$settings"
  rm -f "$tmp_h"
  info 'hooks 已合并'
}

install_modern() {
  # `--scope` intentionally omitted. Default scope is already user; passing it
  # breaks older 2.0.x builds that don't recognize the flag.
  local mp='openviking-plugins-local'
  local plugin='claude-code-memory-plugin@openviking-plugins-local'

  # Marketplace: add when missing, else UPDATE. `marketplace add` on an existing
  # entry is a no-op that does NOT re-read the source, so a bumped plugin version
  # in the checkout is never picked up on re-run. Re-running the installer is the
  # supported upgrade path, so the already-present branch must re-sync the catalog.
  if claude plugin marketplace list 2>/dev/null | grep -qF "$mp"; then
    info "正在更新 Claude 插件市场 ($mp)"
    claude plugin marketplace update "$mp" || \
      warn '插件市场更新返回非零状态，继续执行'
  else
    info '正在添加 Claude 插件市场'
    ( cd "$REPO_DIR" && claude plugin marketplace add "$REPO_DIR" ) || \
      warn '插件市场添加返回非零状态，继续执行'
  fi

  # Plugin: update when already installed, else install. `plugin install` is a
  # no-op on an existing install (it will NOT pull a newer version), so an
  # explicit `plugin update` is required for the re-run-to-upgrade path.
  if claude plugin list 2>/dev/null | grep -qF "$plugin"; then
    info "正在更新 Claude 插件 ($plugin)"
    ( cd "$REPO_DIR" && claude plugin update "$plugin" ) || \
      warn '插件更新返回非零状态，继续执行'
  else
    info '正在安装 Claude 插件'
    ( cd "$REPO_DIR" && claude plugin install "$plugin" ) || {
      warn '插件安装失败，回退到兼容模式'
      install_legacy
      return $?
    }
  fi
  # Belt-and-suspenders: ensure enabled even if install/update left it disabled.
  claude plugin enable "$plugin" >/dev/null 2>&1 || true
}

# Statusline registration. CC's plugin manifest doesn't accept a statusLine
# field (only hooks/MCP/agents/skills are bundle-able), so we have to inject
# into the user's ~/.claude/settings.json. Always opt-in: we ask first, both
# because terminal real-estate is opinionated and because users often have
# their own statusline they don't want clobbered.
register_statusline() {
  local plugin_dir="$PLUGIN_DIR"
  # Quote the script path so install dirs containing spaces/metacharacters
  # don't break when CC invokes the command via /bin/sh -c.
  local cmd="node \"$plugin_dir/scripts/statusline.mjs\""
  local settings="$HOME/.claude/settings.json"

  heading 'Statusline（可选）'
  info 'OpenViking 可以在输入框下方显示一行服务器/召回状态。'
  info '示例："OV ✓ │ ↩ 6 mem (0.92) · 50ms │ ✎ 573/20k · 2 arch │ +3 today"'

  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || echo '{}' > "$settings"

  local existing
  existing=$(jq -r '.statusLine.command // empty' "$settings" 2>/dev/null || echo "")

  if [ -n "$existing" ] && [ "$existing" = "$cmd" ]; then
    info '已注册。重新运行安装脚本即可刷新配置。'
    return 0
  fi

  if [ -n "$existing" ]; then
    warn "检测到已有 statusline："
    warn "  $existing"
    ask '是否替换为 OpenViking statusline？[y/N] '
  else
    ask '是否启用 OpenViking statusline？[y/N] '
  fi
  local reply
  read -r reply || reply=""
  case "$reply" in
    y|Y|yes|Yes|YES) ;;
    *)
      info '已跳过 statusline 注册。之后可重新运行安装脚本启用。'
      return 0
      ;;
  esac

  local ts; ts=$(date +%Y%m%d-%H%M%S)
  cp -p "$settings" "$settings.bak.$ts"
  # mktemp inside the same directory as $settings so the final `mv` is a
  # rename within one filesystem (atomic). Using $TMPDIR risks crossing
  # filesystems on Linux (tmpfs vs $HOME), which makes `mv` non-atomic.
  local tmp
  tmp=$(mktemp "$settings.XXXXXX") || { err 'mktemp 执行失败'; return 1; }
  if ! jq --arg cmd "$cmd" \
       '.statusLine = {type: "command", command: $cmd, padding: 0}' \
       "$settings" > "$tmp" 2>/dev/null; then
    err "写入 statusline 到 $settings 失败；原文件未修改"
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$settings"
  info "statusline 已注册（备份：${settings}.bak.${ts}）"
  info '稍后禁用：    jq "del(.statusLine)" '"$settings"' > t && mv t '"$settings"
  info '仅静默显示：  export OPENVIKING_STATUSLINE=off'
}

USE_LEGACY=0
if [ "$CLAUDE_AVAILABLE" -eq 1 ] && ! has_plugin_subcommand; then
  warn "当前 Claude Code 版本没有 'claude plugin' 子命令（2.0 引入）。"
  ask '是否使用兼容模式（claude mcp add + 合并 settings.json）？[Y/n] '
  read -r reply || reply=""
  case "$reply" in
    n|N|no|No|NO)
      warn "跳过插件安装。请升级到 Claude Code >= 2.0 后重新运行。"
      CLAUDE_AVAILABLE=0
      ;;
    *) USE_LEGACY=1 ;;
  esac
fi

if [ "$CLAUDE_AVAILABLE" -eq 1 ]; then
  if [ "$USE_LEGACY" -eq 1 ]; then
    install_legacy
  else
    install_modern
  fi
  register_statusline || warn 'statusline 注册已跳过，继续执行'
else
  warn "安装 Claude Code 后，请手动执行："
  warn "  cd \"$REPO_DIR\""
  warn '  claude plugin marketplace add "$(pwd)"'
  warn '  claude plugin install claude-code-memory-plugin@openviking-plugins-local'
fi

# ----- Done -----
#
# We can't auto-source the rc into the user's shell — this script runs in a
# subshell (e.g. `bash <(curl ...)`), so any export/source we do here dies
# when the script exits. The user has to run `source` themselves, hence the
# bold callout below. (`source <(curl ...)` would work but is unsafe to
# recommend — it pipes remote code straight into the user's interactive shell.)

heading '安装完成'
info "源码目录：  $REPO_DIR"
info "配置文件：  $OVCLI_CONF"
[ -n "$RC" ] && info "Shell 配置：  $RC"
printf '\n'
if [ -n "$RC" ]; then
  printf '%s%s下一步：在当前 shell 中执行下面命令，让 wrapper 生效：%s\n' "$BOLD" "$YELLOW" "$RESET"
  printf '    %s%ssource %s%s\n' "$BOLD" "$CYAN" "$RC" "$RESET"
  printf '  （也可以直接打开一个新的终端窗口）\n\n'
fi
info '然后：'
info '  claude              # 启动 Claude Code'
info '  /mcp                # 在 Claude Code 中检查 OpenViking 条目'
printf '\n'
printf '%s想了解 statusline 每段含义，或想调整显示？%s 打开 Claude Code 后粘贴：\n' "$BOLD" "$RESET"
printf '  %s读取 %s/claude/STATUSLINE.md。说明我的 OpenViking statusline 每段含义，然后询问我是否要个性化调整。%s\n' "$CYAN" "$REPO_DIR" "$RESET"
