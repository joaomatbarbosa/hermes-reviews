# review-queue config

Copy to `~/review-queue/config.md` (scripts/install.sh does it) and fill in every `<...>`. The review-queue skill
reads it at the start of every run; it is never committed.

- Jira cloudId: `<cloudId>`
- GitHub org: `<org>`
- My GitHub login: `<login>`
- My Jira name: `<display name>`
- JQL: `project = <KEY> AND status in ("In Review") AND issuetype not in (Epic, Story, Spike) ORDER BY updated DESC`
- Extra sensitive areas: `<services or paths that always get the deepest review>`
