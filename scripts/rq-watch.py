#!/usr/bin/env python3
"""rq-watch: the review queue's no-LLM watcher. Costs no tokens; stays silent unless something changed.

Every run (hourly through launchd) it reads each open entry's PR with `gh` and:
  - with --archive, archives the reviews whose PR is merged or closed (pending ones, and posted ones the skill has
    already harvested), the same way the Reviews page does, logged as `"source": "reviews-watch"`;
  - sends one macOS notification when a pending draft went stale (the PR head moved since the draft) or a PR got
    merged/closed, once per change: what it already told you is kept in <queue>/.watch.json.

Usage: rq-watch.py [--archive] [--quiet] [--dry-run]
Stdlib only (runs on macOS's /usr/bin/python3). REVIEW_DIR overrides the queue folder.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path


def load_core():
    path = Path(__file__).resolve().parent.parent / "dashboard" / "reviews_core.py"
    spec = importlib.util.spec_from_file_location("hermes_reviews_core", path)
    if spec is None or spec.loader is None:
        sys.exit(f"rq-watch: {path} not found")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["hermes_reviews_core"] = mod
    spec.loader.exec_module(mod)
    return mod


def notify(title: str, body: str) -> None:
    script = f"display notification {json.dumps(body)} with title {json.dumps(title)}"
    subprocess.run(["osascript", "-e", script], capture_output=True, check=False)


def main() -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    ap.add_argument("--archive", action="store_true", help="archive reviews whose PR is merged or closed")
    ap.add_argument("--quiet", action="store_true", help="no macOS notification")
    ap.add_argument("--dry-run", action="store_true", help="report only: no writes, no notification")
    args = ap.parse_args()

    core = load_core()
    base = core.review_dir()
    if not (base / "state.json").is_file():
        print(f"rq-watch: no queue at {base}")
        return 0
    payload = core.live_payload(refresh=True)
    if not payload["available"]:
        print("rq-watch: gh not found")
        return 1
    live = payload["live"]
    state = core._load_state(base)
    errors = [k for k, v in live.items() if v.get("error")]

    seen_path = base / ".watch.json"
    try:
        seen = json.loads(seen_path.read_text())
    except (OSError, ValueError):
        seen = {}

    gone = [k for k, e in state.items() if isinstance(e, dict) and core.archivable(e, live.get(k))]
    stale = {k: v["head"] for k, v in live.items()
             if not v.get("error") and v.get("state") == "OPEN" and v.get("headMoved") and state.get(k, {}).get("status") == "pending"}

    archived: list[dict] = []
    if args.archive and gone and not args.dry_run:
        merged = [k for k in gone if live[k]["state"] == "MERGED"]
        closed = [k for k in gone if live[k]["state"] == "CLOSED"]
        for keys, status in ((merged, "merged"), (closed, "closed")):
            if keys:
                archived += core.apply_status(keys, status, source="reviews-watch", via="the rq-watch watcher")

    new_stale = sorted(k for k, head in stale.items() if seen.get(f"stale:{k}") != head)
    new_gone = sorted(k for k in gone if not seen.get(f"gone:{k}"))
    lines = []
    if archived:
        lines.append(f"Archived {len(archived)} merged/closed: {', '.join(c['key'] for c in archived)}")
    elif new_gone:
        lines.append(f"{len(new_gone)} already merged/closed: {', '.join(new_gone)}")
    if new_stale:
        lines.append(f"{len(new_stale)} draft{'s' if len(new_stale) != 1 else ''} went stale: {', '.join(new_stale)}")

    print(f"rq-watch: {len(live)} watched, {len(gone)} merged/closed, {len(stale)} stale, {len(errors)} gh errors")
    for line in lines:
        print(f"  {line}")
    if args.dry_run:
        return 0
    if lines and not args.quiet:
        notify("Review queue", " · ".join(lines))

    seen = {f"stale:{k}": head for k, head in stale.items()} | {f"gone:{k}": True for k in gone if k not in {c["key"] for c in archived}}
    core._write_atomic(seen_path, json.dumps(seen, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
