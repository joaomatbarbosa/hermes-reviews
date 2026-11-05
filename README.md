# hermes-reviews

Everything the PR review queue needs, in one Hermes plugin:

- the **`review-queue`** skill (finds the PRs to review, drafts reviews, posts them only when you say so) and the
  **`codeowner-review`** skill it reviews with;
- a **Reviews** page for Hermes Desktop that reads the drafts in `~/review-queue`, shows each PR's live GitHub state
  and lets you triage the queue;
- **`rq-watch`**, an hourly watcher that uses no LLM: it archives reviews whose PR merged or closed, and tells you
  when a draft went stale;
- the headless run (`queue/run.sh`), started on demand from the Reviews page ("Run the reviews", "Run codeowner review only"), and the launchd job for the watcher. Nothing runs reviews on a schedule.

Your org's values (Jira cloudId, ticket JQL, GitHub org and login) live in `~/review-queue/config.md`, and team-specific
review rules in an optional `~/review-queue/conventions.md`. Neither is in this repo; `install.sh` seeds the config
from `queue/config.example.md`.

## Install on a new machine

```sh
gh auth login                                  # once; the queue reads PRs through gh
hermes plugins install https://github.com/joaomatbarbosa/hermes-reviews
hermes plugins enable reviews
~/.hermes/plugins/reviews/scripts/install.sh --schedule
```

Then restart Hermes Desktop (or the gateway) and turn the Desktop half on in Capabilities → Plugins if it is off.

`install.sh` is idempotent. It checks `gh` and the `claude` CLI, links both skills into `~/.claude/skills` for Claude
Code (an existing copy is moved to `~/.claude/skills/.trash`), creates `~/review-queue` with `run.sh` and `config.md`, enables the
plugin, and with `--schedule` loads the hourly watcher (launchd). `install.sh --check` reports what is missing without changing anything.

Hermes loads the skills from the plugin as `reviews:review-queue` and `reviews:codeowner-review`; Claude Code sees
the same files through the links. One copy, so a fix lands in both.

## The Reviews page

Drafts follow one report shape (defined in `codeowner-review`, "Review report format"): **Verdict**, **Impact**
(what the change can reach, with a confidence per area), **At a glance**, **Findings** (blocker / major / minor / nit),
**What the PR does**, **Next steps**, **Evidence** (collapsed), then the two sections that get posted. The header
shows the verdict, risk and finding counts. Older drafts keep their own sections and still render.

- **Triage.** Mark a review **Merged**, **Dismiss** it (with an optional reason), or mark it **Posted** when you
  posted it yourself. Archived reviews can be restored. Every change shows a toast with **Undo**.
- **Live GitHub state** (via `gh`, cached 5 minutes): badges for *merged / closed on GitHub*, *stale* (the head moved
  since the draft: new commits, or rebased), *approved* by someone else, *checks failing*, *draft*. A stale draft gets a
  warning and a **Re-review in chat** button.
- **Archive what's already gone.** A banner lists pending reviews whose PR is merged or closed, with **Archive** and
  **Always** (auto-archive from then on; turn it off from the footer). A posted review leaves the list only after
  the skill has harvested its outcome, so the learning loop keeps it.
- **Bulk and keyboard.** Tick rows (or ⌘/⇧-click) for bulk Merged / Dismiss. Keys: `j`/`k` move, `x` select,
  `m` merged, `e` dismiss, `p` posted, `u` undo, `o` open PR, `/` search, `r` re-check GitHub, `Esc` clear.
- **Post in chat.** Opens a new chat with a prompt that posts the review through the skill. The prompt is typed
  in but not sent, and the skill shows the exact text before posting anything.
- **Review chat.** When the board recorded the PR's Claude Code session (`chat` in `state.json`), copies the
  `claude --resume` command that reopens it, from the right folder.
- **Digest.** The notebook button shows `latest.md`.
- The status-bar count leaves out PRs that are already merged or closed.

## rq-watch

`scripts/rq-watch.py [--archive] [--quiet] [--dry-run]`, stdlib only, so it runs on macOS's `/usr/bin/python3`.
Each run reads every open entry's PR with `gh` and stays silent unless something changed since the last run (kept in
`~/review-queue/.watch.json`). Then it sends one notification: drafts that went stale, PRs that merged or closed.
With `--archive` (what the launchd job passes) it also archives the merged/closed ones, exactly as the page does,
tagged `"source": "reviews-watch"`. Logs: `~/review-queue/logs/watch.log`. To stop archiving, drop `--archive` from
`~/Library/LaunchAgents/com.hermes-reviews.watch.plist`, or unload the job:
`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.hermes-reviews.watch.plist`.

## How it writes

Only one thing writes to the queue: `apply_status` (in `dashboard/reviews_core.py`), used by `POST /status` and by
`rq-watch`. It sets `status` plus a few bookkeeping fields (`prevStatus`, `statusAt`, `statusSource`,
`statusEventId`, `statusReason`, `mergedBy`/`postedBy`), using the skill's own status names (`pending`, `posted`,
`discarded`, `merged`, `closed`), so `/review-queue run` keeps working as before: a dismissed (`discarded`) draft is
skipped until new commits land, then re-reviewed (only the change).

Each change also appends a `feedback.jsonl` event in the skill's format (`decision` with `MERGED` / `CLOSED` /
`DISCARD`, or a `note`), so the weekly `improve` step learns from what you dismiss and why. Undo removes that event
again rather than logging a counter-event.

Writes take a lock, re-read `state.json`, change only the named entries and rename a temp file into place, so a
concurrent headless run's work is never overwritten with a stale copy.

## Layout

| Path | What |
|---|---|
| `skills/review-queue/`, `skills/codeowner-review/` | The two skills |
| `queue/config.example.md` | Template for `~/review-queue/config.md`: Jira cloudId, JQL, GitHub org and login |
| `desktop/plugin.js` | The page: route + sidebar row, status-bar count, ⌘K commands. Plain ESM, no JSX, theme variables only |
| `dashboard/reviews_core.py` | The queue logic, stdlib only: read models, live `gh` state, `apply_status`, chat lookup |
| `dashboard/plugin_api.py` | The backend under `/api/plugins/reviews`: `GET /queue`, `/draft?key=`, `/live[?refresh=1]`, `/chat?key=`, `POST /status {keys, status, reason?}` |
| `scripts/rq-watch.py` | The no-LLM watcher |
| `scripts/install.sh` | Machine setup (skills, queue folder, plugin, launchd) |
| `scripts/launchd/` | The launchd job template for the watcher |
| `queue/run.sh` | The headless `/review-queue run [co]`, on demand |
| `__init__.py`, `plugin.yaml`, `dashboard/manifest.json` | What Hermes needs to register the skills and mount the page |

Environment: `REVIEW_DIR` overrides the folder (default `~/review-queue`); `REVIEW_GH_OWNER` is the GitHub owner used
when a draft has no PR URL (default: `GitHub org` in `config.md`). Live state needs `gh` logged in; the backend also looks in mise shims
and Homebrew, since the gateway and launchd start with a bare `PATH`.

## Develop

Link a checkout instead of a clone, so the Desktop re-syncs the page on every save:

```sh
ln -s "$PWD" ~/.hermes/plugins/reviews
hermes plugins enable reviews
```

Then Capabilities → Plugins → Rescan. A change to `dashboard/*.py` or `__init__.py` needs the gateway restarted.
