#!/usr/bin/env bash
#
# OpenViking Memory Plugin for Codex — interactive installer.
#
# One-liner:
#   bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/codex/setup-helper/install.sh)
#
# UX mirrors the claude-code installer (colored step output + interactive
# ovcli.conf setup). When stdin is not a TTY (e.g. `curl | bash`) the
# interactive prompts are skipped and existing config / env vars are used.
#
# Env overrides:
#   OPENVIKING_HOME, OPENVIKING_REPO_DIR, OPENVIKING_REPO_URL,
#   OPENVIKING_REPO_REF / OPENVIKING_REPO_BRANCH, OPENVIKING_CLI_CONFIG_FILE,
#   OPENVIKING_CODEX_WRAP_EXTRA (extra launch commands to wrap).
#   OPENVIKING_REPO_ARCHIVE_URL  when set, fetch the source from this zip instead
#                                of git clone. Requires `unzip`.

set -euo pipefail

OV_HOME="${OPENVIKING_HOME:-$HOME/.openviking}"
REPO_URL="${OPENVIKING_REPO_URL:-https://github.com/MoziaVerse/openviking-plugins.git}"
REPO_DIR="${OPENVIKING_REPO_DIR:-$OV_HOME/openviking-plugins-repo}"
# Accept both OPENVIKING_REPO_REF and OPENVIKING_REPO_BRANCH so users can
# reuse the same env var across the claude-code and codex installers.
REPO_REF="${OPENVIKING_REPO_REF:-${OPENVIKING_REPO_BRANCH:-main}}"
REPO_ARCHIVE_URL="${OPENVIKING_REPO_ARCHIVE_URL:-}"
# Marks a $REPO_DIR populated from an archive (no .git). Lets re-runs refresh it
# safely while refusing to clobber a git checkout or unrelated user data.
ARCHIVE_MARKER='.openviking-archive-source'
MARKETPLACE_NAME="${OPENVIKING_CODEX_MARKETPLACE_NAME:-openviking-plugins-local}"
MARKETPLACE_ROOT="${OPENVIKING_CODEX_MARKETPLACE_ROOT:-$HOME/.codex/${MARKETPLACE_NAME}-marketplace}"
PLUGIN_NAME="openviking-memory"
PLUGIN_ID="${PLUGIN_NAME}@${MARKETPLACE_NAME}"
CODEX_CONFIG="${CODEX_CONFIG_FILE:-$HOME/.codex/config.toml}"
OVCLI_CONF="${OPENVIKING_CLI_CONFIG_FILE:-$OV_HOME/ovcli.conf}"
DEFAULT_MCP_URL="http://127.0.0.1:1933/mcp"
WRAPPER_MARKER_BEGIN="# >>> openviking-codex-plugin >>>"
WRAPPER_MARKER_END="# <<< openviking-codex-plugin <<<"

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

clone_repo() {
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$REPO_DIR"
}

refresh_repo() {
  git -C "$REPO_DIR" fetch --depth 1 origin "$REPO_REF"
  git -C "$REPO_DIR" reset --hard FETCH_HEAD
}

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
  if [ -z "$top" ] || [ ! -d "$top/codex" ]; then
    err '源码归档结构异常：顶层目录中没有 codex/'
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

need() {
  command -v "$1" >/dev/null 2>&1 || { err "缺少必需命令：$1"; exit 1; }
}
need codex
need git
need node

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "需要 Node.js 22+，当前版本是 $(node --version)。"
  exit 1
fi
info "codex：$(codex --version 2>/dev/null || echo 未知)"
info "node:  $(node --version)"

# ----- 2. OpenViking client config -----

heading "2. OpenViking 客户端配置 ($OVCLI_CONF)"

mkdir -p "$OV_HOME"
chmod 700 "$OV_HOME" 2>/dev/null || true

# Read a field from ovcli.conf via node (codex's stack — no jq dependency).
ov_read_conf() {
  [ -f "$OVCLI_CONF" ] || return 0
  node -e '
    try {
      const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const v = c[process.argv[2]];
      if (v) process.stdout.write(String(v));
    } catch {}
  ' "$OVCLI_CONF" "$1" 2>/dev/null || true
}

CURRENT_URL="$(ov_read_conf url)"
CURRENT_KEY="$(ov_read_conf api_key)"

if [ -t 0 ]; then
  # A url with an empty api_key is a valid unauthenticated config, so offer
  # reuse whenever a url exists — don't force the prompt (which would default
  # the url back to localhost and clobber a custom server).
  if [ -n "$CURRENT_URL" ]; then
    info "发现已有配置："
    info "  url     = $CURRENT_URL"
    if [ -n "$CURRENT_KEY" ]; then
      info "  api_key = $(printf '%s' "$CURRENT_KEY" | cut -c1-8)…"
    else
      info "  api_key = （未配置，匿名模式）"
    fi
    ask '复用这些配置？[Y/n] '
    read -r reply || reply=""
    case "$reply" in
      n|N|no|No|NO) CURRENT_URL=""; CURRENT_KEY="" ;;
    esac
  fi

  if [ -z "$CURRENT_URL" ]; then
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
    fi
    # Merge url + api_key into any existing config so extra fields (account,
    # user, …) the codex wrapper reads are preserved.
    node -e '
      const fs = require("node:fs");
      const [, file, url, key] = process.argv;
      let c = {};
      try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      c.url = url;
      c.api_key = key;
      fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
    ' "$OVCLI_CONF" "$CURRENT_URL" "$CURRENT_KEY"
    chmod 600 "$OVCLI_CONF"
    info "已写入 $OVCLI_CONF（权限 0600）"
  else
    info "复用已有配置。"
  fi
else
  if [ -n "$CURRENT_URL" ]; then
    info "非交互模式：使用已有配置 $OVCLI_CONF"
  else
    warn "非交互模式且未找到 $OVCLI_CONF，将以匿名模式继续。"
    warn '请设置 OPENVIKING_URL / OPENVIKING_API_KEY，或在终端中重新运行安装脚本来配置认证。'
  fi
fi

# ----- 3. OpenViking source repository -----

heading "3. OpenViking 插件源码仓库 ($REPO_DIR)"

mkdir -p "$(dirname "$REPO_DIR")" "$HOME/.codex"

if [ -n "$REPO_ARCHIVE_URL" ]; then
  # Archive mode (GitHub-free): refuse to overwrite anything we didn't create.
  if [ -e "$REPO_DIR" ] && [ ! -f "$REPO_DIR/$ARCHIVE_MARKER" ]; then
    err "$REPO_DIR 已存在，且不是由归档安装创建。请移走该目录，或设置 OPENVIKING_REPO_DIR。"
    exit 1
  fi
  fetch_archive "$REPO_ARCHIVE_URL" "$REPO_DIR"
elif [ ! -e "$REPO_DIR/.git" ]; then
  if [ -e "$REPO_DIR" ]; then
    err "$REPO_DIR 已存在，但不是 Git 工作区。"
    exit 1
  fi
  info "正在克隆 $REPO_URL（分支 $REPO_REF，depth 1）"
  clone_repo
else
  info "正在刷新已有工作区（$REPO_REF）"
  refresh_repo
fi

PLUGIN_DIR="$REPO_DIR/codex"
if [ ! -d "$PLUGIN_DIR/.codex-plugin" ]; then
  err "未在 $PLUGIN_DIR 找到 Codex 插件"
  exit 1
fi
CREDS_SCRIPT="$PLUGIN_DIR/scripts/ov-credentials.mjs"
if [ ! -f "$CREDS_SCRIPT" ]; then
  err "未找到凭据解析脚本：$CREDS_SCRIPT"
  exit 1
fi

PLUGIN_VERSION="$(node -e 'const p=require(process.argv[1]); console.log(p.version || "0.0.0")' "$PLUGIN_DIR/.codex-plugin/plugin.json")"

# ----- 4. Plugin install -----

heading "4. 插件安装 ($PLUGIN_ID，版本 $PLUGIN_VERSION)"

# Resolve the OpenViking /mcp endpoint at install time using the same
# credential resolver that hooks and the shell wrapper use. By default the
# active ovcli.conf wins; set OPENVIKING_CREDENTIAL_SOURCE=env to force env.
resolve_mcp_url() {
  OPENVIKING_CLI_CONFIG_FILE="$OVCLI_CONF" node "$CREDS_SCRIPT" mcp-url 2>/dev/null || printf '%s' "$DEFAULT_MCP_URL"
}

MCP_URL="$(resolve_mcp_url)"
info "MCP 地址：$MCP_URL"

mkdir -p "$MARKETPLACE_ROOT/.claude-plugin"
rm -f "$MARKETPLACE_ROOT/$PLUGIN_NAME"
ln -s "$PLUGIN_DIR" "$MARKETPLACE_ROOT/$PLUGIN_NAME"

cat > "$MARKETPLACE_ROOT/.claude-plugin/marketplace.json" <<EOF
{
  "name": "$MARKETPLACE_NAME",
  "plugins": [
    { "name": "$PLUGIN_NAME", "source": "./$PLUGIN_NAME" }
  ]
}
EOF

codex plugin marketplace add "$MARKETPLACE_ROOT" >/dev/null 2>&1 || true
info "已注册插件市场：$MARKETPLACE_ROOT"

node - "$CODEX_CONFIG" "$PLUGIN_ID" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const pluginId = process.argv[3];

let text = "";
try {
  text = fs.readFileSync(path, "utf8");
} catch {
  text = "";
}

function ensureSectionLine(src, section, key, value) {
  const lines = src.split(/\n/);
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const prefix = src.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${header}\n${key} = ${value}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }

  for (let i = start + 1; i < end; i += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return lines.join("\n").replace(/\n*$/, "\n");
    }
  }

  lines.splice(end, 0, `${key} = ${value}`);
  return lines.join("\n").replace(/\n*$/, "\n");
}

function ensurePluginEnabled(src, pluginId) {
  const header = `[plugins."${pluginId}"]`;
  const lines = src.split(/\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const prefix = src.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${header}\nenabled = true\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }

  for (let i = start + 1; i < end; i += 1) {
    if (/^\s*enabled\s*=/.test(lines[i])) {
      lines[i] = "enabled = true";
      return lines.join("\n").replace(/\n*$/, "\n");
    }
  }

  lines.splice(end, 0, "enabled = true");
  return lines.join("\n").replace(/\n*$/, "\n");
}

text = ensurePluginEnabled(text, pluginId);
text = ensureSectionLine(text, "features", "plugin_hooks", "true");

fs.mkdirSync(require("node:path").dirname(path), { recursive: true });
fs.writeFileSync(path, text);
NODE
info "已在 $CODEX_CONFIG 中启用插件和 features.plugin_hooks"

CACHE_DIR="$HOME/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$PLUGIN_VERSION"

# Detect whether the user has an OpenViking API key configured anywhere.
# When they don't (typical for a local unauth OV), we render .mcp.json
# WITHOUT bearer_token_env_var, so Codex doesn't see an empty
# OPENVIKING_API_KEY at MCP launch and trigger its OAuth fallback for
# what should be an unauthenticated server.
detect_api_key() {
  OPENVIKING_CLI_CONFIG_FILE="$OVCLI_CONF" node "$CREDS_SCRIPT" has-api-key 2>/dev/null || echo "0"
}
HAS_API_KEY="$(detect_api_key)"

# Detect whether a peer id is configured. Older/new local setups may not use
# peer-aware identity yet, so validation must accept both header-present and
# header-absent MCP cache output depending on the actual config.
detect_peer_id() {
  OPENVIKING_CLI_CONFIG_FILE="$OVCLI_CONF" node "$CREDS_SCRIPT" has-peer-id 2>/dev/null || echo "0"
}
HAS_PEER_ID="$(detect_peer_id)"

render_plugin_cache() {
  mkdir -p "$(dirname "$CACHE_DIR")"
  rm -rf "$CACHE_DIR"
  cp -R "$PLUGIN_DIR" "$CACHE_DIR"

  # Codex 0.130 does not inject CODEX_PLUGIN_ROOT into hook subprocess env and
  # does not let hooks.json declare a cwd, so relative paths in hooks.json
  # resolve against the user's cwd (typically ~). Render the placeholder
  # __OPENVIKING_PLUGIN_ROOT__ into the cache copy's absolute path. The repo's
  # checked-in hooks.json keeps the placeholder; only the cached copy is
  # rewritten at install time.
  local hooks_json="$CACHE_DIR/hooks/hooks.json"
  if [ -f "$hooks_json" ]; then
    local cache_esc
    cache_esc="$(printf '%s' "$CACHE_DIR" | sed -e 's/[\\/&]/\\&/g')"
    sed -i.bak -e "s/__OPENVIKING_PLUGIN_ROOT__/$cache_esc/g" "$hooks_json"
    rm -f "${hooks_json}.bak"
  fi

  # Render the OpenViking /mcp URL into the cached .mcp.json (and drop the
  # bearer_token_env_var line in no-auth mode). The repo's checked-in
  # .mcp.json keeps the placeholder + always-present bearer field; the cache
  # copy is what Codex actually loads.
  local mcp_json="$CACHE_DIR/.mcp.json"
  if [ -f "$mcp_json" ]; then
    OPENVIKING_CLI_CONFIG_FILE="$OVCLI_CONF" OPENVIKING_MCP_URL="$MCP_URL" \
      node "$CREDS_SCRIPT" sync-mcp "$mcp_json"
  fi
}

render_plugin_cache
info "插件缓存：$CACHE_DIR"
info "MCP 认证：$([ "$HAS_API_KEY" = "1" ] && echo "Bearer（OPENVIKING_API_KEY）" || echo "无认证（匿名模式）")"

# ----- 5. Shell rc wrapper -----
#
# The MCP server reads OPENVIKING_API_KEY (and OPENVIKING_ACCOUNT / _USER /
# _PEER_ID) from the process env at codex launch. Install a `codex` shell
# function that pulls these from ovcli.conf at invocation time, so the user
# doesn't have to `export` secrets globally.
#
# Source of truth: setup-helper/wrapper.sh in the plugin checkout. The user's
# shell rc just sources that file directly — no copy step, so any updates land
# via the next `git fetch + reset --hard` the installer runs at the top.

heading '5. Shell 配置 — codex 函数包装'

WRAPPER_SRC="$PLUGIN_DIR/setup-helper/wrapper.sh"
if [ ! -f "$WRAPPER_SRC" ]; then
  err "未找到 wrapper 源文件：$WRAPPER_SRC"
  exit 1
fi

case "${SHELL:-}" in
  */zsh)  RC="$HOME/.zshrc" ;;
  */bash) RC="$HOME/.bashrc" ;;
  *)
    if   [ -f "$HOME/.zshrc" ];  then RC="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then RC="$HOME/.bashrc"
    else RC=""; fi
    ;;
esac

read_marker_export() {
  local key="$1"
  [ -n "$RC" ] && [ -f "$RC" ] || return 0
  awk -v k="$key" -F"'" '
    $0 ~ "^export " k "=" { print $2; exit }
    $0 ~ "^" k "=" { print $2; exit }
  ' "$RC" 2>/dev/null || true
}

sanitize_marker_value() {
  printf '%s' "$1" | tr -d '\r\n' | sed "s/'//g"
}

RECALL_COMPRESS_SETTING="$(sanitize_marker_value "${OPENVIKING_RECALL_COMPRESS:-$(read_marker_export OPENVIKING_RECALL_COMPRESS)}")"
RECALL_COMPRESS_MODEL_SETTING="$(sanitize_marker_value "${OPENVIKING_RECALL_COMPRESS_MODEL:-$(read_marker_export OPENVIKING_RECALL_COMPRESS_MODEL)}")"
RECALL_COMPRESS_THINKING_SETTING="$(sanitize_marker_value "${OPENVIKING_RECALL_COMPRESS_THINKING:-$(read_marker_export OPENVIKING_RECALL_COMPRESS_THINKING)}")"

if [ -t 0 ]; then
  info '召回压缩配置：每次 Codex SessionStart 自动检测，并缓存给后续 UserPromptSubmit hooks 使用。'
  info '自动降级顺序：已配置模型/思考强度 -> gpt-5.3-codex-spark/default -> gpt-5.5/low -> 关闭。'
  if [ -n "$RECALL_COMPRESS_SETTING$RECALL_COMPRESS_MODEL_SETTING$RECALL_COMPRESS_THINKING_SETTING" ]; then
    info "当前召回压缩环境变量：compress=${RECALL_COMPRESS_SETTING:-auto} model=${RECALL_COMPRESS_MODEL_SETTING:-auto} thinking=${RECALL_COMPRESS_THINKING_SETTING:-auto}"
    ask '召回压缩 [k=保留, a=自动, c=自定义, o=关闭；默认 k]：'
    read -r RECALL_INPUT || RECALL_INPUT=""
    RECALL_INPUT="${RECALL_INPUT:-k}"
  else
    ask '召回压缩 [a=自动, c=自定义, o=关闭；默认 a]：'
    read -r RECALL_INPUT || RECALL_INPUT=""
    RECALL_INPUT="${RECALL_INPUT:-a}"
  fi
  case "$RECALL_INPUT" in
    k|K|keep|KEEP)
      :
      ;;
    o|O|off|OFF)
      RECALL_COMPRESS_SETTING="0"
      RECALL_COMPRESS_MODEL_SETTING=""
      RECALL_COMPRESS_THINKING_SETTING=""
      ;;
    c|C|custom|CUSTOM)
      ask '压缩模型 [gpt-5.3-codex-spark]：'
      read -r RECALL_MODEL_INPUT || RECALL_MODEL_INPUT=""
      ask '压缩模型思考/推理强度 [default]：'
      read -r RECALL_THINKING_INPUT || RECALL_THINKING_INPUT=""
      RECALL_COMPRESS_SETTING="1"
      RECALL_COMPRESS_MODEL_SETTING="$(sanitize_marker_value "${RECALL_MODEL_INPUT:-gpt-5.3-codex-spark}")"
      RECALL_COMPRESS_THINKING_SETTING="$(sanitize_marker_value "${RECALL_THINKING_INPUT:-default}")"
      ;;
    *)
      RECALL_COMPRESS_SETTING=""
      RECALL_COMPRESS_MODEL_SETTING=""
      RECALL_COMPRESS_THINKING_SETTING=""
      ;;
  esac
fi

# Extra launch commands to wrap besides `codex` — e.g. a custom wrapper
# `codex-custom`, or a multi-word launcher matched on its sub-command.
# Persisted in the rc marker block as OPENVIKING_CODEX_WRAP_EXTRA; the wrapper
# reads it and injects credentials into matching invocations only.
# Seed from this run's env var (automation), else the rc value (re-run). The
# interactive prompt below (TTY only) can override.
WRAP_EXTRA="${OPENVIKING_CODEX_WRAP_EXTRA:-}"
if [ -z "$WRAP_EXTRA" ] && [ -n "$RC" ] && [ -f "$RC" ]; then
  WRAP_EXTRA=$(awk -F"'" '/^OPENVIKING_CODEX_WRAP_EXTRA=/{print $2; exit}' "$RC" 2>/dev/null || true)
fi
if [ -z "${OPENVIKING_CODEX_WRAP_EXTRA:-}" ] && [ -t 0 ]; then
  info '是否也为其他启动命令注入 OpenViking 凭据？例如自定义 wrapper `codex-custom`。'
  info '多词启动器会按子命令匹配；该命令的其他用法会原样放行。'
  if [ -n "$WRAP_EXTRA" ]; then
    info "当前配置：$WRAP_EXTRA"
    ask '命令列表（用 ; 分隔；留空=保留，- =清空）：'
  else
    ask '命令列表（用 ; 分隔，例如 "codex-custom"；留空=跳过）：'
  fi
  read -r WRAP_INPUT || WRAP_INPUT=""
  case "$WRAP_INPUT" in
    "") : ;;
    -)  WRAP_EXTRA="" ;;
    *)  WRAP_EXTRA="$WRAP_INPUT" ;;
  esac
fi
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

RECALL_ENV_BLOCK=""
if [ -n "$RECALL_COMPRESS_SETTING" ]; then
  RECALL_ENV_BLOCK="${RECALL_ENV_BLOCK}export OPENVIKING_RECALL_COMPRESS='$RECALL_COMPRESS_SETTING'
"
fi
if [ -n "$RECALL_COMPRESS_MODEL_SETTING" ]; then
  RECALL_ENV_BLOCK="${RECALL_ENV_BLOCK}export OPENVIKING_RECALL_COMPRESS_MODEL='$RECALL_COMPRESS_MODEL_SETTING'
"
fi
if [ -n "$RECALL_COMPRESS_THINKING_SETTING" ]; then
  RECALL_ENV_BLOCK="${RECALL_ENV_BLOCK}export OPENVIKING_RECALL_COMPRESS_THINKING='$RECALL_COMPRESS_THINKING_SETTING'
"
fi

# The hook content stays stable across installs (only the absolute path
# matters), so the marker-replacement logic only triggers the legacy cleanup
# path once when upgrading from a pre-rc-split install that inlined the full
# wrapper into the rc.
SOURCE_HOOK="[ -f \"$WRAPPER_SRC\" ] && . \"$WRAPPER_SRC\""
if [ -n "$WRAP_EXTRA" ]; then
  SOURCE_BLOCK="$WRAPPER_MARKER_BEGIN
${RECALL_ENV_BLOCK}OPENVIKING_CODEX_WRAP_EXTRA='$WRAP_EXTRA'
$SOURCE_HOOK
$WRAPPER_MARKER_END"
else
  SOURCE_BLOCK="$WRAPPER_MARKER_BEGIN
${RECALL_ENV_BLOCK}$SOURCE_HOOK
$WRAPPER_MARKER_END"
fi

if [ -z "$RC" ]; then
  warn '未检测到 shell rc 文件。请手动把下面片段加入你的 rc 文件：'
  warn ''
  while IFS= read -r line; do warn "  $line"; done <<EOF
$SOURCE_BLOCK
EOF
else
  touch "$RC"
  if grep -qF "$WRAPPER_MARKER_BEGIN" "$RC"; then
    # Strip the existing marker block (whether it's the new one-liner or an
    # old inline-wrapper block from a previous version). Both markers must be
    # present — refuse the in-place rewrite otherwise.
    if grep -qF "$WRAPPER_MARKER_END" "$RC"; then
      info "正在替换 $RC 中的 OpenViking 加载片段"
      awk -v b="$WRAPPER_MARKER_BEGIN" -v e="$WRAPPER_MARKER_END" '
        $0 == b {skip=1; next}
        $0 == e {skip=0; next}
        !skip
      ' "$RC" > "$RC.tmp" && mv "$RC.tmp" "$RC"
    else
      warn "在 $RC 中找到了 $WRAPPER_MARKER_BEGIN，但缺少 $WRAPPER_MARKER_END。"
      warn '为避免误改，跳过原地重写，并追加新的 OpenViking 加载片段。'
      warn '请稍后手动删除残留的开始标记。'
    fi
  else
    info "正在向 $RC 追加 OpenViking 加载片段"
  fi
  printf '\n%s\n' "$SOURCE_BLOCK" >> "$RC"
fi

if [ ! -f "$OVCLI_CONF" ] && [ "$HAS_API_KEY" != "1" ]; then
  warn "未找到 $OVCLI_CONF，环境变量中也没有 OPENVIKING_API_KEY。"
  warn "已按匿名模式安装，目标 MCP 地址：$MCP_URL。"
  warn '如需稍后启用 Bearer 认证，请创建包含 api_key 的 ovcli.conf 后重新运行安装脚本。'
fi

validate_plugin_install() {
  local issues=()
  local marketplace_link="$MARKETPLACE_ROOT/$PLUGIN_NAME"
  local hooks_json="$CACHE_DIR/hooks/hooks.json"
  local mcp_json="$CACHE_DIR/.mcp.json"

  if [ ! -L "$marketplace_link" ] || [ "$(readlink "$marketplace_link" 2>/dev/null || true)" != "$PLUGIN_DIR" ]; then
    issues+=("插件市场软链接未指向 $PLUGIN_DIR")
  fi
  # Codex has printed both `installed, enabled` and `(installed, enabled)`
  # across versions; accept either to avoid false-negative install failures.
  if ! codex plugin list 2>/dev/null | grep -E -q "${PLUGIN_ID}[[:space:]]+\(?installed, enabled\)?"; then
    issues+=("codex plugin list 未显示 $PLUGIN_ID 为 installed, enabled")
  fi
  if [ ! -d "$CACHE_DIR" ]; then
    issues+=("插件缓存目录缺失：$CACHE_DIR")
  fi
  if [ ! -f "$hooks_json" ]; then
    issues+=("缓存中的 hooks.json 缺失")
  else
    grep -q "__OPENVIKING_PLUGIN_ROOT__" "$hooks_json" && issues+=("缓存中的 hooks.json 仍包含 __OPENVIKING_PLUGIN_ROOT__")
    grep -q "$CACHE_DIR/scripts/session-start-commit.mjs" "$hooks_json" || issues+=("SessionStart hook 路径未渲染到缓存目录")
    grep -q '"matcher": "clear|startup|resume"' "$hooks_json" || issues+=("SessionStart matcher 不是 clear|startup|resume")
    grep -q '"timeout": 70' "$hooks_json" || issues+=("SessionStart timeout 不是 70 秒")
    grep -q '"timeout": 130' "$hooks_json" || issues+=("UserPromptSubmit timeout 不是 130 秒")
  fi
  if [ ! -f "$mcp_json" ]; then
    issues+=("缓存中的 .mcp.json 缺失")
  else
    grep -q "__OPENVIKING_MCP_URL__" "$mcp_json" && issues+=("缓存中的 .mcp.json 仍包含 __OPENVIKING_MCP_URL__")
    if [ "$HAS_API_KEY" != "1" ] && grep -q "bearer_token_env_var" "$mcp_json"; then
      issues+=("未配置 API key，但缓存中的 .mcp.json 仍保留 bearer_token_env_var")
    fi
    if [ "$HAS_PEER_ID" = "1" ] && ! grep -q '"X-OpenViking-Actor-Peer"' "$mcp_json"; then
      issues+=("已配置 peer，但缓存中的 .mcp.json 缺少 X-OpenViking-Actor-Peer header 映射")
    fi
    if [ "$HAS_PEER_ID" != "1" ] && grep -q '"X-OpenViking-Actor-Peer"' "$mcp_json"; then
      issues+=("未配置 peer，但缓存中的 .mcp.json 仍保留 X-OpenViking-Actor-Peer")
    fi
  fi

  for script in \
    auto-recall.mjs \
    auto-capture.mjs \
    pre-compact-capture.mjs \
    session-start-commit.mjs \
    recall-compressor-profile.mjs \
    config.mjs
  do
    if [ ! -f "$CACHE_DIR/scripts/$script" ]; then
      issues+=("缓存脚本缺失：scripts/$script")
    elif ! node --check "$CACHE_DIR/scripts/$script" >/dev/null 2>&1; then
      issues+=("缓存脚本未通过 node --check：scripts/$script")
    fi
  done

  if [ "${#issues[@]}" -eq 0 ]; then
    return 0
  fi
  for issue in "${issues[@]}"; do
    warn "安装校验：$issue"
  done
  return 1
}

reset_plugin_cache_setup() {
  rm -f "$MARKETPLACE_ROOT/$PLUGIN_NAME"
  ln -s "$PLUGIN_DIR" "$MARKETPLACE_ROOT/$PLUGIN_NAME"
  codex plugin marketplace add "$MARKETPLACE_ROOT" >/dev/null 2>&1 || true
  render_plugin_cache
}

heading '6. 安装校验'
if validate_plugin_install; then
  info '插件安装校验通过。'
else
  if [ -t 0 ]; then
    ask '重置/重装插件软链接和缓存后再校验一次？[Y/n] '
    read -r RESET_REPLY || RESET_REPLY=""
    case "$RESET_REPLY" in
      n|N|no|No|NO)
        err '插件安装校验失败。使用 Codex 前，请重新运行安装脚本或重置插件缓存。'
        exit 1
        ;;
      *)
        info '正在重置插件软链接和缓存。'
        reset_plugin_cache_setup
        if validate_plugin_install; then
          info '重置后插件安装校验通过。'
        else
          err '重置后插件安装校验仍失败。请清理插件配置后重新运行安装脚本。'
          exit 1
        fi
        ;;
    esac
  else
    err '非交互模式下插件安装校验失败。请交互式重新运行以重置，或清理插件缓存后重新安装。'
    exit 1
  fi
fi

# ----- Done -----

heading '安装完成'
info "插件：      $PLUGIN_ID（版本 $PLUGIN_VERSION）"
info "配置文件：  $OVCLI_CONF"
info "MCP：       $MCP_URL（$([ "$HAS_API_KEY" = "1" ] && echo "Bearer 认证" || echo "匿名模式")）"
[ -n "$RC" ] && info "Shell 配置：  $RC"
printf '\n'
if [ -n "$RC" ]; then
  printf '%s%s下一步：在当前 shell 中执行下面命令，让 codex() wrapper 生效：%s\n' "$BOLD" "$YELLOW" "$RESET"
  printf '    %s%ssource %s%s\n' "$BOLD" "$CYAN" "$RC" "$RESET"
  printf '  （也可以直接打开一个新的终端窗口）\n\n'
else
  printf '  （请把上面打印的片段粘贴到 shell rc 中，然后重启 shell）\n\n'
fi
info '然后：'
info '  codex               # 启动 Codex；如出现提示，请检查 /hooks'
