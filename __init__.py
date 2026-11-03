"""Reviews: the agent half ships the two skills the queue runs on; the page is desktop/plugin.js and its
backend is dashboard/plugin_api.py.

Hermes lists them as `reviews:review-queue` and `reviews:codeowner-review`. Claude Code gets the same files
through links that scripts/install.sh puts in ~/.claude/skills, so both harnesses read one copy.
"""
from pathlib import Path

SKILLS = ("review-queue", "codeowner-review")


def _description(skill_md: Path) -> str:
    # The frontmatter's `description:` (a folded `>` block in these skills), flattened to one line.
    lines = skill_md.read_text(encoding="utf-8").split("\n")
    if not lines or lines[0].strip() != "---":
        return ""
    out, grab = [], False
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if line.startswith("description:"):
            rest = line.split(":", 1)[1].strip()
            grab = rest in (">", "|", ">-", "|-")
            if not grab:
                return rest.strip("\"'")
        elif grab:
            if line.startswith((" ", "\t")):
                out.append(line.strip())
            else:
                break
    return " ".join(out)


def register(ctx):
    root = Path(__file__).resolve().parent / "skills"
    for name in SKILLS:
        path = root / name / "SKILL.md"
        if path.is_file():
            ctx.register_skill(name, path, description=_description(path))
