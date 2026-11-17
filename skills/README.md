# Task Lite skills

These are agent skills that teach the **workflow** for using Task Lite well. The MCP tools explain each call on its own; these explain the order of calls, the habits that keep runs cheap and recoverable, and the judgement calls (owner decision 27).

| Skill | Status | Give it to |
|---|---|---|
| [`tasklite-worker`](tasklite-worker/SKILL.md) | Core | Every agent that works on items |
| [`tasklite-coordinator`](tasklite-coordinator/SKILL.md) | Core | Whatever dispatches agents: an Orca coordinator, a script, or you |
| [`tasklite-planner`](tasklite-planner/SKILL.md) | Optional | Agents that shape and break down work |
| [`tasklite-review-packet`](tasklite-review-packet/SKILL.md) | Optional | Workers on projects that use human review |
| [`tasklite-lead-subagents`](tasklite-lead-subagents/SKILL.md) | Optional | Leads that fan out to subagents |

## Install

Each skill is a folder with a `SKILL.md`, in the standard skill format. Copy the folders you want into the agent's skills directory:

| Client | User-wide | One project |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` in the repo |
| Codex | `~/.codex/skills/` | see Codex's skills documentation |
| Orca workers | Orca starts the installed Claude Code or Codex, so the folders above apply | |

```bash
# Example: the core skills, user-wide, for Claude Code
cp -r skills/tasklite-worker skills/tasklite-coordinator ~/.claude/skills/
```

Claude Code's project path (`.claude/skills/`) is verified: the B18 skills eval ran with it, headless, and Claude Code invoked both core skills. The user-wide paths, Codex's, and whether Orca workers see user-wide skills are checked in the real-client smoke test (BUILD_SPEC §12, V7; `docker/smoke/OWNER-CHECKLIST.md`).

## Make them yours

They're plain Markdown, so edit them to fit your tooling: your orchestrator's commands, your branch rules, your test commands. Keep project-specific rules in the project's `AGENTS.md` / `CLAUDE.md` ([template](../docs/templates/AGENTS-tasklite.md)). The skills defer to it where they differ.

**Keep them in sync with the tools.** CI parses every `SKILL.md` and fails if it names a tool or a top-level input field that doesn't exist. If you add your own skills here, they get the same check.

## Not (yet) served over MCP

V1 ships skills as files only. Serving them as MCP prompts, so every connected client gets them automatically, is on the [roadmap](../docs/ROADMAP.md).
