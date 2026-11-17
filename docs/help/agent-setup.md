---
title: "Agent setup: skills and the AGENTS.md block"
summary: Give your agents the Task Lite skills and the project rules block, so they follow the workflow without being told each time.
group: Getting started
order: 3
anchors: []
related:
  - connect-an-agent
  - crash-recovery
---

Connecting an agent gives it Task Lite's tools. The **agent files** teach it the workflow: the order of calls, and habits that keep work recoverable. There are two kinds:

- **Skills**, one folder each with a `SKILL.md`:
  - `tasklite-worker`, for every agent that works on items;
  - `tasklite-coordinator`, for whatever dispatches agents: an Orca coordinator, a script, or you;
  - optional: `tasklite-planner`, `tasklite-review-packet` and `tasklite-lead-subagents`.
- **The AGENTS.md block:** your project's rules (who moves work to Ready, when human review is required, which planning documents are expected), pasted into the repo's `AGENTS.md` (Codex) or `CLAUDE.md` (Claude Code).

## Install them today

The files are in the Task Lite repository: skills in `skills/`, the block in `docs/templates/AGENTS-tasklite.md`.

1. Copy at least `tasklite-worker` and `tasklite-coordinator` into your agents' skills folder:
   - Claude Code: `~/.claude/skills/` for every project, or `.claude/skills/` in one repo;
   - Codex: `~/.codex/skills/`;
   - Orca workers start the Claude Code or Codex you installed, so the same folders apply.

   For example, from the repository root: `cp -r skills/tasklite-worker skills/tasklite-coordinator ~/.claude/skills/`
2. Paste `AGENTS-tasklite.md` into the project's `AGENTS.md` or `CLAUDE.md`, and fill in its placeholders.

The skills are plain Markdown, so you can edit them to fit your tools. Keep project-specific rules in the AGENTS.md block: the skills defer to it.

## Coming soon

These parts of agent setup aren't in this version yet. This article will be updated when they ship.

- **Settings → Agent setup:** see exactly which instructions agents get, edit them for every project or just one, with history and diffs, and get told when an upgrade changes a file you edited.
- **Workflow notes:** per-project notes that agents receive with every item's context.
- **Install from Task Lite:** install the files into a repo or user-wide with one copy-paste command, or with one click if you've mounted a folder, and later check whether an installed copy was edited by hand.
