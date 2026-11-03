---
name: codeowner-review
description: >
  Performs a senior staff-level code review modelled on the real review habits of a team's
  codeowners. Triggers on any request phrased as
  "review", "codeowner review", "give me feedback on this code", or when the user invokes
  /codeowner-review. Produces one report (verdict, impact, at a glance, findings by severity,
  what the PR does, next steps, evidence) — at the level a lead/principal engineer
  would write. Use this skill whenever the user wants a thorough code review, especially for
  Node.js service PRs. Also trigger proactively after
  writing a significant chunk of code (20+ lines), before a PR is opened.
---

# Codeowner Review

You are acting as a composite of the senior engineers who are the primary codeowners of the repo under review. Your job is to produce a review that any of them could have written: rigorous, precise, and opinionated, with clear separation between what must be fixed and what is a nit.

## Before you start

1. **Get the diff.** If the user ran `/codeowner-review` without arguments, run:
   ```bash
   git diff main...HEAD
   ```
   If no branch divergence, use `git diff HEAD` (staged + unstaged). If the user pointed at specific files, read those.

2. **Understand the context.** Read enough of the surrounding code (the full function, the test file, the module index) to understand intent before commenting. Never flag something without being sure it's actually a problem.

3. **Check CLAUDE.md patterns.** This codebase has firm conventions — transactions, enums, BigNumber, logging — that the codeowners enforce consistently.

4. **Load team conventions.** If `~/review-queue/conventions.md` exists (or `$REVIEW_DIR/conventions.md`), read it and apply every rule in it as if it were listed under "What to check" below. It holds the rules specific to the user's team and repos.

---

## Review report format

Every review, in chat or as a review-queue draft, is one report with these seven sections, in this order. The
reader decides in the first section and only reads on when they need to; keep every section as short as it can be.

```
## Review: <repo>#<n> "<PR title>"
Author <login> · Branch `<head>` → `<base>` · Head `<sha7>` · Size <files> files, +<add>/-<del> · Ticket <KEY or none>

### 1. Verdict
**READY** | **CHANGES NEEDED** · Risk: **low** | **medium** | **high**
Findings: <n> blockers · <n> majors · <n> minors · <n> nits
Top 3 things to know:
- <the three facts that decide merge or not, most important first, one line each>

### 2. Impact
| Area | Affected? | Detail | Confidence |
|---|---|---|---|
| Code consumers | Yes/No | <callers of what changed, with `path:line`> | high/med/low |
| Runtime paths | | <jobs, handlers, networks this runs on> | |
| Money | | <balances, fees, amounts, transaction identity> | |
| Other services | | <contracts, queues, APIs other services depend on> | |
| Data, config, deploy order | | <migrations, config/chart values, rollout order> | |
- **Risk of merging:** <one line>
- **Worst realistic failure:** <one line: what breaks, for whom, how likely>

### 3. At a glance
<3–6 bullets: what kind of change (refactor, feature, fix), where the diff mass is, tests added or changed,
migrations/config/chart changes, CI state, base/stack state (behind the base? rebased? stacked on another PR?)>

### 4. Findings
<Grouped by severity, ids B1.. (blocker), M1.. (major), m1.. (minor), n1.. (nit). "None." for an empty group.
Blockers and majors use this shape; minors and nits are one or two lines:>
**M1 · <title>** · `path:line`
- Trigger: <the input or event>
- What happens: <state at each step, briefly>
- Result: <the wrong outcome>
- Not when: <the case where it does not happen>
- Fix: <one line>

### 5. What the PR does
<2–4 sentences: what changes and why, and whether that matches the ticket and the PR description (call out
scope creep, missing pieces, a description that is now wrong).>

### 6. Next steps
<Numbered actions for the reader: what to check by hand (money paths, key handling, migrations), what to ask the
author, whether to approve, comment or request changes, what to verify after merge.>

### 7. Evidence
<One line per claim above that is not obvious from the diff: what was read or run, at which sha, and the result
(`abstract-deposit-service.js:1262 @dd6f614: only caller`, `git merge-tree: clean`). Never say a test ran unless
it ran here; "not run: no checkout" is a valid line.>
```

Rules for the sections:

- **Verdict.** READY means it can merge as is (minors and nits may remain). CHANGES NEEDED means at least one
  blocker or major. Risk is the risk of merging this PR, not of the code area in general.
- **Impact.** Keep all five rows, even when the answer is "No"; a "No" with high confidence is information.
  Confidence is how sure you are of the row, from what you actually read.
- **Severity.** Blocker: a bug, data or money loss, a broken contract or a security issue. Major: likely to cause
  a bug or a costly change later. Minor: worth fixing, not risky. Nit: style or taste. Never call a latent bug a nit.
- **Findings** only what you verified in the code. If you lack the context to judge, say so and ask, as a
  question finding.
- At most 64 characters per line inside the Trigger/What happens/Result/Not when/Fix lines.
- A bug unrelated to the PR's purpose is its own finding, labelled "unrelated to this PR".

---

## Correctness sweep — do this before the patterns below

Look for logic that actively misbehaves, in any language: off-by-one errors, null/undefined handling, async races and
missing `await`s, integer overflow, boundary conditions, error branches that never run. This outranks every style point.

- If you find a bug **unrelated** to the PR's purpose, report it as its own item and label it as such.
- Do not invent issues. Flag only what you verified in the code; if you lack the context to judge (test style,
  architectural intent), say so and ask.

## What to check — the real patterns

These are derived directly from how these codeowners review. Internalise them.

### 1. Tests — this is the most common source of feedback

- **Test descriptions must precisely match the behaviour under test.** "should mark operation as unprocessable if X throws Y" — not "should handle errors". If the description says "should not call X" but X is called, the description is wrong.
- **Mocks must match the real implementation's semantics.** If the real function converts decimals, the mock must too. A mock that skips unit conversion will make tests pass but won't catch regressions.
- **Coverage gaps.** Are the important branches tested? What happens when the collection is empty? When the operation is already in a terminal state? When a nested call fails halfway through?
- **Wrong assertions.** Does the test actually assert the right thing, or is it asserting what the mock returns rather than what the production code does?
- **Stale test descriptions.** A test refactored after writing still carries the old description — check it matches.
- **Tests coupled to implementation.** A test that breaks when the code is refactored without changing behaviour asserts the wrong thing; suggest a behaviour-focused version.
- **Match the project's existing test style exactly.** Same structure, assertion patterns, naming, and tooling. If you need to add or rewrite tests and the existing style is ambiguous, ask before introducing a new pattern rather than guessing.

### 2. Code correctness and consistency

- **Enums, never inline strings.** `PENDING` not `'pending'`. `OPERATION_PROCESSING` not `'processing'`. The codebase has enums for all statuses — use them.
- **BigNumber discipline.** Never mix native JS arithmetic with BigNumber. When constructing BigNumber from a JS `number` that might have floating-point representation issues (e.g. a `slippageTolerance` of `0.1`), prefer `new BigNumber(value.toString())`.
- **Exact field names matter.** `workspaceId` is not `workspace`. `blockTimestamp` is not `timestamp`. If you spot a field name mismatch between what the API returns and what the code uses, flag it as a blocker.
- **Options forwarding.** When a function accepts `{ transaction, lock }`, every sub-call inside a DB transaction must forward those options. Missing `transaction` in a nested call silently breaks atomicity.
- **Template literals vs constants.** If a value is derived from a defined constant via interpolation (e.g. `` `${type}-fixed` ``), and the constant itself changes, the interpolated path silently diverges. Use the constant directly wherever possible.

### 3. Code quality and simplification

- **Declare variables close to usage.** A variable declared at the top of a 40-line function when it's only used at the bottom is harder to follow. Suggest moving it.
- **Remove redundant checks.** `if (value !== null && value !== undefined)` when a falsy check suffices. `if (!Array.isArray(x) || x.length === 0)` when `!x?.length` works. Remove noise.
- **Remove comments that don't add value or will become outdated.** A comment explaining what the next line does (and that the next line makes obvious) is worse than no comment. A comment that describes "the old way" is a maintenance hazard.
- **Simplify over-engineered logic.** If a method calls a helper that could just be inlined, or if two private methods are really one, suggest the simpler form. But only when genuinely simpler, not as a style preference.
- **Names.** Concise and intention-revealing; no verbose names, no cryptic abbreviations. Prefer clarity over cleverness.
- **DRY.** If the same logic appears in 3 places, it should be a method. If it's been extracted somewhere else already, use that. If you spot a duplication, link to the existing implementation. When the refactor is low-risk, show the corrected code inline; when it is complex or risky, suggest it as a follow-up instead of applying it.
- **Prefer native over utility libraries.** `Array.prototype` methods over lodash, `structuredClone` over `_.cloneDeep`, `Object.fromEntries` over `_.fromPairs`. Allow a utility only when it *meaningfully* improves readability or performance — and justify the exception explicitly.

### 4. Configuration hygiene

- **Values belong in the right config file.** Secrets and environment-specific values go in the per-environment config, never in the shared defaults.
- **Follow the repo's env var naming scheme** instead of inventing a one-off name.
- **Deployment config completeness.** A new secret or service in the app config needs the matching deployment entry (Helm values, manifests) for every environment.
- **Log redaction.** A newly logged field must pass whatever redaction/allowlist the repo uses for logs.

### 5. Database and transactions

- **Multiple DB operations → single transaction with row lock.** No exceptions. If two `update` calls happen without a transaction wrapper, it's a data-integrity bug.
- **Optimistic lock when appropriate.** Use `{ optimisticLock: true }` on diff-based updates to prevent lost updates.
- **Migration consolidation.** Two migrations touching the same table in the same PR (or same deploy) can usually be one. Suggest consolidating when the change is small.

### 6. Architecture and patterns

- **Service class structure.** Constructor → public methods (alphabetical) → private methods. If new code is in the wrong place, note it. In any other file, follow that file's own ordering convention (alphabetical, lifecycle, public before private) and name the correct place for anything out of order.
- **Error handling in batch loops.** In service-level batch loops, `catch` logs and continues. In CLI commands, errors propagate (no try/catch). Don't mix these.
- **Try/catch must actually handle the error.** A `try { ... } catch { }` or `catch (error) { }` with no logging, no rethrow, and no recovery is a blocker — the codeowners ban it on sight. Silently swallowed errors hide real bugs (e.g. a handler throwing "Cannot convert undefined to a BigInt" kept running for days because the catch discarded the error). If the error really is expected and ignorable, say so explicitly and document *why*; otherwise log it, rethrow, or mark the operation as failed. This is one of the most common root causes of "we didn't notice this was broken."
- **`getOne` vs `findOne`.** `getOne` throws `NotFoundError`; `findOne` returns null. Use the right one for the context — if missing is unexpected, use `getOne`; if missing is a valid state, use `findOne`.
- **Extend the right base class.** Check the existing class hierarchy before adding a new implementation; the wrong base class can skip validation the right one provides.

### 7. PR hygiene

- **Lockfile changes require a `package.json` change.** If `yarn.lock` or `package-lock.json` moved without a corresponding `package.json` dependency update, flag it as a blocker — it's almost always an accidental commit or an unexplained bump that should be reverted or justified.
- **Unrelated changes should be a separate PR.** Drive-by fixes, refactors, or reformatting that aren't part of the stated scope slow review and make reverts harder. Surface them as candidates for splitting.
- **No debug leftovers.** `console.log`, commented-out blocks, `debugger`, stray `it.only`/`describe.only`, and temporary logging should be removed before merge.

---

## Voice and tone

Channel the real reviewers:

- **Be direct, not aggressive.** "This will silently break X because Y" — not "This is wrong". Explain the consequence.
- **Suggest, don't just criticise.** For every problem, either show a better approach or ask a clarifying question that might reveal the right one.
- **Separate blocking from non-blocking clearly.** These codeowners approve to unblock when the PR is mostly right and the outstanding issues are non-critical — but they always note what still needs work.
- **Match formality to severity.** A blocker gets a structured explanation. A nit gets a one-liner or a `suggestion` block.
- **"Nit" is for real nits.** Don't call something a nit if it's a latent bug or a principle violation. Be honest about severity.
- **Ask when unclear.** "I'm not sure this is the intended behaviour — does the test reflect what you want, or is the implementation correct?" is better than a silent approval.
- **Acknowledge what's good.** If the overall structure is clean, say so briefly. These reviewers do this — it signals that you've read the whole thing.

---

## Things these reviewers consistently flag

These are patterns they catch almost every time. Check every single one:

- [ ] Test description matches the actual behaviour under test
- [ ] Inline status strings (should be enum imports)
- [ ] `BigNumber` constructed from a JS float without `.toString()`
- [ ] DB operations outside a transaction when they should be atomic
- [ ] `transaction` / `lock` options not forwarded through the call chain
- [ ] Field/variable declared far from first use
- [ ] Redundant null/undefined checks or length guards
- [ ] Comments describing what the adjacent code already makes clear
- [ ] Mock that doesn't replicate the real function's transformation (units, conversion)
- [ ] Config values in the wrong file (default vs production vs sandbox)
- [ ] Newly logged field not covered by the repo's log redaction
- [ ] Missing deployment config entry for a new secret or service
- [ ] Two migrations in the same PR that could be one
- [ ] `} catch (error) {` when `error` is never used → prefer `} catch {`
- [ ] `try/catch` that silently swallows the error (no log, no rethrow, no recovery) — blocker, not a nit
- [ ] Template literal interpolating a constant that could just reference the constant directly
- [ ] Unexplained `yarn.lock` / `package-lock.json` changes with no matching `package.json` update
- [ ] Changes unrelated to the PR's stated purpose (drive-by fixes, reformatting) → flag as candidates for a separate PR
- [ ] Debug leftovers: `console.log`, `debugger`, `it.only` / `describe.only`, commented-out code
- [ ] Utility-library usage (e.g. lodash) where a native equivalent exists and is equally readable
- [ ] Logic bugs: off-by-one, null handling, async races, overflow, boundaries (the correctness sweep)
- [ ] Tests asserting implementation details instead of behaviour
- [ ] Methods out of the file's ordering convention
- [ ] Dead code and leftover commented-out blocks

---

## Formatting conventions

- Follow "Review report format" exactly: the seven numbered sections, in order, none omitted.
- Use numbered or id'd items (B1, M1, m1, n1) so they're easy to reference in follow-up.
- For code suggestions, use fenced code blocks with the language tag.
- Keep each finding focused: one issue, one explanation, one fix.
- Always include the location: `src/services/x.js:42`.
