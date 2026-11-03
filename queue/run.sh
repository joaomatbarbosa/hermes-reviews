#!/usr/bin/env bash
# Daily headless run of the review-queue skill (shipped by hermes-reviews: queue/run.sh, installed by scripts/install.sh). Triggered by launchd at login, daily at 09:00, and on wake if 09:00 was missed.
# Runs at most once per day, and only on weekdays, unless invoked with --force.

set -euo pipefail

QUEUE_DIR="$HOME/review-queue"
STAMP="$QUEUE_DIR/.last-run"
TODAY="$(date +%F)"
LOG="$QUEUE_DIR/logs/$TODAY.log"

export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$QUEUE_DIR/logs"

if [[ "${1:-}" != "--force" && "${1:-}" != "--improve" ]]; then
  [[ "$(date +%u)" -gt 5 ]] && exit 0
  [[ -f "$STAMP" && "$(cat "$STAMP")" == "$TODAY" ]] && exit 0
fi

# Wait up to 5 minutes for network and GitHub auth after login or wake.
for _ in $(seq 1 30); do
  gh api user --jq .login >/dev/null 2>&1 && break
  sleep 10
done

notify() {
  osascript -e "display notification \"$1\" with title \"Review queue\"" >/dev/null 2>&1 || true
}

ALLOWED_TOOLS=(
  "Read" "Glob" "Grep" "Agent" "Skill"
  "Edit(/$HOME/review-queue/**)"
  "Bash(gh pr view:*)" "Bash(gh pr diff:*)" "Bash(gh search prs:*)"
  "Bash(gh api --method GET:*)"
  "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql"
  "mcp__claude_ai_Atlassian__getJiraIssue"
)

cd "$QUEUE_DIR"

# Mondays: distill last week's feedback into learnings.md before the daily run, so today's reviews already use it.
if [[ "$(date +%u)" -eq 1 || "${1:-}" == "--improve" ]]; then
  claude -p "/review-queue improve" \
    --model claude-opus-5-5 \
    --permission-mode dontAsk \
    --allowedTools "${ALLOWED_TOOLS[@]}" \
    >>"$LOG" 2>&1 || notify "Weekly improve step failed, see logs/$TODAY.log"
fi

if claude -p "/review-queue run" \
  --model claude-opus-5-5 \
  --permission-mode dontAsk \
  --allowedTools "${ALLOWED_TOOLS[@]}" \
  >>"$LOG" 2>&1 \
  && [[ -f "$QUEUE_DIR/latest.md" && "$(date -r "$QUEUE_DIR/latest.md" +%F)" == "$TODAY" ]]; then
  echo "$TODAY" >"$STAMP"
  SUMMARY="$(tail -n 1 "$QUEUE_DIR/latest.md" 2>/dev/null || echo 'done')"
  # The legacy HTML dashboard, when this machine still has it; otherwise the Reviews page in Hermes shows the queue.
  if [[ -f "$QUEUE_DIR/dashboard.js" ]]; then
    node "$QUEUE_DIR/dashboard.js" >>"$LOG" 2>&1 && open "$QUEUE_DIR/dashboard.html"
    notify "$SUMMARY: dashboard opened in your browser"
  else
    notify "$SUMMARY: open Reviews in Hermes"
  fi
else
  notify "Run failed, see logs/$TODAY.log"
  exit 1
fi
