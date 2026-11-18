---
title: Recovering after a crash
summary: What you see after an agent, Orca or Docket stops unexpectedly, and how your coordinator picks the work back up.
group: Recovery
order: 2
anchors:
  - agents.recent
  - problems.unpushed_work
related:
  - workspaces-and-pruning
  - run-states
---

When an agent, your coordinator (such as Orca) or Docket itself stops unexpectedly, the work isn't lost. Docket keeps each run's checklist, logs, brief (the instructions the agent was given), worktree, branch and commits, so it can be restarted without guessing.

## What you see

- **Runs end as interrupted, never finished.** If Docket restarts, every open run becomes **interrupted** ("service restarted"), and Settings → **Service health** says how many runs were active. If an agent goes quiet, its run turns **stale**, then **interrupted** when its lease runs out. Interrupted runs from the last 24 hours are under **Agents → Recent**.
- **Items go back to Ready** when a lease runs out or you release a claim, so another agent can claim them. Their checklist and partial work stay on the ticket.
- **"Unpushed work may be lost"** shows under Problems when a run ended with uncommitted changes or commits that weren't pushed. It names the folder and why the run ended.
- **Workspaces at risk:** the worktree still holds work that isn't safe yet. See [Workspace states and safe pruning](/help/workspaces-and-pruning).

## What to do

1. **Restart your coordinator** and tell it to recover. The `docket-coordinator` skill has the steps: it calls `recovery_report`, re-sends each interrupted run's stored brief unchanged, reuses or recreates the worktree from the last pushed commit, and cleans up anything left running.
2. **No coordinator?** On the ticket's **Activity** tab, click *Copy resume note* on the interrupted run. It gives the worktree, branch, last pushed commit, unpushed work, brief and checklist progress. Paste it into a new agent session.
3. **Unpushed work:** if the worktree still exists, push or save the work. When a later run reports a pushed commit, the problem clears; or click *Handled* once you've dealt with it.
4. **Parked runs** keep their claim through a crash. The coordinator continues them under the same run, or you can click *Release lead claim…*.

## Before deleting anything

Don't delete a worktree just because nothing is running in it. Check **Agents → Workspaces** first, and prune only what is **Safe to prune**.
