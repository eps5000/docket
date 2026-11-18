---
title: "Agent files: skills, the AGENTS.md block and Workflow notes"
summary: Edit the skills and Workflow notes agents get, review the changes they propose, install the files, and catch edits made outside Task Lite.
group: Getting started
order: 3
anchors:
  - agent-files.page
  - agent-files.workflow
  - agent-files.install-log
  - settings.push-folder
  - problems.agent_files_drift
related:
  - connect-an-agent
  - crash-recovery
---

Connecting an agent gives it Task Lite's tools. The **agent files** teach it the workflow: the order of calls, and habits that keep work recoverable. There are two kinds:

- **Skills**, one folder each with a `SKILL.md`:
  - `tasklite-worker`, for every agent that works on items;
  - `tasklite-coordinator`, for whatever dispatches agents: an Orca coordinator, a script, or you;
  - optional: `tasklite-planner`, `tasklite-review-packet` and `tasklite-lead-subagents`.
- **The AGENTS.md block:** a short section for the repo's `AGENTS.md` (Codex) or `CLAUDE.md` (Claude Code). It's the same for every project: it says the work lives in Task Lite, to follow `tasklite-worker`, and the rules every agent keeps (claim first, push at every step, park instead of going quiet, and so on).

Each project's own rules go in its **Workflow notes** (below), which agents get with every item.

Open **Agent files** in the sidebar. Like the other pages, it follows the project switcher: pick **All projects** to see the defaults, or one project to see what that project uses.

## Default, or a project's copy

Every file has a **default**: what every project uses. It starts as **Task Lite's version**, the copy that ships with Task Lite. You can edit the default; then it shows as **Edited**, and *Reset to Task Lite's version* goes back.

For one project, you can **customize** a file: the project gets **its own copy**, and only its agents use it. Other projects keep the default. A project with no copy of a file simply uses the default.

## With All projects selected

**Agent files · Defaults** lists every file with:

- **Default:** *Task Lite's version*, or *Edited* and when, with *Reset*;
- **Customized in:** the projects that have their own copy, each linked to that project's view of the file.

Click a file's name to open it. Here, *Edit* changes **the default**, for every project without its own copy.

*Install user-wide* installs the defaults into your home folder (see **Install the files**). The **Install log** at the bottom lists every install.

## With one project selected

**Agent files · Recipe App** (for example) shows, from the top:

1. **Workflow notes** for the project (below).
2. Every file and what the project is **Using**:
   - **Default** (or **Default (edited)**), with *Customize for Recipe App*;
   - **Recipe App's copy** and when it was edited, with *Edit* and *Use default*.
3. The **Install log** of this project's installs.

*Customize for Recipe App* opens the editor on a new copy, starting from the current default. Saving creates the copy.

*Use default* switches the project back to the default. The copy isn't lost: its versions stay in **History**, and the toast's *Undo* brings it back.

**"The default changed since Recipe App's copy was made":** the default was edited, or Task Lite shipped a new version, after the project's copy was made. The copy stays in use. *Compare* shows what changed in the default, and the default next to the copy. Then edit the copy to take what you need (saving clears the flag), or *Use default*.

## Open a file

Click a file's name. The file opens under the list:

- **Show as** switches between **Rendered** and **Raw**.
- *Edit* (or *Customize for …*): change the text, write a **Note (required)** saying what changed and why, and save. Every save adds a version.
- *History* lists every version, with who made it, when and their note. *View* shows an earlier version; *Compare with the one before* shows what changed.
- **Compare with** compares the version you're looking at with the default, or any earlier version.

With **All projects**, when Task Lite ships a new version of a file whose default you edited, the file says **Task Lite's version changed since the default was edited**. Your edit stays in use. *What Task Lite changed* and *Task Lite's version → the default* compare them; edit again to take what you need, or reset.

## Workflow notes

Each project has **Workflow notes**: its own rules for agents. Agents get them with every item in the project, in `get_context`, and they take precedence over the skills and the AGENTS.md block.

They sit at the top of **Agent files** with the project selected:

- Click *Edit*, write the notes in Markdown (up to 10,000 characters), add an optional note, and save. Each save is a new version, with its history and diffs. Saving them empty clears them.
- **Start from template** (when the notes are empty) loads suggested rules into the editor, unsaved: who moves work to Ready, the planning documents expected, when human review is required, the blocker rule, branch naming, the checks to run, decisions worth recording, and labels. Each has a suggested answer already written in; change what doesn't fit, then save.

## Changes agents propose

Agents often want to tailor their instructions for a project. They don't edit the files: the shipped skills tell them to read a file with `get_agent_files` and propose a change with `propose_agent_file_change`, with a short reason, and to tell you they did. Nothing changes until you decide.

- **Needs you** shows one line, **n agent file changes proposed**, which opens Agent files.
- **Proposed changes · n** sits at the top of a project's Agent files, above the files. With **All projects**, it lists changes proposed for the default, and a line for each project that has its own.
- A file with a proposal waiting shows a **1 proposal** chip.

Each proposal shows the file, which agent proposed it and on which item, its reason, and what would change compared with the version in use. Then:

- *Approve* saves the agent's text as the project's copy (or as the default, for a change proposed to the default, or as the Workflow notes). Its history says **proposed by codex · orca-w3 · approved by owner**. The toast's *Undo* takes it back. The next install, and `get_context` for Workflow notes, use it.
- *Edit, then approve* opens the agent's text in the editor; your edited text is what's saved.
- *Decline…* closes it, with an optional note. It can't be undone; the agent can propose again.

**Changed since the agent read it:** you (or another approval) changed the file after the agent read it. The proposal shows both changes, what changed since the agent read it and what the agent proposes, so approving doesn't silently drop your edit. *Approve* asks first; *Edit, then approve* lets you keep both.

At most five proposals wait per file. When an agent proposes again from the same run, its new proposal replaces its earlier one.

## Changed outside Task Lite

Sometimes someone edits an installed file directly instead: a person in their editor, or an agent told to. Every later agent there follows the edited file, so Task Lite looks for that in two ways:

- **The scheduled check:** every 15 minutes (and when Task Lite starts), it reads each folder it installed into by push, and compares every file with what it sent. It only reads; it never writes there. Set `DOCKET_DRIFT_CHECK_INTERVAL` to change how often (at least `1m`), or to `off`.
- **Agents' reports:** each install puts a small `tasklite-check` script next to the manifest (`.claude/tasklite-check.sh` and `.ps1`, or under `.codex/`). The shipped skills tell agents to run it once per session and pass its output when they claim an item. It sends each file's fingerprint, and the text of any file that differs. That covers installs made by command, where Task Lite can't see the files itself: an edit shows up by the next claim there.

Either way, you see:

- **Problems** in Needs you: **"tasklite-worker edited outside Task Lite · Recipe App · C:/code/recipes"**, then how it was found. *Review* opens it in Agent files.
- **Changed outside Task Lite · n** at the top of Agent files, and a **changed outside Task Lite** chip on the file's row. Each one says where (the folder, the client, and whether Task Lite wrote the files or a command did), how it was found (the scheduled check, or *reported by codex · orca-w3 on RCP-17*), and what changed: a diff of Task Lite's version against the local file. A deleted file shows as **Missing**; a `tasklite-*` skill folder the install didn't write shows as **Extra**.
- On the ticket, the run says which instructions it worked from: **Instructions: tasklite-worker · Recipe App's copy v2**, with an **edited locally** chip that opens the change.

Then pick one:

- *Adopt as Recipe App's copy* (or *Adopt as the default*, for a user-wide install): the local text becomes the project's copy, like your own edit, and the toast's *Undo* takes it back. It needs the local text: if Task Lite only has the fingerprint, it says **Run tasklite-check on that machine to send the text**, and the next agent claim there sends it. A missing file can't be adopted.
- **Content withheld: it looked like a secret:** the local file contains something like a token. Task Lite keeps only its fingerprint, never the text, so there's no diff and no *Adopt*; the agent's claim still goes through. Remove the secret from the file there, and the next report sends the text.
- *Restore Task Lite's version*: installs again. When Task Lite wrote the files, it writes them back now; for a command install, it gives you a new command to run there. Task Lite never deletes files, so an extra folder can't be restored away: remove it yourself, or keep it.
- *Keep local*: you meant it. Nothing is changed, and the same file raises nothing again; if it changes again, you're told again.

A file that goes back to exactly what Task Lite sent closes its entry by itself. Files Task Lite never installed (your own skills) are listed on the run, but never raised as a problem. Line endings changed by Git on Windows don't count as edits.

## Install the files

Agents only follow the files once they're in the right folder. With a project selected, **Install into Recipe App's repo** puts that project's files (its copies where you customized a file, the defaults elsewhere) into its repository. With **All projects**, **Install user-wide** puts the defaults in your home folder, for every project on that computer.

In the dialog:

1. **Client:** *Claude Code* or *Codex*.
2. **Repo folder** (repo installs): the repo's folder on your computer, like `C:/Users/you/code/recipes`. Task Lite fills in the folder from the project's last install.
3. The method is chosen for you:
   - **Task Lite writes the files into this folder itself** when a push folder is set up and the folder is inside it. *Copy a command instead* switches to a command.
   - **You'll get a command to paste in a terminal** otherwise. The dialog says why, and offers *Set up one-click install* when no push folder is set up.

**What will be written** (click to open) lists every file, before anything happens:

| | Claude Code | Codex |
|---|---|---|
| Skills | `.claude/skills/<name>/SKILL.md` | `.codex/skills/<name>/SKILL.md` |
| The AGENTS.md block | `CLAUDE.md` (user-wide: `~/.claude/CLAUDE.md`) | `AGENTS.md` (user-wide: `~/.codex/AGENTS.md`) |
| The manifest | `.claude/.tasklite-manifest.json` | `.codex/.tasklite-manifest.json` |

In `CLAUDE.md` or `AGENTS.md`, only the Task Lite section between `<!-- tasklite:begin -->` and `<!-- tasklite:end -->` is touched. If the file has no such section, it's added at the end; everything else in the file stays exactly as it is. A file whose markers are damaged (one missing, or repeated) is left alone, and the install stops and says so. Nothing is ever deleted.

The manifest records the install, and every file's version and fingerprint, so a later check can tell what changed.

**"This block still has n placeholders":** shown only if the AGENTS.md block you're installing still has a `{{…}}` in it (Task Lite's version has none). A repo install fills in `{{KEY}}` with the project key by itself. *Edit block* opens the block; *Install anyway* installs it as it is.

### When Task Lite writes the files

*Install* writes them into the **Repo folder** and lists each one as **Created**, **Updated** or **Unchanged**.

### By command

*Create the command* shows a **PowerShell (Windows)** and a **bash (macOS, Linux, Git Bash)** command, each with *Copy*.

- **Run from the repo folder** (when you left the folder empty): open a terminal in the repo, then paste one. It refuses a folder without `.git`, before it downloads anything. A user-wide command runs anywhere and installs into your home folder.
- The command downloads the files from Task Lite, puts them in place and fills in the Task Lite section. It needs nothing else installed.
- It works **once**, for **10 minutes**. If it says *Task Lite refused the download*, make a new one.

## The install log and Check

The **Install log** at the bottom of Agent files lists installs: with a project selected, that project's; with **All projects**, every install. Each row shows when, the client, where, *Push* or *Command*, and how many files. A command install appears once its command has downloaded the files.

- **Versions sent:** each file, with the version Task Lite sent (for example *Recipe App's copy v2* or *Task Lite's version v1*), linked to that file.
- **Check** (when Task Lite wrote the files): reads the installed files and compares them with what was sent. It says **Up to date**, or lists each file:
  - **Edited locally:** changed by hand since the install; *Show diff* compares the version sent with the copy in the repo;
  - **Missing:** deleted; installing again restores it;
  - **Extra:** a `tasklite-*` skill folder this install didn't write. Task Lite never deletes it.
- **Check command** (command installs): Task Lite can't see that machine, so it gives you a PowerShell and a bash command to run where you installed. It reads the manifest and prints the same list, each file with the version sent. It downloads nothing.

Line endings changed by Git on Windows don't count as edits.

## Set up one-click install (the push folder)

A push folder lets Task Lite write the files for you. It's optional: without it, Install gives you a command instead. It's set up once for the whole service, in **Settings → One-click install**; Agent files links there (*Set up one-click install*) while it isn't set up.

The **Push folder** card shows whether one is set up (**Not set up**, **Ready** or **Not writable**), its path on your computer and inside Task Lite, and *Test*, which writes a small file there and removes it.

To set it up, mount the folder that holds your repos into Task Lite. Type that folder into **Your code folder** on the card: the steps update to match, each with *Copy*.

1. Open `docker/compose.yaml` in the folder you installed Task Lite from. Under `volumes:`, below `- tasklite-data:/data`, add a line like `- C:/Users/you/code:/host-code` (keep the indentation). There's a commented example in the file.
2. In the same `docker` folder, open `.env` (create it if it isn't there) and add:

   ```
   DOCKET_PUSH_ROOT=/host-code
   DOCKET_PUSH_HOST_PATH=C:/Users/you/code
   ```
3. Restart Task Lite: `docker compose -f docker/compose.yaml up -d`
4. Come back to the card and click *Test*.

Rather not edit `compose.yaml`? The card's *Use an override file instead* gives a `docker/compose.push.yaml` with the same settings, and the command to start Task Lite with it.

Task Lite only ever writes there: the skill folders, its manifest and the marked Task Lite section of `AGENTS.md` or `CLAUDE.md`. It never reads or writes outside the folder you mounted, never follows a link out of it, and never deletes anything. On Linux, the folder must be writable by Task Lite's user (uid 10001).
