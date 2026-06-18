#!/usr/bin/env bash
set -euo pipefail

OV_HOME="${OPENVIKING_HOME:-$HOME/.openviking}"
REPO_DIR="${OPENVIKING_REPO_DIR:-$OV_HOME/openviking-plugins-repo}"
PLUGIN_DIR="$REPO_DIR/claude"
MARKETPLACE_NAME="openviking-plugins-local"
PLUGIN_ID="claude-code-memory-plugin@openviking-plugins-local"
SETTINGS_FILE="$HOME/.claude/settings.json"
MARKER_BEGIN='# >>> openviking claude-code memory plugin >>>'
MARKER_END='# <<< openviking claude-code memory plugin <<<'

DRY_RUN=0
REMOVE_REPO=0
REMOVE_DATA=0

usage() {
  cat <<EOF
OpenViking Claude Code 插件卸载器

用法：
  bash <(curl -fsSL https://raw.githubusercontent.com/MoziaVerse/openviking-plugins/main/claude/setup-helper/uninstall.sh)

选项：
  --dry-run      只打印计划执行的操作，不实际修改。
  --remove-repo  同时删除 ~/.openviking/openviking-plugins-repo。
  --remove-data  允许 Claude 删除插件本地持久化数据。
  -h, --help     显示帮助。

默认保留 Claude 插件本地数据、~/.openviking/ovcli.conf 和 OpenViking 服务端数据。
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
    --remove-data)
      REMOVE_DATA=1
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

clean_claude_settings() {
  [ -f "$SETTINGS_FILE" ] || return 0
  if [[ "$DRY_RUN" == "1" ]]; then
    info "将清理 $SETTINGS_FILE 中的 OpenViking legacy hooks/statusline（如存在）"
    return 0
  fi
  node - "$SETTINGS_FILE" "$PLUGIN_DIR" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const pluginDir = process.argv[3];
let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
const needles = [
  `${pluginDir}/scripts/`,
  "openviking-plugins-repo/claude/scripts/",
];
const hits = (value) => typeof value === "string" && needles.some((needle) => value.includes(needle));

if (cfg.statusLine && hits(cfg.statusLine.command)) {
  delete cfg.statusLine;
}

if (cfg.hooks && typeof cfg.hooks === "object") {
  for (const event of Object.keys(cfg.hooks)) {
    if (!Array.isArray(cfg.hooks[event])) continue;
    cfg.hooks[event] = cfg.hooks[event]
      .map((group) => {
        if (!group || !Array.isArray(group.hooks)) return group;
        return {
          ...group,
          hooks: group.hooks.filter((hook) => !hits(hook && hook.command)),
        };
      })
      .filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
  }
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
}

fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
NODE
  info "已清理 $SETTINGS_FILE 中的 OpenViking legacy hooks/statusline"
}

if command -v claude >/dev/null 2>&1; then
  if [[ "$REMOVE_DATA" == "1" ]]; then
    run_or_print claude plugin uninstall "$PLUGIN_ID"
  else
    run_or_print claude plugin uninstall --keep-data "$PLUGIN_ID"
  fi
  run_or_print claude plugin marketplace remove "$MARKETPLACE_NAME"
  run_or_print claude mcp remove openviking -s user
else
  warn "未找到 claude CLI，跳过 CLI 卸载步骤。"
fi

clean_claude_settings
strip_marker_block "$HOME/.zshrc" "$MARKER_BEGIN" "$MARKER_END"
strip_marker_block "$HOME/.bashrc" "$MARKER_BEGIN" "$MARKER_END"

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
