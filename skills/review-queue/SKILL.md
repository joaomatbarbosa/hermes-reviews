---
name: review-queue
description: >
  Personal codeowner review pipeline: collects the Jira tickets your `config.md` JQL selects
  (tickets in review on your board), finds their open PRs, triages them by risk, and drafts reviews with codeowner-review. Drafts are NEVER posted without the
  user's explicit approval. Use when the user says "/review-queue", "review queue", "what's in my
  review queue", "post the review for <repo>#<n>", or "discard <repo>#<n>". `/review-queue run` is
  the headless mode `run.sh` starts on demand (the Reviews page buttons). `/review-queue run co` is the same, limited to the codeowner review status.
---

# Review Queue

Both skills ship in the hermes-reviews plugin (`skills/`). Claude Code sees them as `review-queue` and `codeowner-review` (linked into `~/.claude/skills` by `scripts/install.sh`); Hermes sees them as `reviews:review-queue` and `reviews:codeowner-review`. Use whichever name your harness lists. The Hermes Reviews page and the `rq-watch` watcher read and update the same `~/review-queue` folder.

Data lives in `~/review-queue/`:

- `state.json`: one entry per PR, keyed `<repo>#<number>`:
  `{ "jira": "CRY-1234", "tier": "standard", "reviewedSha": "<sha>", "draft": "<path>", "status": "pending|posted|discarded|merged|closed|skipped", "updatedAt": "<iso>" }`
  plus, for each draft, `"verdict"`, `"risk"` (`low|medium|high`) and `"blocking"` (the number of blockers), copied from the draft header.
  An entry may also carry `"chat": "<session id>"`, written by the faish board: the PR's own review chat, and `"paused": "<iso>"`, written by the board when the user pauses a PR (see step 3). Never drop or change either when you update an entry; keep any other field you don't recognise as well.
  The Hermes Reviews page (and its `rq-watch` watcher, `"statusSource": "reviews-watch"`) also sets `status` (merged, closed, discarded, posted, or back to pending) and records `prevStatus`, `statusAt`, `statusSource: "reviews-plugin"`, `statusEventId`, `statusReason`, `mergedBy`/`postedBy`. Treat its statuses exactly like ones you set; its `feedback.jsonl` events carry `"source": "reviews-plugin"` and follow the shapes in "Learning loop".
- `drafts/<YYYY-MM-DD>/<repo>-<number>.md`: one draft per PR (format below).
- `latest.md`: the digest from the last run.
- `logs/`: launchd run logs (written by `run.sh`, not by you).
- `feedback.jsonl`: one JSON event per line, the raw learning signal (see "Learning loop").
- `learnings.md`: lessons distilled from feedback. **Every review reads it.**
- `proposals/<YYYY-MM-DD>.md`: proposed edits to this SKILL.md, applied only when the user approves.
- `config.md`: **read it first, every run.** The constants this skill refers to by placeholder: the Jira cloudId
  (`<cloudId>`), the ticket JQL (`<jql>`), the GitHub org (`<org>`), the user's own GitHub login (`<login>`) and Jira
  display name (`<me>`), and extra sensitive areas for triage. `scripts/install.sh` seeds it from
  `queue/config.example.md`; if it is missing or still has `<...>` values, stop and ask the user to fill it in.
- `conventions.md` (optional): team-specific review rules; codeowner-review applies them on top of its own.

---

## Mode 1: `run` and `run co` (headless, on demand)

`run` takes the whole `<jql>`. `run co` takes only the tickets in the codeowner review status: in `<jql>`, replace the `status in (...)` clause with `status = <coStatus>` (`CO status` in `config.md`, default `"Codeowner Review"`) and change nothing else. Everything below applies to both; a `co` run leaves the entries of other tickets in `state.json` untouched and writes its own `latest.md`, whose first line says `Scope: codeowner review only`.

You are running unattended. **Never post, approve, comment, push, or transition anything on GitHub or Jira.** Read-only `gh` calls only. Always use `gh api --method GET ...` for API reads. Only write files under `~/review-queue/`, using the Write and Edit tools (never shell redirection).

**Shell rules (the permission allowlist depends on them):** each Bash call is exactly ONE simple command that starts with `gh pr view`, `gh pr diff`, `gh search prs`, or `gh api --method GET`. No `for`/`while` loops, pipes, `&&`, `;`, `$(...)` or redirection: these get denied. Filter with `--jq` instead of `| jq`. To process many tickets, make many separate calls, in parallel where possible. If a command is denied, rewrite it as a single simple command and retry. A denial covers only that command shape, not Bash as a whole. Never report "Bash is denied" unless a plain `gh pr view` call was denied. Never claim drafts or state exist without reading them first.

0. **Load learnings and harvest outcomes.** Read `learnings.md` and pass it verbatim to every review subagent as "reviewer calibration: follow these rules". Then, for every `state.json` entry with status `posted` that has not been harvested yet, collect what happened to the posted comments: `gh api --method GET repos/<org>/<repo>/pulls/<n>/comments` (replies to our comments) and `gh pr view <n> -R <org>/<repo> --json state,reviews,commits`. Classify each posted comment as one of:
   - `accepted`: code at that spot changed in a later commit, or the reply agrees;
   - `rejected`: the author pushed back and nothing changed;
   - `ignored`: the PR merged without a reply or change.

   Also record substantive comments other human reviewers made that our draft had no finding for (`missed`). Append one `{"type":"outcome",...}` event per PR to `feedback.jsonl` and set `harvested: true` in state.
1. **Collect tickets.** JQL:
   `<jql>` from `config.md`, verbatim (with cloudId `<cloudId>`). Never loosen its filters: they are what scope the queue to the user's board.
   Epics, stories and spikes carry no PRs of their own (the code lives on their tasks and sub-tasks), so the JQL should exclude them.
   Request ONLY `fields: ["summary", "status", "assignee", "issuetype"]` with `responseContentFormat: "markdown"` and `maxResults: 50`, and page with `nextPageToken` until done. Never request `description` here, because the response gets too large. Fetch the description later with `getJiraIssue` (fields `["summary", "description"]`), and only for tickets that have an open PR to review. Process every ticket: the run is not done until all pages are mapped.
2. **Map each ticket to PRs.** Use `gh search prs "<KEY>" --owner <org> --match body --json repository,number,title,author,url,state` (no `--state` filter, so merged and closed PRs come back too). PR bodies link the ticket under "Related issues". Only open PRs go on to review. Bucket the other tickets for the digest: **PR merged** (no open PR, at least one merged, so the ticket probably just needs moving on the board), **PR closed** (every linked PR was closed without merging), and **no PR** (nothing links the ticket). Ignore tickets assigned to `<me>` (the user's own work, even when the PR author is `claude[bot]`), PRs authored by `<login>`, drafts (`isDraft`), and PRs I already approved at the current head.
3. **Skip what hasn't changed, and what is paused.**
   - **Paused**: an entry with a `paused` field is never reviewed in this mode, new commits or not, and costs no calls beyond step 2's mapping. Don't touch the entry. List it in the digest's `Paused` line. Only the user resumes it, by removing the field on the board.
   - **Unchanged**: get `headRefOid` via `gh pr view <n> -R <org>/<repo> --json headRefOid,isDraft,reviews,additions,deletions,files,body,title,author`. If `state.json` has the same `reviewedSha` and its status is `pending`, `posted` or `discarded`, skip it.
   - **New commits on a PR already reviewed** (an entry with a `reviewedSha` that differs from the head): review **only the change**, never the whole PR again. That saves most of the tokens. Get the change with `gh api --method GET -H "Accept: application/vnd.github.diff" repos/<org>/<repo>/compare/<reviewedSha>...<head>`. Keep only the files that are in the PR's own `files` list: anything else came in by merging the base branch and is not the author's change. Fall back to a full review, and say why in the intent check, when the compare fails or `gh api --method GET repos/<org>/<repo>/compare/<reviewedSha>...<head> --jq .status` is not `ahead` (a force push or a rebase, so the old sha is no longer an ancestor).
   - A PR never reviewed, or one the user asked to rerun with `full`, gets a full review.
4. **Triage tier** (the "semantic approval rules" idea: trivial changes go fast, sensitive ones get the deepest review):
   - **trivial**: only Helm chart bumps / `Chart.lock`, Dependabot, lockfiles, docs/markdown, or renames with no logic change. Quick sanity check only: does the diff do exactly what the title says, and nothing else?
   - **sensitive**: touches signing, KMS/Vault, private keys, withdrawals/deposits/transfers, balances/amounts/BigNumber math, idempotency, authorizations/permissions, DB migrations, or any of the extra sensitive areas listed in `config.md`. Also any PR over 600 changed lines.
   - **standard**: everything else.
5. **Review, one subagent per PR** (parallelise in batches of about 5 to keep your own context small). Give each subagent:
   - the PR diff (`gh pr diff <n> -R <org>/<repo>`), title, body, the Jira summary and description;
   - instructions to read surrounding code without cloning: `gh api --method GET -H "Accept: application/vnd.github.raw" "repos/<org>/<repo>/contents/<path>?ref=<sha>"` (raw file, no decoding needed). The subagent must follow the same shell rules as above, including the repo's `CLAUDE.md` if present;
   - existing review comments (`gh api --method GET repos/<org>/<repo>/pulls/<n>/comments`), so it does not repeat points others already raised;
   - the review skill: invoke **codeowner-review** on that diff (it already covers the correctness sweep, readability, duplication, method ordering, tests and PR hygiene);
   - an **intent check** first: does the diff match what the ticket and PR description say? Flag scope creep or missing pieces;
   - the **comment style** rules below, which override codeowner-review's output style;
   - **for a review of the change only**: the change's diff instead of `gh pr diff`, the head before it (`reviewedSha`), and the earlier review: the previous draft file, plus, when the entry is `posted`, our posted review's comments and their replies (`gh api --method GET repos/<org>/<repo>/pulls/<n>/comments`). The subagent reviews the change alone. It reads surrounding code as needed, but raises no finding on code the change did not touch. It also writes `### Earlier comments` (under `## Findings`): one line per earlier comment, saying `fixed`, `answered` or `still open`. When the earlier draft was **never posted** (status `pending` or `discarded`), each `still open` comment is carried into the new draft's inline comments, re-anchored to its line at the new head (check it with a contents read at the new sha), so nothing is lost. When it was posted, the thread is already on GitHub, so it is not repeated inline. Triage the tier by the change's own content (a lockfile bump on a sensitive PR is a trivial change), but keep the "Check yourself" items in `## Next steps` if the change touches a sensitive path;
   - the rule: findings on code the PR (or, for a change-only review, the change) did not touch are **never inline comments**. A real problem worth knowing goes in `### Outside this diff` under `## Findings` (0–3 one-line bullets, private, never posted); anything minor is dropped;
   - the rule: only report findings it verified in the code. Every inline finding must carry a `path` and a `line` that exists on the RIGHT side of the diff (an added or context line inside a hunk). Anything else goes in the general section.
   Each subagent writes its own draft file and returns only a 3-line summary (verdict and risk, finding counts, draft path), so your context stays small. Write `state.json` after every batch, so a crash keeps the finished work.
6. **Write the draft** to `drafts/<today>/<repo>-<n>.md` using the format below, update `state.json` (status `pending`), and log any failures (record the PR with status `skipped` and the reason).
7. **Write `latest.md`**, the digest: one table sorted by tier (sensitive first) then age, with columns: PR link, Jira key, author, tier, verdict (`looks good` / `has comments` / `blocking`), risk, findings (`B/M/m/n`), and the draft path. After the table, a `## Not reviewed` section with one line per bucket from step 2 (`PR merged`, listing each ticket with its merged PR; `PR closed`; `No PR`), plus `Paused (N): <keys>`, own tickets skipped and draft PRs, then a `## Failures` section. Finish with one line: `N new · M re-reviewed · K unchanged · P paused`.

### Comment style

Everything that would be posted (review body and inline comments) must read like a quick note from a teammate, not a report.

- Inline comments: 1–2 short sentences. Say the point and, if needed, the fix. No backstory, no restating what the code does.
- Review body: 1–3 sentences. Overall take plus the main thing to address. Don't repeat the inline comments or list what you checked.
- Casual, direct tone: "Could we add a comment here on why `preserveEncoding` is needed?", "nit: I'd split this into two `it`s." Prefix nits with `nit:` in the draft.
- The `nit:` prefix (and the `(robbie)` tag older drafts carry) is for the user only. Keep it in the draft, but strip it from the text that gets posted (see Mode 2 `post`).
- Code suggestions only when they're shorter than explaining it.
- No praise padding ("Thanks, this is a clean, minimal fix…"), no "I checked X, Y and Z", no hedging chains.
- The analysis (why, evidence, callers checked) belongs in the report sections (`Findings`, `Impact`, `Evidence`), which are for the user only and are never posted. Keep those brief too.

Example. Too verbose: "The description says the resolved card carries the matched stored form (`xdc…`) as `address`, as it did before `bf3594a964`. Worth asserting that here (`object.address.should.equal(legacyAddress)`), since that value ends up on the transaction."
Good: "Can we also assert `object.address` is the stored `xdc…` form? That's what ends up on the transaction."

### Draft format

The draft is the **codeowner-review report** (its "Review report format": seven `## ` sections, numbered in the
nav, not in the headings) plus two sections that get posted. The header lines are read by the Reviews page and by
the digest, so keep them exactly in this shape.

````markdown
# <repo>#<n>: <title>
PR: <url> · Jira: <KEY> · Author: <login> · Tier: <tier> · Head: <sha>[ · Base: <reviewedSha>]
Verdict: looks good | has comments | blocking
Risk: low | medium | high
Findings: <n> blockers · <n> majors · <n> minors · <n> nits

## Verdict
<READY | CHANGES NEEDED, then "Top 3 things to know" (codeowner-review section 1, without the Findings line,
which is the header above)>

## Impact
<the five-row table, "Risk of merging", "Worst realistic failure">

## At a glance
<3–6 bullets>

## Findings
<by severity, ids B1/M1/m1/n1; an id that is also an inline comment uses the same id there.
Change-only reviews add `### Earlier comments`: one line per earlier comment, `#<id> <topic>: fixed | answered |
still open`. Real problems in code the PR did not change go in `### Outside this diff` (0–3 one-line bullets,
never posted; omit when empty).>

## What the PR does
<2–4 sentences, including whether the diff matches the ticket and the PR description>

## Next steps
<numbered. Sensitive tier: start with "Check yourself:" and the 1–3 things a human must verify (money paths, key
handling, migrations).>

## Evidence
<one line per non-obvious claim: what was read, at which sha, the result. The headless run has no checkout and
runs no tests, so its evidence is reads (`path:line @sha`) and `gh` output; never claim a test ran.>

## Proposed review body
<the summary comment that would be posted>

## Inline comments
```json
[
  { "id": "M1", "path": "src/foo.js", "line": 42, "side": "RIGHT", "severity": "blocker|major|minor|nit", "body": "..." }
]
```
````

`Verdict:` maps from the report: CHANGES NEEDED with a blocker is `blocking`, any other finding is `has comments`,
none is `looks good`. Only the last two sections are ever posted; everything above them is for the user.
`Base:` is present only on a change-only review: the commit the change is reviewed from. Full sha for both `Head` and `Base`.

---

## Mode 2: interactive (default `/review-queue`)

1. Show `latest.md` and the pending entries from `state.json`. If the last run is not from today, say so.
2. The user decides per PR:
   - **`post <repo>#<n>`** (optionally `only 1,3` or `drop 2`): build the payload from the draft and show the user the exact review body plus the inline comments that will go out. Ask for explicit confirmation, then post a single review:
     `gh api --method POST repos/<org>/<repo>/pulls/<n>/reviews --input <payload.json>` with `commit_id` = the draft's head sha, `event` = `COMMENT` (use `APPROVE` or `REQUEST_CHANGES` only if the user says so in this turn), `body`, and `comments: [{path, line, side, body}]`. Before building the payload, strip a leading `nit: ` (any case) and any `(robbie)` tag from every posted body and the review body, and show the user the stripped text; the draft file keeps them. The same applies to any single comment the user asks to post outside a full review. If the PR head moved since the draft, warn and offer to re-review first. Mark the entry `posted`.
   - **`discard <repo>#<n>`**: mark it `discarded` (it is re-reviewed only if new commits arrive).
   - **`rerun <repo>#<n>`**: redo steps 3–6 for that PR now, even if it is paused (an explicit ask overrides the pause, but leave the `paused` field as it is). With new commits since `reviewedSha` that is a change-only review, as in step 3.
   - **`rerun <repo>#<n> full`**: a full review of the whole PR at its head, ignoring `reviewedSha`: models and calibration improve, and a fresh look at an old PR can find more. No `Base:` line, no `Earlier comments` section.
   - The user may edit comments before posting ("reword 2 as …"). Apply the edit to the draft first.
3. Never post anything without a confirmation given in the current turn.
4. **Record feedback after every decision** (append to `feedback.jsonl`, no questions asked):
   - post: `{"type":"decision","pr":"<repo>#<n>","tier":"…","date":"…","event":"COMMENT|APPROVE|REQUEST_CHANGES","drafted":[{"id":1,"severity":"nit","source":"codeowner","topic":"<3–6 words>"}],"posted":[ids],"dropped":[ids],"reworded":[{"id":2,"from":"…","to":"…"}]}`
   - discard: same shape with `"posted":[]`, and the user's reason if they gave one.
   - Any opinion the user gives about a PR or a draft ("this is good to merge", "too nitpicky", "you missed X"): `{"type":"note","pr":"…","note":"<user's words>"}`.
5. After any change to `state.json` (post, discard, rerun, or a PR the user says they merged, which gets status `merged`), rebuild the dashboard with `node ~/review-queue/dashboard.js`. It writes `~/review-queue/dashboard.html`; it isn't run in headless mode, where `run.sh` builds it.
6. If `proposals/` has a proposal the user hasn't seen, mention it in one line. On `apply proposal`, show the diff, apply it to this SKILL.md once the user confirms, and log `{"type":"proposal_applied"}`.

---

## Mode 3: `improve` (headless, weekly, run by `run.sh` on Mondays)

Same safety rules as Mode 1: no GitHub/Jira writes, and only write under `~/review-queue/`.

1. Read `feedback.jsonl` events since the last `{"type":"improve"}` event, plus the current `learnings.md`. Notes that say `paused on the board` or `resumed on the board` are about scheduling, not about the quality of a draft: never turn them into review rules.
2. Compute calibration stats and put them at the top of `learnings.md`:
   - keep rate (posted ÷ drafted) by severity, by tier;
     Severities changed from `blocking / suggestion / nit` to `blocker / major / minor / nit`. Count older events with `blocking` as `blocker` and `suggestion` as `minor`, so the rates stay comparable;
   - outcome rates (accepted / rejected / ignored);
   - number of `missed` findings.
3. Rewrite `learnings.md` as **at most 30 concrete, actionable rules**. Each rule ends with its evidence, e.g. `(dropped 7/8 nits on test fixtures)` or `(user note 2026-10-15)`. Add rules only when there are ≥2 supporting events or an explicit user note. Remove rules that later evidence contradicts. Examples of a good rule:
   - "On re-reviews where earlier blockers are fixed, lead with that and cap nits at 2."
   - "Don't flag alphabetical method order."
4. If the evidence points to a structural change in this SKILL.md (tier keywords, the draft format, scope), write it as a proposed diff with a rationale to `proposals/<today>.md`. **Never edit SKILL.md in this mode.**
5. Append `{"type":"improve","date":"…","events":N}` to `feedback.jsonl`.
