# Docket skills

These are agent skills that teach the **workflow** for using Docket well. The MCP tools explain each call on its own; these explain the order of calls, the habits that keep runs cheap and recoverable, and the judgement calls (owner decision 27).

| Skill | Status | Give it to |
|---|---|---|
| [`docket-worker`](docket-worker/SKILL.md) | Core | Every agent that works on items |
| [`docket-coordinator`](docket-coordinator/SKILL.md) | Core | Whatever dispatches agents: an Orca coordinator, a script, or you |
| [`docket-delivery`](docket-delivery/SKILL.md) | Core | Agents taking work through PR, CI, merge and deployment, in any stack. The project's rules win, and it grants no authority (owner decision 52) |
| [`docket-producer`](docket-producer/SKILL.md) | Optional | A session that owns one epic and dispatches independent implementers, with any orchestrator or none. The project's rules and skills win (owner decision 55) |
| [`docket-planner`](docket-planner/SKILL.md) | Optional | Agents that shape and break down work |
| [`docket-review-packet`](docket-review-packet/SKILL.md) | Optional | Workers on projects that use human review |
| [`docket-lead-subagents`](docket-lead-subagents/SKILL.md) | Optional | Leads that fan out to subagents |

## Install

**From Docket (recommended):** open **Agent files**, pick the project in the project switcher, and click *Install into <project>'s repo* (with All projects, choose the project first). Installs are per project (owner decision 50). It installs the skills and the AGENTS.md block that project uses (its own copies where you customized a file, the defaults elsewhere), either by a copy-paste command (PowerShell or bash, single use, 10 minutes) or by writing them into a folder you've mounted (**Settings → One-click install**). Every install is logged with the exact version of each file, and *Check* (or the check command) shows whether an installed copy was edited by hand.

**Connecting comes with it** (owner decision 32). A repo install also writes the repo's connection file: `.mcp.json` for Claude Code, `.codex/config.toml` for Codex, adding or updating only the `docket` server and never a token. Open the client in the repo and approve Docket when it asks (Claude Code: use the `docket` server from `.mcp.json`; Codex: trust the folder); there's nothing to configure by hand. Docket uses local trust by default, so agents need no token; in protected mode the file names the `DOCKET_TOKEN` environment variable instead (see the README, "Protected mode"). A user-wide install writes no connection file: use the README's "A user-wide connection instead".

| Client | Skills, with their references | The AGENTS.md block |
|---|---|---|
| Claude Code | `.claude/skills/<name>/` | `CLAUDE.md` |
| Codex | `.codex/skills/<name>/` | `AGENTS.md` |

The block goes between `<!-- docket:begin -->` and `<!-- docket:end -->`; nothing else in the file changes. A `.docket-manifest.json` in `.claude/` or `.codex/` records what was sent.

**By hand:** each skill is a folder with a `SKILL.md`, in the standard skill format, and usually a `references/` folder next to it. Copy the whole folders you want into the repo's skills directory (this copies Docket's versions, without your edits in Agent files). Keep them in the repo: a copy in your home folder reaches every project on the computer.

| Client | One project |
|---|---|
| Claude Code | `.claude/skills/` in the repo |
| Codex | see Codex's skills documentation |
| Orca workers | Orca starts the installed Claude Code or Codex, so the folders above apply |

```bash
# Example: the core skills, for Claude Code, from this folder into a repo
cp -r skills/docket-worker skills/docket-coordinator /path/to/repo/.claude/skills/
```

Claude Code's project path (`.claude/skills/`) is verified: the B18 skills eval ran with it, headless, and Claude Code invoked both core skills. The user-wide paths, Codex's, and whether Orca workers see user-wide skills are checked in the real-client smoke test (BUILD_SPEC §12, V7; `docker/smoke/OWNER-CHECKLIST.md`).

## Make them yours

They're plain Markdown, so edit them to fit your tooling: your orchestrator's commands, your branch rules, your test commands. Edit them in **Agent files**: the default (with All projects selected), or a project's own copy (*Customize for <project>*), with history and comparisons; then install again. Keep project-specific rules in the project's **Workflow notes**, which agents get in `get_context` for every item in the project ([starter](../docs/templates/WORKFLOW-starter.md)). The installed `AGENTS.md` / `CLAUDE.md` section ([block](../docs/templates/AGENTS-docket.md)) is the same for every project. The skills defer to the Workflow notes where they differ.

**Changes from agents, and edits by hand.** Agents don't edit their installed files: the skills tell them to read a file with `get_agent_files` and propose a change with `propose_agent_file_change`, which waits for your approval in Agent files (FR-128–FR-130). Each install also puts a `docket-check` script (`.sh` and `.ps1`) next to the manifest. Agents run it once per session and pass its one line of JSON as `instructions` on `claim_lead`: each file's hash, plus the text of any file that differs. That, and a scheduled check of folders Docket installed into (`DOCKET_DRIFT_CHECK_INTERVAL`, 15 minutes by default), shows you "edited outside Docket" with a diff, and *Adopt*, *Restore Docket's version* or *Keep local*.

**Updates.** Docket publishes a new version; each project takes it in through its own workflow (decision 56). Each install has a `docket-update` script (`.sh` and `.ps1`) next to `docket-check`. A project's coordinator runs it on its own branch and merges the result through the usual PR and CI. It keeps anything edited locally, and never commits or pushes. An install from before it existed gets the exact command from `get_digest` or `claim_lead`.

**Waiting.** Each install also puts a `docket-wait` script (`.sh` and `.ps1`) next to `docket-check`. Agents run it to wait for a change without spending model tokens (decision 40). It's in the manifest, so *Check* and drift cover it.

**Keep them in sync with the tools.** CI parses every `SKILL.md` and every reference, and fails if one names a tool or a top-level input field that doesn't exist, or if a file passes its cap (below). If you add your own skills here, they get the same checks.

## A core, and references read on demand

Every agent that loads a skill pays for all of it, on every turn. So each skill keeps a **core** and puts rare paths in **reference files** that an agent reads only when it needs them (owner decision 66).

```text
docket-worker/
  SKILL.md                  the core: what every run needs
  references/
    exit-reports.md         read only when its gate says so
    shared-parts.md
```

**The core** (`SKILL.md`) is enough for the common path on its own. It ends with a References table:

```markdown
## References

| File | Read when | Don't read when |
| --- | --- | --- |
| [`references/exit-reports.md`](references/exit-reports.md) | You leave with work undone, or your context shows `finished partly:`. | Every acceptance item is this ticket's own and you finish it all. |
```

**A reference** has no frontmatter, starts with a `# ` heading and then the same two gate lines, word for word, before any detail:

```markdown
# Acceptance, known gaps and exit reports

**Read when:** You leave with work undone, or your context shows `finished partly:`.
**Don't read when:** Every acceptance item is this ticket's own and you finish it all.
```

**Writing the gates.**

- **Read when** names the concrete trigger an agent can see: an error code, a line in its context, a call it's about to make, a situation ("You park", "`epic_not_ready`").
- **Don't read when** names the common case that doesn't need it, so the agent can skip it with confidence. Never "if unsure, read it".
- Keep each to one sentence. In the core, point to it by name where the trigger happens ("read the waiting reference").

**What stays in the core.** Everything the common path needs, and **every safety rule**: never do X, owner-only actions, never wait in a loop, never prune what's in use. A gate may hide detail, never a rule that stops harm. CI checks that each core still holds its safety rules.

**Adding something.** New detail for a rare path goes into the right reference, or a new one listed in the table; new rules for every run go in the core. Don't grow the core past its target to avoid writing a reference. A skill small enough to read whole (`docket-review-packet`, `docket-lead-subagents`) has no references and no table.

**Caps** (characters ÷ 4):

| File | Lines | Tokens |
|---|---|---|
| `SKILL.md` | 500 | 4,800, and 3,600 after the split, for headroom |
| `references/<topic>.md` | 300 | 3,000 |

CI also fails when a reference lacks its gate lines, isn't listed in its skill's table, or its table entry's gates differ from the file's, and when the table lists a file that doesn't exist. Name a reference `<topic>.md` with `a-z`, `0-9` and single hyphens.

**Tool descriptions point here.** An MCP tool description says what the tool does and its key fields; where it needs more words it ends "Details: docket-worker reference shared-parts.", and the explanation lives in that reference.

**Installed with the skill.** Each reference is an agent file of its own (`skill:docket-worker--exit-reports` in Agent files), with versions, edits, proposals and drift. Installs and `docket-update` write it to `.claude/skills/<name>/references/<topic>.md`, and remove one Docket no longer ships while it's unmodified (an edited one is kept and listed). `docket-check` reports a reference only when it differs, so a claim stays small.

## Not (yet) served over MCP

V1 ships skills as files only. Serving them as MCP prompts, so every connected client gets them automatically, is on the [roadmap](../docs/ROADMAP.md).
