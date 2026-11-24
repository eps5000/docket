---
title: Workspace states and safe pruning
summary: What In use, Parked, At risk, Safe to prune and Unknown mean, and when a worktree can be deleted.
group: Recovery
order: 1
anchors:
  - agents.workspaces
related:
  - crash-recovery
  - run-states
---

A **workspace** is the folder (usually a git worktree) where an agent works on an item. Agents report it when they claim work, along with its branch, commits and anything they left running, like a dev server. **Agents → Workspaces** lists every one, so you and your coordinator can see what's safe to delete.

The main table shows what agents report. **Every worktree** also reads your repository, without changing it. Docket never deletes a worktree or stops a process; your coordinator, or you, do that.

**The helper reads your worktrees.** Docket runs in a container and reads no git itself. The Docket helper on your computer reads every worktree. It runs every few minutes, changes nothing, and never sends file names. See its status in **Settings → Connections → Git checks**. Until it reports, the list says it's waiting for the host helper, and work left in a worktree shows as the last reported state (unverified). If the helper stops, its answers go back to **Unknown** after 10 minutes, so an old answer can never make a worktree look safe to remove.

## The states

| State | What it means | Prune it? |
|---|---|---|
| **In use** | A run is working in it. | No |
| **Parked** | Its run is parked: waiting on purpose, with its claim kept. | No |
| **At risk** | Nothing is running, but work could be lost: uncommitted changes, commits that aren't pushed, something still running, or a run that ended unexpectedly on an item that's still open. | No. Deal with the work first. |
| **Safe to prune** | Every run ended, the work is pushed and clean, everything it started is released, and nothing waits to be picked up again. | Yes |
| **Unknown** | Not enough was reported to tell. | Treat it as not safe. |

**Idle is not finished.** A quiet worktree can still hold the only copy of an agent's work.

## Reading the table

- **Pushed:** ✓ when the latest commit is pushed, or "n behind" when it isn't.
- **Resources:** how many things the agent started and hasn't released (a dev server, a container).
- **Hide safe to prune** is on by default, so the list shows what needs attention. Click it to see everything.
- **What to do:** whether an at-risk worktree needs you (below).

At-risk workspaces sort first, and the section header counts them.

## Does an at-risk worktree need you?

Usually not. Overview's Health card says so in one line, for example "3 worktrees hold unsaved work. None need you: agents own 2, and you kept 1 for later." The **What to do** column gives the answer for each one:

- **Needs your choice:** no agent has it, or agents didn't deal with it in time. *See Problems* takes you to the choice.
- **An agent owns it:** its lead or coordinator will deal with it. There's nothing for you to do.
- **You kept it for later:** you chose *Keep for later*. It stays At risk on purpose, so nothing prunes it.
- **You acknowledged it:** you've seen its problem, and it won't ask again unless something changes.
- **Docket can't tell who owns it:** nobody is recorded on it. Ask your coordinator to check it.

In every case, leave the worktree where it is until the work is dealt with.

## Orphaned resources

When a run ends and something it started is still listed as running 15 minutes later, Problems shows **Orphaned resources**, like "vite :5173 still running 18m after its run ended". Stop it yourself (or have your coordinator do it), then click *Mark released*.

## Every worktree

Agents only report the worktrees they use, so a busy repository can hold many more. Choose **Every worktree** to list them all, including ones marked **Not tracked by Docket**. The helper on your computer reads them. It doesn't fetch and writes nothing.

| Verdict | What it means |
|---|---|
| **Safe to remove** | It's clean, its commits are on a remote or in main, and nothing is running in it. |
| **Holds work** | It has uncommitted files, commits on no remote, something still running, or a run that ended unexpectedly. |
| **In use** | A run is working or parked in it, or it's the repository's main folder. |
| **Kept for later** | You chose *Keep for later*, or it's locked in git. |
| **Unknown** | Docket can't tell. Git didn't answer in time, the folder is gone, the helper's last check is too old, or it has no run and changed in the last day. **Treat it as not safe.** |

Only **Safe to remove** offers a command. **Check it before you run it.** Git refuses to remove a folder with changes and keeps the branch, but ignored files, like `.env` or build output, are deleted with the folder. Remotes are as of your last fetch.

## Pruning safely

Ask your coordinator to prune, not to guess: the `docket-coordinator` skill prunes only workspaces that are **Safe to prune**. If you prune by hand, check this table first.

For an at-risk workspace after a crash, see [Recovering after a crash](/help/crash-recovery).
