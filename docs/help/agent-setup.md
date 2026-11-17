---
title: "Agent setup: skills and the AGENTS.md block"
summary: See and edit the instructions agents get, give each project Workflow notes, then install them into a repo or user-wide and check them for local edits.
group: Getting started
order: 3
anchors:
  - settings.agent-setup
  - settings.install-log
  - settings.push-folder
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

Agents only follow the files once they're in the right folder. **Install…** puts them there: in the footer of the **Agent files** table (for what **Show files for** shows), or on a project's **Effective agent files** card (for that project).

In the **Install agent files** dialog:

1. **Client:** *Claude Code* or *Codex*.
2. **Install into:**
   - *RCP's repo* (or *A repo* service-wide): the files go into one repository;
   - *User-wide*: they go into your home folder and apply to every project, so they're the service-wide files, without a project's overrides.
3. **How:**
   - *Push (Task Lite writes the files)*: Task Lite writes them itself, into the **Repo folder** you give. It needs a push folder (below); without one, the dialog says why and offers the command.
   - *Copy a command*: Task Lite gives you a command to paste in a terminal.

**What will be written** lists every file, before anything happens:

| | Claude Code | Codex |
|---|---|---|
| Skills | `.claude/skills/<name>/SKILL.md` | `.codex/skills/<name>/SKILL.md` |
| The AGENTS.md block | `CLAUDE.md` (user-wide: `~/.claude/CLAUDE.md`) | `AGENTS.md` (user-wide: `~/.codex/AGENTS.md`) |
| The manifest | `.claude/.tasklite-manifest.json` | `.codex/.tasklite-manifest.json` |

In `CLAUDE.md` or `AGENTS.md`, only the Task Lite section between `<!-- tasklite:begin -->` and `<!-- tasklite:end -->` is touched. If the file has no such section, it's added at the end; everything else in the file stays exactly as it is. A file whose markers are damaged (one missing, or repeated) is left alone, and the install stops and says so. Nothing is ever deleted.

The manifest records the install, and every file's version and fingerprint, so a later check can tell what changed.

**"This block still has n placeholders":** the AGENTS.md block ships with `{{…}}` placeholders for your project's rules. A repo install of a project fills in `{{KEY}}`; the rest is yours to write. *Edit block* opens the block so you can fill them in (as a project override, or service-wide). *Install anyway* installs it as it is.

### By push

Give the **Repo folder**: a folder inside your push folder, like `C:/Users/you/code/recipes`. *Install* writes the files and lists each one as **Created**, **Updated** or **Unchanged**.

### By command

*Create the command* shows a **PowerShell (Windows)** and a **bash (macOS, Linux, Git Bash)** command, each with *Copy*.

- **Run from the repo folder:** open a terminal in the repo, then paste one. It refuses a folder without `.git`, before it downloads anything. (A user-wide command runs anywhere and installs into your home folder.)
- The command downloads the files from Task Lite, puts them in place and fills in the Task Lite section. It needs nothing else installed.
- It works **once**, for **10 minutes**. If it says *Task Lite refused the download*, make a new one.

## The install log and Check

**Install and check → Install log** lists every install: when, the client, where, *Push* or *Command*, and how many files. A command install appears once its command has downloaded the files.

- **Versions sent:** each file, with the layer and version Task Lite sent (for example *Project override v2*), linked to that file's view and its **History**.
- **Check** (push installs): reads the installed files and compares them with what was sent. It says **Up to date**, or lists each file:
  - **Edited locally:** changed by hand since the install; *Show diff* compares the version sent with the copy in the repo;
  - **Missing:** deleted; installing again restores it;
  - **Extra:** a `tasklite-*` skill folder this install didn't write. Task Lite never deletes it.
- **Check command** (command installs): Task Lite can't see that machine, so it gives you a PowerShell and a bash command to run where you installed. It reads the manifest and prints the same list, each file with the version sent. It downloads nothing.

Line endings changed by Git on Windows don't count as edits.

## Set up the push folder

A push folder lets Task Lite write the files for you. It's optional: without it, *Install* gives you a command instead.

**Install and check → Push folder** shows whether one is set up (**Not set up**, **Ready** or **Not writable**), its path on your computer and inside Task Lite, and *Test*, which writes a small file there and removes it.

To set it up, mount the folder that holds your repos into Task Lite. Type that folder into **Your code folder** on the card: the steps update to match, each with *Copy*.

1. Open `docker/compose.yaml` in the folder you installed Task Lite from. Under `volumes:`, below `- tasklite-data:/data`, add a line like `- C:/Users/you/code:/host-code` (keep the indentation). There's a commented example in the file.
2. In the same `docker` folder, open `.env` (create it if it isn't there) and add:

   ```
   TASKLITE_PUSH_ROOT=/host-code
   TASKLITE_PUSH_HOST_PATH=C:/Users/you/code
   ```
3. Restart Task Lite: `docker compose -f docker/compose.yaml up -d`
4. Come back to the card and click *Test*.

Rather not edit `compose.yaml`? The card's *Use an override file instead* gives a `docker/compose.push.yaml` with the same settings, and the command to start Task Lite with it.

Task Lite only ever writes there: the skill folders, its manifest and the marked Task Lite section of `AGENTS.md` or `CLAUDE.md`. It never reads or writes outside the folder you mounted, never follows a link out of it, and never deletes anything. On Linux, the folder must be writable by Task Lite's user (uid 10001).
