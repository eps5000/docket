---
title: Shared changes and conflicts
summary: Declaring the shared parts an item changes, why a claim can wait for you, leases on single-writer files, held hand-offs and the conflict radar.
group: Working with agents
order: 5
anchors:
  - item.shared-changes
  - needs-you.shared-questions
  - problems.radar_conflict
  - settings.shared-parts
related:
  - blockers-and-dependencies
  - review-a-packet
---

When several agents work at once, two items can collide on the same table, model, endpoint or shared file. Docket keeps that from happening unattended: every item says which **shared parts** it will change, and Docket stops overlapping work before it starts and asks you.

## Shared parts

Each project keeps a registry of shared parts under **Settings → Projects → Shared parts**. A part has a key such as `model:Token`, `table:decks`, `endpoint:POST /decks/{id}/export` or `file:src/Data/Migrations/Snapshot.cs`, and optional path patterns that map changed files to it. Agents register parts as they go; only you mark a part **single-writer** or archive it.

## Declaring before Ready

An item can't move to Ready until it declares the parts it will change (add, change or remove, with a short note), or declares that it changes none. You see the declaration in the ticket's **Details → Shared changes**, where *Edit* changes it. If you need to move an undeclared item to Ready anyway, give a reason: it's recorded in Activity.

## When two items overlap

When an agent claims an item whose parts overlap another item already in progress or in review, the claim is refused and the agent picks other work. You get one card per pair on **Needs you**, for example "GF-240 and GF-312 both change model Token":

- **Run one after the other** adds a blocker, so the second item starts once the first is merged.
- **They're compatible** lets both run. An optional note goes to both agents.
- **Open both** opens the two tickets side by side.

An item that declares a new overlap while it's already in progress keeps its claim; both items are flagged and you get the same card. Work cards show a small **overlap** marker until you decide.

## Leases on single-writer parts

A single-writer part, such as a migrations snapshot, can only be changed by one item at a time. The agent takes a short lease (2 hours by default) before changing it, and releases it once its change is pushed. A lease also ends when the item is done or handed off, or when it expires. Another agent asking for a held lease is told who holds it and until when, and works on something else. You can end a lease with *Release lease* in the ticket's Shared changes.

## Held hand-offs

When an agent hands off (a packet, or closing as done), it lists the files it changed. If any of them belong to a shared part the item didn't declare, the hand-off is held and Needs you says, for example, "GF-312 changed shared parts it didn't declare: table decks". **Add to the declaration** accepts the change: a held packet opens for review, and a refused close can be retried. **Send back** returns the item to the agent with your note. A packet with no file list from an item with declarations says "Changed files not reported".

## The conflict radar

If the project's repository is inside Docket's push folder, set it under **Settings → Projects → Shared parts** with its main branch. Every 15 minutes (or when you press *Run radar now*) Docket trial-merges each in-flight branch with the main branch, and pairs of in-flight branches that change the same parts or files. It never writes to the repository and never fetches: it reads the branches your worktrees share. A pair that would conflict shows on both tickets ("Heading for a conflict with GF-240: 3 files"), as a **conflict ahead** marker on Work cards, under **Problems**, and in both agents' context. It clears once the trial merge is clean. Without a repository the card says "Radar off: no repository", and everything else still works.

### Which branch the radar checks

The radar checks the branch an agent reported for the item, when it claimed it, declared its shared changes or handed it off. For an item in progress with no reported branch, it looks for a local branch with the item's key (or its Jira key) in its name, such as `eps5000/gf-239-visual-shell` for GF-239. If exactly one matches, the ticket's Shared changes says "Branch found by the radar". If several match, it checks none of them and says "Several branches match; report the branch". Use *Set branch* there to name the right one. A branch you or an agent report always wins over one the radar found, and *Clear* lets the radar look again.
