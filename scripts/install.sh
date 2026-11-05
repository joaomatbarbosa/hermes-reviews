#!/usr/bin/env bash
# Set up hermes-reviews on this machine. Safe to re-run: every step checks before it changes anything.
#
#   scripts/install.sh              skills for Claude Code + the ~/review-queue folder + enable the Hermes plugin
#   scripts/install.sh --schedule   also the hourly no-LLM watcher (launchd). Reviews run on demand, never on a schedule
#   scripts/install.sh --check      report what is missing, change nothing
#
# Run it from the plugin's own checkout (a clone in ~/.hermes/plugins/reviews, or a checkout linked there).

set -euo pipefail

PLUGIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
QUEUE="$HOME/review-queue"
CLAUDE_SKILLS="$HOME/.claude/skills"
HH="${HERMES_HOME:-$HOME/.hermes}"
LAUNCH="$HOME/Library/LaunchAgents"
MODE="install"
SCHEDULE=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --schedule) SCHEDULE=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

problems=0
say() { printf '  %s\n' "$*"; }
todo() { printf '  ✗ %s\n' "$*"; problems=$((problems + 1)); }
ok() { printf '  ✓ %s\n' "$*"; }
doing() { [[ "$MODE" == "install" ]]; }

echo "hermes-reviews at $PLUGIN"

echo "Prerequisites"
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && ok "gh is logged in" || todo "gh missing or not logged in (brew install gh && gh auth login)"
command -v claude >/dev/null && ok "claude CLI found (runs the reviews)" || todo "claude CLI not found (the headless run needs Claude Code)"
command -v hermes >/dev/null && ok "hermes CLI found" || say "hermes CLI not found: enable the plugin from Hermes Desktop instead"

echo "Skills"
mkdir -p "$CLAUDE_SKILLS"
for dir in "$PLUGIN"/skills/*/; do
  name="$(basename "$dir")"
  src="${dir%/}"
  dst="$CLAUDE_SKILLS/$name"
  if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    ok "$name linked for Claude Code"
    continue
  fi
  if doing; then
    if [[ -e "$dst" || -L "$dst" ]]; then
      mkdir -p "$CLAUDE_SKILLS/.trash"
      bak="$CLAUDE_SKILLS/.trash/$name-$(date +%Y%m%d-%H%M%S)"
      mv "$dst" "$bak"
      say "moved the old $name aside: $bak"
    fi
    ln -s "$src" "$dst"
    ok "$name linked for Claude Code ($dst -> $src)"
  else
    todo "$name is not linked into $CLAUDE_SKILLS"
  fi
done
say "Hermes loads them from the plugin itself: reviews:review-queue, reviews:codeowner-review"

echo "Queue folder"
if [[ -d "$QUEUE" ]]; then ok "$QUEUE exists"; elif doing; then mkdir -p "$QUEUE/drafts" "$QUEUE/logs"; ok "created $QUEUE"; else todo "$QUEUE missing"; fi
if [[ -f "$QUEUE/run.sh" ]]; then
  cmp -s "$QUEUE/run.sh" "$PLUGIN/queue/run.sh" && ok "run.sh is the shipped one" || say "run.sh exists and differs from queue/run.sh (kept as is)"
elif doing; then
  install -m 755 "$PLUGIN/queue/run.sh" "$QUEUE/run.sh"; ok "installed $QUEUE/run.sh"
else
  todo "$QUEUE/run.sh missing"
fi
doing && mkdir -p "$QUEUE/logs"
if [[ -f "$QUEUE/config.md" ]]; then
  grep -q '<[a-zA-Z ]*>' "$QUEUE/config.md" && todo "$QUEUE/config.md still has <...> placeholders" || ok "config.md filled in"
elif doing; then
  cp "$PLUGIN/queue/config.example.md" "$QUEUE/config.md"; todo "created $QUEUE/config.md: fill in its <...> values"
else
  todo "$QUEUE/config.md missing (copy queue/config.example.md)"
fi

echo "Hermes plugin"
if command -v hermes >/dev/null; then
  if hermes plugins list 2>/dev/null | grep -E "^│ reviews " | grep -q enabled; then
    ok "reviews plugin enabled"
  elif doing; then
    hermes plugins enable reviews >/dev/null && ok "enabled the reviews plugin (restart the gateway to load its backend)"
  else
    todo "reviews plugin not enabled (hermes plugins enable reviews)"
  fi
fi
[[ -d "$HH/plugins/reviews" ]] || say "note: $HH/plugins/reviews does not exist; install with: hermes plugins install https://github.com/joaomatbarbosa/hermes-reviews"

render() { sed -e "s#__HOME__#$HOME#g" -e "s#__PLUGIN__#$PLUGIN#g" "$1"; }

load_job() {
  local label="$1" plist="$LAUNCH/$1.plist" src="$PLUGIN/scripts/launchd/$1.plist"
  if [[ -f "$plist" ]] && cmp -s "$plist" <(render "$src"); then
    ok "$label installed"
    return
  fi
  if doing; then
    mkdir -p "$LAUNCH"
    render "$src" >"$plist"
    launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    ok "$label installed and loaded"
  else
    todo "$label not installed (--schedule)"
  fi
}

echo "Schedule"
if [[ "$SCHEDULE" == 1 || "$MODE" == "check" ]]; then
  load_job com.hermes-reviews.watch
else
  say "skipped (pass --schedule for the hourly watcher)"
fi

if [[ "$MODE" == "check" ]]; then
  [[ "$problems" == 0 ]] && echo "All set." || { echo "$problems thing(s) to fix: run scripts/install.sh"; exit 1; }
else
  echo "Done. Restart the Hermes gateway (or Hermes Desktop) so the backend and skills load."
fi
