---
title: "Agent setup: skills and the AGENTS.md block"
summary: See and edit the instructions agents get, service-wide or per project, with history and diffs, and give each project Workflow notes.
group: Getting started
order: 3
anchors:
  - settings.agent-setup
related:
  - connect-an-agent
  - crash-recovery
---

Connecting an agent gives it Task Lite's tools. The **agent files** teach it the workflow: the order of calls, and habits that keep work recoverable. There are two kinds:

- **Skills**, one folder each with a `SKILL.md`:
  - `tasklite-worker`, for every agent that works on items;
  - `tasklite-coordinator`, for whatever dispatches agents: an Orca coordinator, a script, or you;
  - optional: `tasklite-planner`, `tasklite-review-packet` and `tasklite-lead-subagents`.
- **The AGENTS.md block:** your project's rules (who moves work to Ready, when human review is required, which planning documents are expected), which goes in the repo's `AGENTS.md` (Codex) or `CLAUDE.md` (Claude Code).

## See what agents get

Open **Settings → Agent setup**. The **Agent files** table lists every file with:

- **Comes from:** where the version in use comes from:
  - **Bundled:** the copy that ships with Task Lite;
  - **Your edit:** your service-wide edit, used for every project;
  - **Project override:** an edit for one project only.

  A project override wins over your edit, and your edit wins over bundled.
- **Version:** the version in use, and when it was made.
- **Bundled version updated:** shown when an upgrade of Task Lite changed a file you had edited. Your version is kept; see below.

**Show files for** switches between *Service-wide* and one project, so you see exactly what that project's agents get.

## Read a file

Click a file's name to open it under the table.

- **Layer** shows the **Bundled**, **Service-wide** or project version. A line says which one is in use.
- **Show as** switches between **Rendered** and **Raw**.
- **History** lists every version of that layer, with who made it, when and their note. *Diff v1 → v2* on a version shows what changed.
- **Diff against** compares the version you're looking at with any other version or layer.

## Edit a file

1. Pick the layer: **Service-wide** for every project, or the project to override it there. On **Bundled**, click *Edit service-wide*.
2. Click *Edit*, change the text, and write a **Note (required)** saying what changed and why.
3. Save. Every save adds a version; older ones stay in **History**.

*Revert to bundled* (or *Revert to service-wide* on a project override) takes your edit out of use, so the layer below applies again. Its versions stay in **History**, and later upgrades of the bundled file reach agents again.

**When "Bundled version updated" shows:** Task Lite now ships a newer bundled copy than the one your edit was based on. Your edit stays in use. Use *Diff bundled v1 → v2* to see what changed upstream, and *Diff bundled v2 → your edit* to compare it with yours. Then either revert, or edit again: saving an edit bases it on the new bundled version and clears the flag.

## Workflow notes for a project

Each project has **Workflow notes**: its own rules for agents, like branch names, how reviews work, or what "ready" means. Agents get them in `get_context` for every item in the project.

To open them, pick the project in **Show files for**, or click *Agent files & workflow* on the project in **Settings → General → Projects**. The project's **Agent files & workflow** section shows:

- **Workflow notes:** click *Edit*, write the notes in Markdown (up to 10,000 characters), add an optional note, and save. Each save is a new version, with its history and diffs. Saving them empty clears them.
- **Effective agent files:** every file, and which layer it comes from for this project.

## Install the files

The files in the Task Lite repository (`skills/` and `docs/templates/AGENTS-tasklite.md`) are the bundled versions. Until Task Lite can install them for you, copy them by hand:

1. Copy at least `tasklite-worker` and `tasklite-coordinator` into your agents' skills folder:
   - Claude Code: `~/.claude/skills/` for every project, or `.claude/skills/` in one repo;
   - Codex: `~/.codex/skills/`;
   - Orca workers start the Claude Code or Codex you installed, so the same folders apply.

   For example, from the repository root: `cp -r skills/tasklite-worker skills/tasklite-coordinator ~/.claude/skills/`
2. Paste `AGENTS-tasklite.md` into the project's `AGENTS.md` or `CLAUDE.md`, and fill in its placeholders.

Hand-copied files don't include edits you made in Agent setup. Copy the text from the **Raw** view if you need them.

## Coming next

- **Install from Task Lite:** install the effective files into a repo or user-wide with one copy-paste command, or with one click if you've mounted a folder, with an install log of every version sent.
- **Check an install:** see whether an installed copy was edited by hand, file by file.

This article will be updated when they ship.
