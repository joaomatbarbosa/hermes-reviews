"""The review queue, without a web framework: shared by the plugin backend (plugin_api.py) and the watcher.

The folder is the review-queue skill's (default ~/review-queue): `state.json` (one entry per PR keyed `<repo>#<n>`),
`drafts/<date>/<repo>-<n>.md`, `latest.md`, `feedback.jsonl`. Set REVIEW_DIR to use another folder.

The only write is `apply_status`: it changes entries' `status` in `state.json` using the skill's own vocabulary
(pending / posted / discarded / merged / closed) and appends a `feedback.jsonl` event in the skill's format, so the
weekly `improve` step learns from it. An undo (back to the previous status) removes that event again. Every write
re-reads the file under a lock, changes only the named entries and renames a temp file into place, so it never
clobbers what a concurrent `/review-queue run` wrote. Stdlib only, plus the `gh` CLI for live PR state.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

KEY_RE = re.compile(r"^([\w.-]+)#(\d+)$")
URL_RE = re.compile(r"github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)")
STATUSES = {"pending", "posted", "discarded", "merged", "closed"}
LIVE_STATUSES = {"pending", "posted"}  # entries whose GitHub state is worth watching
LIVE_TTL = 300  # seconds


def review_dir() -> Path:
    return Path(os.environ.get("REVIEW_DIR") or Path.home() / "review-queue").expanduser().resolve()


def _default_owner() -> str:
    """GitHub owner for drafts without a PR URL: $REVIEW_GH_OWNER, else `GitHub org` in config.md."""
    if os.environ.get("REVIEW_GH_OWNER"):
        return os.environ["REVIEW_GH_OWNER"]
    try:
        m = re.search(r"GitHub org:\s*`([\w.-]+)`", (review_dir() / "config.md").read_text())
    except OSError:
        m = None
    return m.group(1) if m else ""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _load_state(base: Path) -> dict:
    try:
        state = json.loads(_read(base / "state.json") or "{}")
    except ValueError:
        return {}
    return state if isinstance(state, dict) else {}


def parse_draft(text: str) -> dict:
    """A draft as the skill writes it: `# repo#n: title`, a `PR: … · Jira: …` line, `Verdict: …`, `## ` sections."""
    sections: dict[str, str] = {}
    order: list[str] = []
    head: list[str] = []
    at = None
    buf: list[str] = []
    for line in text.split("\n"):
        m = re.match(r"^## (.+)$", line)
        if m:
            if at is not None:
                sections[at] = "\n".join(buf).strip()
            at = m.group(1).strip()
            order.append(at)
            buf = []
        elif at is None:
            head.append(line)
        else:
            buf.append(line)
    if at is not None:
        sections[at] = "\n".join(buf).strip()

    title = ""
    for line in head:
        m = re.match(r"^# (.+)$", line)
        if m:
            title = re.sub(r"^[\w.-]+#\d+:\s*", "", m.group(1)).strip()
            break
    meta: dict[str, str] = {}
    for line in head:
        if line.startswith("PR:"):
            for part in line.split(" · "):
                mm = re.match(r"^(\w+):\s*(.+)$", part.strip())
                if mm:
                    meta[mm.group(1).lower()] = mm.group(2).strip()
    def header(name: str) -> str:
        return next((l.split(":", 1)[1].strip() for l in head if l.startswith(f"{name}:")), "")

    verdict = header("Verdict")
    risk = header("Risk").lower()
    counts: dict[str, int] = {}
    for n, word in re.findall(r"(\d+)\s+(blocker|major|minor|nit)s?", header("Findings"), re.I):
        counts[word.lower()] = int(n)

    inline: list = []
    raw = sections.get("Inline comments", "")
    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    raw = re.sub(r"```\s*$", "", raw).strip()
    inline_bad = False
    if raw:
        try:
            arr = json.loads(raw)
            inline = [c for c in arr if isinstance(c, dict) and isinstance(c.get("body"), str)]
        except ValueError:
            inline_bad = True
    return {
        "title": title,
        "meta": meta,
        "verdict": verdict,
        "risk": risk,
        "counts": counts or None,
        "sections": [{"name": n, "body": sections[n]} for n in order],
        "inline": inline,
        "inlineBad": inline_bad,
    }


def _resolve_draft(base: Path, rel: str | None) -> Path | None:
    """A draft path from state.json, kept inside the folder."""
    if not rel:
        return None
    p = (base / rel).resolve()
    try:
        p.relative_to(base)
    except ValueError:
        return None
    return p


def _draft_of(base: Path, e: dict) -> dict:
    return parse_draft(_read(_resolve_draft(base, e.get("draft")) or Path("/nonexistent")))


def _entry_row(base: Path, key: str, e: dict) -> dict:
    m = KEY_RE.match(key)
    repo, n = (m.group(1), int(m.group(2))) if m else (key, 0)
    d = _draft_of(base, e)
    meta = d["meta"]
    return {
        "key": key,
        "repo": repo,
        "n": n,
        "title": d["title"] or key,
        "url": meta.get("pr") or "",
        "author": meta.get("author", ""),
        "head": (meta.get("head") or e.get("reviewedSha") or "")[:7],
        "jira": e.get("jira") or meta.get("jira", ""),
        "tier": e.get("tier") or meta.get("tier", ""),
        "verdict": e.get("verdict") or d["verdict"],
        "blocking": e.get("blocking") or (d["counts"] or {}).get("blocker", 0),
        "risk": e.get("risk") or d["risk"],
        "counts": d["counts"],
        "inline": len(d["inline"]),
        "status": e.get("status", "pending"),
        "prevStatus": e.get("prevStatus"),
        "statusAt": e.get("statusAt"),
        "statusReason": e.get("statusReason"),
        "rereview": bool(e.get("rereview")),
        "harvested": bool(e.get("harvested")),
        "theme": e.get("theme"),
        "chat": e.get("chat"),
        "updatedAt": e.get("updatedAt", ""),
        "priority": e.get("priority", 999),
        "reviewUrl": e.get("reviewUrl"),
        "draft": e.get("draft"),
    }




# ── live GitHub state ─────────────────────────────────────────────────────────────────────────

_EXTRA_PATH = [str(Path.home() / ".local/bin"), str(Path.home() / ".local/share/mise/shims"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
_live_cache: dict[str, tuple[float, str, dict]] = {}  # key -> (fetched at, reviewed sha, live)
_me: dict[str, str] = {}


def _gh_env() -> dict:
    # The gateway may start with a bare PATH (launchd); gh usually lives in mise shims or Homebrew.
    return {**os.environ, "PATH": os.pathsep.join([os.environ.get("PATH", ""), *_EXTRA_PATH])}


def _gh_exe() -> str | None:
    return shutil.which("gh", path=_gh_env()["PATH"])


def _gh(*args: str, timeout: int = 25) -> str | None:
    exe = _gh_exe()
    if not exe:
        return None
    try:
        p = subprocess.run([exe, *args], capture_output=True, text=True, timeout=timeout, env=_gh_env())
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout if p.returncode == 0 else None


def _my_login() -> str:
    if not _me.get("login"):
        _me["login"] = (_gh("api", "user", "--jq", ".login") or "").strip()
    return _me["login"]


def _owner_repo(key: str, url: str) -> tuple[str, str, str]:
    m = URL_RE.search(url or "")
    if m:
        return m.group(1), m.group(2), m.group(3)
    repo, _, n = key.partition("#")
    return _default_owner(), repo, n


def _fetch_live(key: str, e: dict, url: str) -> dict:
    owner, repo, n = _owner_repo(key, url)
    out = _gh(
        "pr", "view", n, "-R", f"{owner}/{repo}", "--json",
        "state,isDraft,headRefOid,reviewDecision,mergedAt,closedAt,latestReviews,statusCheckRollup",
    )
    if out is None:
        return {"error": "gh pr view failed"}
    try:
        pr = json.loads(out)
    except ValueError:
        return {"error": "gh returned bad JSON"}

    checks = pr.get("statusCheckRollup") or []
    failed = sum(1 for c in checks if (c.get("conclusion") or c.get("state")) in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"))
    me = _my_login()
    approvers = sorted(
        {(r.get("author") or {}).get("login") or "" for r in pr.get("latestReviews") or [] if r.get("state") == "APPROVED"} - {"", me}
    )

    head = pr.get("headRefOid") or ""
    reviewed = e.get("reviewedSha") or ""
    moved = bool(head and reviewed and not head.startswith(reviewed) and not reviewed.startswith(head))
    ahead = None
    force_pushed = False
    if moved:
        cmp = _gh("api", "--method", "GET", f"repos/{owner}/{repo}/compare/{reviewed}...{head}", "--jq", "{status: .status, ahead: .ahead_by}")
        try:
            c = json.loads(cmp) if cmp else {}
        except ValueError:
            c = {}
        if c:
            ahead = c.get("ahead")
            force_pushed = c.get("status") not in ("ahead", "identical")  # diverged: rebased or force-pushed

    return {
        "state": pr.get("state"),  # OPEN / MERGED / CLOSED
        "isDraft": bool(pr.get("isDraft")),
        "head": head[:7],
        "headMoved": moved,
        "commitsAhead": ahead,
        "forcePushed": force_pushed,
        "reviewDecision": pr.get("reviewDecision") or "",
        "approvedBy": approvers,
        "checksFailed": failed,
        "mergedAt": pr.get("mergedAt"),
        "closedAt": pr.get("closedAt"),
        "fetchedAt": _now(),
    }


def _live_for(state: dict, base: Path, refresh: bool) -> dict:
    todo = []
    out: dict[str, dict] = {}
    now = time.time()
    for key, e in state.items():
        if not isinstance(e, dict) or e.get("status", "pending") not in LIVE_STATUSES or not KEY_RE.match(key):
            continue
        hit = _live_cache.get(key)
        if hit and not refresh and now - hit[0] < LIVE_TTL and hit[1] == e.get("reviewedSha"):
            out[key] = hit[2]
        else:
            todo.append((key, e, _draft_of(base, e)["meta"].get("pr", "")))
    if todo:
        with ThreadPoolExecutor(max_workers=6) as pool:
            for (key, e, _), res in zip(todo, pool.map(lambda t: _fetch_live(*t), todo)):
                out[key] = res
                if "error" not in res:
                    _live_cache[key] = (now, e.get("reviewedSha"), res)
    return out



# ── writes ──────────────────────────────────────────────────────────────────────────────────

@contextmanager
def _locked(base: Path):
    with open(base / ".state.lock", "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _write_atomic(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _topic(body: str) -> str:
    words = re.sub(r"^\s*(?:nit|minor|major|blocker):\s*", "", re.sub(r"[`*_]", "", body), flags=re.I).split()
    return " ".join(words[:6])


def _drafted(d: dict) -> list[dict]:
    out = []
    for i, c in enumerate(d["inline"], 1):
        sev = str(c.get("severity") or "").lower()
        out.append({
            "id": c.get("id", i),
            "severity": {"blocking": "blocker", "suggestion": "minor"}.get(sev, sev or "minor"),
            "source": c.get("source", "codeowner"),
            "topic": _topic(c.get("body", "")),
        })
    return out


def _event(key: str, e: dict, d: dict, status: str, prev: str, reason: str | None, source: str = "reviews-plugin", via: str = "the Reviews page") -> dict:
    """A feedback.jsonl event in the skill's shape. `source` and `id` mark it as ours, so an undo can find it."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    base = {"pr": key, "date": today, "source": source, "id": uuid.uuid4().hex[:12]}
    why = f": {reason}" if reason else ""
    if status in ("merged", "closed"):
        drafted = _drafted(d)
        return {
            "type": "decision", **base, "tier": e.get("tier", ""), "event": status.upper(),
            "drafted": drafted, "posted": [], "dropped": [c["id"] for c in drafted] if prev == "pending" else [],
            "note": f"PR marked {status} from {via} (was {prev}){why}",
        }
    if status == "discarded":
        drafted = _drafted(d)
        return {
            "type": "decision", **base, "tier": e.get("tier", ""), "event": "DISCARD",
            "drafted": drafted, "posted": [], "dropped": [c["id"] for c in drafted], "reason": reason or "",
        }
    if status == "posted":
        return {"type": "note", **base, "note": f"review marked posted from {via} (posted outside the skill; the harvest step reads what went out)"}
    return {"type": "note", **base, "note": f"entry set back to {status} from {via} (was {prev}){why}"}


def _remove_event(base: Path, event_id: str) -> bool:
    path = base / "feedback.jsonl"
    keep = []
    hit = False
    for line in _read(path).splitlines(keepends=True):
        if not hit:
            try:
                if json.loads(line).get("id") == event_id:
                    hit = True
                    continue
            except (ValueError, AttributeError):
                pass
        keep.append(line)
    if hit:
        _write_atomic(path, "".join(keep))
    return hit



PLUGIN_SOURCES = ("reviews-plugin", "reviews-watch")


def apply_status(keys: list[str], status: str, reason: str | None = None, *, source: str = "reviews-plugin",
                 via: str = "the Reviews page") -> list[dict]:
    """Set `status` on the given entries. Raises ValueError (bad input) or LookupError (unknown key / no queue)."""
    if status not in STATUSES:
        raise ValueError(f"status must be one of {sorted(STATUSES)}")
    keys = list(dict.fromkeys(keys))
    if not keys or any(not KEY_RE.match(k) for k in keys):
        raise ValueError("bad key")
    reason = (reason or "").strip()[:500] or None
    base = review_dir()
    if not (base / "state.json").is_file():
        raise LookupError("no state.json")

    changed: list[dict] = []
    with _locked(base):
        state = _load_state(base)
        missing = [k for k in keys if not isinstance(state.get(k), dict)]
        if missing:
            raise LookupError(f"no such review: {', '.join(missing)}")
        events: list[dict] = []
        for key in keys:
            e = state[key]
            prev = e.get("status", "pending")
            if prev == status:
                continue
            if status == e.get("prevStatus") and e.get("statusSource") in PLUGIN_SOURCES:
                # Back to where it was: drop the event the forward step logged rather than adding a counter-event.
                if e.get("statusEventId"):
                    _remove_event(base, e["statusEventId"])
                for f in ("prevStatus", "statusAt", "statusReason", "statusEventId", "statusSource"):
                    e.pop(f, None)
                if status != "merged" and e.get("mergedBy") in PLUGIN_SOURCES:
                    e.pop("mergedAt", None)
                    e.pop("mergedBy", None)
                if status != "posted" and e.get("postedBy") in PLUGIN_SOURCES:
                    e.pop("postedAt", None)
                    e.pop("postedBy", None)
                e["status"] = status
            else:
                ev = _event(key, e, _draft_of(base, e), status, prev, reason, source, via)
                events.append(ev)
                e.update({"status": status, "prevStatus": prev, "statusAt": _now(), "statusSource": source, "statusEventId": ev["id"]})
                if reason:
                    e["statusReason"] = reason
                else:
                    e.pop("statusReason", None)
                if status == "merged" and not e.get("mergedAt"):
                    hit = _live_cache.get(key)
                    e["mergedAt"] = (hit and hit[2].get("mergedAt")) or _now()
                    e["mergedBy"] = source
                if status == "posted" and not e.get("postedAt"):
                    e["postedAt"] = _now()
                    e["postedBy"] = source
            _live_cache.pop(key, None)
            changed.append({"key": key, "status": status, "prevStatus": prev})
        if changed:
            _write_atomic(base / "state.json", json.dumps(state, indent=2, ensure_ascii=False) + "\n")
            if events:
                with open(base / "feedback.jsonl", "a", encoding="utf-8") as fh:
                    for ev in events:
                        fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
    return changed


# ── read models ─────────────────────────────────────────────────────────────────────────────

def queue_payload() -> dict:
    base = review_dir()
    state = _load_state(base)
    return {
        "dir": str(base),
        "exists": base.is_dir(),
        "entries": [_entry_row(base, k, v) for k, v in state.items() if isinstance(v, dict)],
        "digest": _read(base / "latest.md"),
    }


def draft_payload(key: str) -> dict:
    if not KEY_RE.match(key):
        raise ValueError("bad key")
    base = review_dir()
    e = _load_state(base).get(key)
    if not isinstance(e, dict):
        raise LookupError("no such review")
    path = _resolve_draft(base, e.get("draft"))
    text = _read(path) if path else ""
    return {"row": _entry_row(base, key, e), "draft": parse_draft(text), "markdown": text, "path": str(path) if path else ""}


def live_payload(refresh: bool = False) -> dict:
    if not _gh_exe():
        return {"available": False, "live": {}}
    base = review_dir()
    return {"available": True, "live": _live_for(_load_state(base), base, refresh)}


def archivable(e: dict, lv: dict | None) -> bool:
    """Merged or closed on GitHub, and safe to archive: pending, or posted and already harvested by the skill."""
    if not lv or lv.get("state") not in ("MERGED", "CLOSED"):
        return False
    status = e.get("status", "pending")
    return status == "pending" or (status == "posted" and bool(e.get("harvested")))


# ── the PR's review chat (a Claude Code session the board recorded in `chat`) ───────────────

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def chat_info(key: str) -> dict:
    """Where the entry's Claude Code session lives, and the command that resumes it."""
    if not KEY_RE.match(key):
        raise ValueError("bad key")
    e = _load_state(review_dir()).get(key)
    if not isinstance(e, dict):
        raise LookupError("no such review")
    sid = str(e.get("chat") or "")
    if not UUID_RE.match(sid):
        return {"id": sid or None, "found": False}
    projects = Path.home() / ".claude" / "projects"
    hits = sorted(projects.glob(f"*/{sid}.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True) if projects.is_dir() else []
    if not hits:
        return {"id": sid, "found": False}
    cwd = ""
    try:
        with open(hits[0], encoding="utf-8") as fh:
            for i, line in enumerate(fh):
                if i > 200:
                    break
                try:
                    cwd = json.loads(line).get("cwd") or ""
                except (ValueError, AttributeError):
                    continue
                if cwd:
                    break
    except OSError:
        pass
    quoted_cwd = cwd
    exists = bool(cwd) and Path(cwd).is_dir()
    if cwd and not exists:
        # A removed worktree: resume from the repo it belonged to.
        root = Path(cwd.split("/.claude/worktrees/")[0])
        while not root.is_dir() and root != root.parent:
            root = root.parent
        quoted_cwd = str(root)
    quoted = "'" + quoted_cwd.replace("'", "'\\''") + "'" if quoted_cwd else ""
    cmd = f"cd {quoted} && claude --resume {sid}" if quoted_cwd else f"claude --resume {sid}"
    return {"id": sid, "found": True, "cwd": cwd, "cwdExists": exists, "command": cmd,
            "updatedAt": datetime.fromtimestamp(hits[0].stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}


# ── on-demand runs ──────────────────────────────────────────────────────────────────────────

RUN_SCOPES = {"all": [], "co": ["--scope", "co"]}
_run_proc: subprocess.Popen | None = None


def _run_file(base: Path) -> Path:
    return base / ".running.json"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def run_status() -> dict:
    """Whether a `run.sh` started from the page (or by hand through the same pid file) is still going."""
    global _run_proc
    base = review_dir()
    if _run_proc is not None and _run_proc.poll() is not None:
        _run_proc = None
    try:
        info = json.loads(_read(_run_file(base)) or "null")
    except ValueError:
        info = None
    if info and (_run_proc is not None or _alive(int(info.get("pid", 0)))):
        return {"running": True, "scope": info.get("scope"), "startedAt": info.get("startedAt")}
    _run_file(base).unlink(missing_ok=True)
    return {"running": False}


def run_start(scope: str) -> dict:
    """Start `run.sh` detached: a full run, or `co` for the codeowner review status only. One at a time."""
    global _run_proc
    if scope not in RUN_SCOPES:
        raise ValueError(f"unknown scope: {scope}")
    base = review_dir()
    script = base / "run.sh"
    if not script.is_file():
        raise LookupError(f"{script} not found: run scripts/install.sh")
    st = run_status()
    if st["running"]:
        raise ValueError(f"a {st['scope']} run is already in progress")
    log = base / "logs"
    log.mkdir(parents=True, exist_ok=True)
    with open(log / "launch.out", "ab") as out:
        _run_proc = subprocess.Popen(
            ["/bin/bash", str(script), *RUN_SCOPES[scope]],
            cwd=str(base), stdout=out, stderr=out, stdin=subprocess.DEVNULL, start_new_session=True,
        )
    started = _now()
    _write_atomic(_run_file(base), json.dumps({"pid": _run_proc.pid, "scope": scope, "startedAt": started}))
    return {"running": True, "scope": scope, "startedAt": started}
