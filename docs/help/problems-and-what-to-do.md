---
title: Problems and what to do
summary: What each problem means, who fixes it (an agent, or you), and what each button does, on Needs you and on the item's banner.
group: Working with agents
order: 4
anchors:
  - problems.stale_run
  - problems.failed_run
  - problems.cycle
  - problems.date_risk
  - problems.canceled_blocker
  - problems.deferred_verified_blocker
  - problems.orphaned_resources
  - problems.unpushed_work
  - problems.parked_too_long
  - problems.resume_unattended
  - problems.extra_backup_failed
  - problems.agent_files_drift
  - problems.radar_conflict
  - needs-you.shared-questions
  - needs-you.agent-problems
  - needs-you.resolutions
  - item.problem-banner
related:
  - shared-changes-and-conflicts
  - run-states
  - crash-recovery
  - blockers-and-dependencies
---

Every problem says three things, in plain words:

- **What's wrong**, such as "GF-228's branch eps5000/redesign-438-shell is out of date with main: 53 files conflict".
- **What fixes it**, such as "Rebase it onto main, or split it into short story PRs".
- **Who acts**: **an agent** (the lead of the item, or nobody yet) or **you** (a decision, or a recovery step you or your coordinator take).

Agents read the same words in `get_context`, so you and they agree on what to do.

## Who sees a problem first

**Agent problems** go to the agents first. Today these are the conflict radar's findings: a branch that is out of date with main, or two items' branches that change the same lines. The leads of the items involved get them in their context and as one note on the item ("Docket's conflict radar: …"). They usually fix them on their own, by rebasing or by removing an old branch from the item's branches.

An agent problem reaches your **Problems** only when:

- nobody is working on the item ("Nobody is working on GF-228"); or
- it's still open after a day ("Not fixed by an agent for a day"). Your admin can change the day with `DOCKET_AGENT_PROBLEM_GRACE_HOURS`.

Until then, Needs you shows **Agents are handling N problems** under Problems. Open it to see them, so nothing is hidden.

**Your problems** (everything else) show at once.

**Overlaps** between two items follow the same idea: Docket runs safe ones in parallel, puts the rest in order, and shows you one quiet line, **Docket handled N overlaps today**. You get a card only when an overlap needs you. See [Shared changes and conflicts](/help/shared-changes-and-conflicts).

## The buttons

- **Remind the agent** posts the problem's explanation to the item's lead as a note from you. You can undo it.
- **Open the item** (or **Open**) goes to the item, where the banner at the top shows the problem.
- **Not an active branch** (radar findings) removes that branch from the item's branches. The radar stops checking it, and the finding clears at once. You can undo it.
- **Acknowledge** takes the problem off Needs you. It comes back when it needs you again: an agent proposes a resolution, or the problem changes (another kind, a new branch, or files beyond the ones you acknowledged). The item's banner keeps it, with "Acknowledged by you" and when. You can undo it.
- The kind's own buttons stay: **Inspect**, **Fix**, **Timeline**, **Mark released**, **Handled** and **Review**.

## Proposed resolutions

When a problem needs a bigger change than a rebase, an agent proposes one: split the work, change its scope, change the order of work, or something else, with a plan and a reason. It shows as a card on Needs you and on the item's banner. Choose:

- **Approve**: the agent goes ahead.
- **Go a different way**: say which way instead (a note is required). The problem stays open, and the agent may propose again.
- **Acknowledge**: fine, proceed.

Each choice reaches the agent as a note from you, and in its context. Each also counts as acknowledging the problem. Routine fixes, such as a rebase or removing an old branch, need no proposal: the agent just does it, and the item's Activity records it.

## Each kind

| Problem | Who acts | What to do |
|---|---|---|
| Out of date with main | An agent | Rebase onto main, or split into short story PRs. If the branch is an old draft, use **Not an active branch**. |
| Heading for a merge conflict (two items' branches) | An agent | Neither stops. Docket says which merges first, and the other rebases on it. Pairs that only conflict because a branch is out of date with main aren't listed: fixing that fixes them. |
| Lead agent silent (stale) | You or your coordinator | Check whether the agent is still running. If it stopped, release its claim. See [Run states](/help/run-states). |
| Lead run failed | You or your coordinator | Read the error in Activity, then restart the work or move it back to Ready. |
| Parked a long time | You or your coordinator | Check it's still waiting for something real; resume it or release its claim. |
| Ready to resume, unattended | You or your coordinator | Ask your coordinator to resume it. |
| Left running after its run ended | You or your coordinator | Stop it, then **Mark released**. See [Workspace states](/help/workspaces-and-pruning). |
| Work that may be lost | You or your coordinator | Push or save the work, then **Handled**. See [Crash recovery](/help/crash-recovery). |
| Dependency cycle | You | Remove one link. See [Blockers and dependencies](/help/blockers-and-dependencies). |
| Blocked by a canceled item | You | Remove the link, or reopen the blocker. |
| Blocker not verified | You | Finish the deferred check, or change the link to wait for Done. |
| Date conflict | You | Ask the lead to move the planned start, or bring the blocker's finish forward. |
| Agent files changed outside Docket | You | **Review**: adopt, restore or keep local. See [Agent files](/help/agent-files). |
| Extra backup copy failed | You | Check the extra backup folder in Settings. |
| Two items overlap, and it needs you | You | Docket handles most overlaps itself. You get a card for a dependency loop, a dispute over who owns a part, or one still unresolved after a day. **Run one after the other**, or **They're compatible** (on a waiting one, **Keep this order** or **Run in parallel**). See [Shared changes and conflicts](/help/shared-changes-and-conflicts). |
| Changes an approved design | You | Always comes to you, and that item waits while other work continues. **Approve the design change**, or **Send back** with a note. See [Shared changes and conflicts](/help/shared-changes-and-conflicts). |
| Changed shared parts it didn't declare, and it needs you | You | Docket records the safe ones itself. For the rest: **Add to the declaration**, or **Send back**. |
