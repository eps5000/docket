---
title: Recovering after a crash
summary: What you see after an agent, Orca or Docket stops unexpectedly, and how your coordinator picks the work back up.
group: Recovery
order: 2
anchors:
  - agents.recent
related:
  - workspaces-and-pruning
  - run-states
---

When an agent, your coordinator (such as Orca) or Docket itself stops unexpectedly, the work isn't lost. Docket keeps each run's checklist, logs, brief (the instructions the agent was given), worktree, branch and commits, so it can be restarted without guessing.

## What you see

- **A Docket restart doesn't end work.** Open runs stay open, with their claim, worktree and run ID, and each lease lasts at least 15 more minutes. Each agent's next call simply continues, so you don't need to park agents before an update. Settings → **Service health** says how many runs were kept.
- **Runs that don't come back end as interrupted, never finished.** If an agent goes quiet, its run turns **stale**, then **interrupted** when its lease runs out. Interrupted runs from the last 24 hours are under **Agents → Recent**.
- **Items go back to Ready** when a lease runs out or you release a claim, so another agent can claim them. Their checklist and partial work stay on the ticket.
- **Work left in a worktree** shows when a run ended with uncommitted changes or commits that weren't pushed. It goes to the item's lead or your coordinator first, and reaches you if nobody can act on it or it's still there after a day. Docket checks the repository (read-only) when it can, so it won't call a commit unpushed when it's already on main. When it can't check, the row says the state is **unverified**.
- **Workspaces at risk:** the worktree still holds work that isn't safe yet. See [Workspace states and safe pruning](/help/workspaces-and-pruning).

## What to do

1. **If only Docket restarted, do nothing.** Agents carry on. Otherwise, **restart your coordinator** and tell it to recover. The `docket-coordinator` skill has the steps: it calls `recovery_report`, re-sends each interrupted run's stored brief unchanged, reuses or recreates the worktree from the last pushed commit, and cleans up anything left running.
2. **No coordinator?** On the ticket's **Activity** tab, click *Copy resume note* on the interrupted run. It gives the worktree, branch, last pushed commit, unpushed work, brief and checklist progress. Paste it into a new agent session.
3. **Work left in a worktree:** ask an agent to commit and push it if you want it. When a later run reports a pushed commit, the problem clears. Otherwise choose what happens to it:
   - **Keep for later** takes it off Needs you. The worktree stays **At risk**, so it won't count as safe to prune.
   - **Safe to discard** says you're fine losing it. The worktree can then count as **Safe to prune**, so a coordinator may delete it.
   - Neither button commits, pushes, saves or deletes anything. Docket never removes a worktree or files itself, and you can undo either.
4. **Parked runs** keep their claim through a crash. The coordinator continues them under the same run, or you can click *Release lead claim…*.

## Before deleting anything

Don't delete a worktree just because nothing is running in it. Check **Agents → Workspaces** first, and prune only what is **Safe to prune**.
