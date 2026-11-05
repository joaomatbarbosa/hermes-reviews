#!/usr/bin/env bash
# Headless run of the review-queue skill, on demand (the Reviews page buttons, or by hand). Nothing schedules it.
# Shipped by hermes-reviews: queue/run.sh, installed by scripts/install.sh.
#
#   run.sh [--scope co]    run now; --scope co only reviews tickets in the codeowner review status
#   run.sh --improve       also distill last week's feedback into learnings.md first

set -euo pipefail

QUEUE_DIR="$HOME/review-queue"
STAMP="$QUEUE_DIR/.last-run"
TODAY="$(date +%F)"
LOG="$QUEUE_DIR/logs/$TODAY.log"

export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$QUEUE_DIR/logs"

SCOPE=""
IMPROVE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --improve) IMPROVE=1; shift ;;
    --force) shift ;;  # accepted for older callers: every run is forced now
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$SCOPE" in ""|co) ;; *) echo "unknown scope: $SCOPE" >&2; exit 2 ;; esac
RUN_PROMPT="/review-queue run${SCOPE:+ $SCOPE}"

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

# The first run on a Monday distills last week's feedback into learnings.md, so that run's reviews already use it.
if [[ "$IMPROVE" == 1 || ( "$(date +%u)" -eq 1 && ! ( -f "$STAMP" && "$(cat "$STAMP")" == "$TODAY" ) ) ]]; then
  claude -p "/review-queue improve" \
    --model claude-opus-5-5 \
    --permission-mode dontAsk \
    --allowedTools "${ALLOWED_TOOLS[@]}" \
    >>"$LOG" 2>&1 || notify "Weekly improve step failed, see logs/$TODAY.log"
fi

if claude -p "$RUN_PROMPT" \
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
