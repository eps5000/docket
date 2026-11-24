---
title: Shared changes and conflicts
summary: Declaring the shared parts an item changes, why a claim can wait for you, leases on single-writer files, held hand-offs and the conflict radar.
group: Working with agents
order: 5
anchors:
  - item.shared-changes
  - settings.shared-parts
  - settings.overlap-handling
related:
  - problems-and-what-to-do
  - blockers-and-dependencies
  - review-a-packet
---

When several agents work at once, two items can collide on the same table, model, endpoint or shared file. Every item says which **shared parts** it will change. Docket keeps agents working in parallel where that's safe, puts work in order where it isn't, and asks you only when it needs you.

## Shared parts

Each project keeps a registry of shared parts under **Settings → Projects → Shared parts**. A part has a key such as `model:Token`, `table:decks`, `endpoint:POST /decks/{id}/export` or `file:src/Data/Migrations/Snapshot.cs`, and optional path patterns that map changed files to it. Agents register parts as they go; only you mark a part **single-writer** or archive it.

## Declaring before Ready

An item can't move to Ready until it declares the parts it will change (add, change or remove, with a short note), or declares that it changes none. You see the declaration in the ticket's **Details → Shared changes**, where *Edit* changes it. If you need to move an undeclared item to Ready anyway, give a reason: it's recorded in Activity.

### Tickets agents create, and Needs shaping

An agent that creates a ticket, or splits one, declares its shared parts or says it changes none in the same step. If it doesn't know yet, or leaves out the outcome or the acceptance criteria, the ticket is marked **Needs shaping**. That's work for a **planner** agent, not for you: the ticket, its epic and the map say "needs shaping", and the producer's digest lists it so a planner shapes it (outcome, acceptance, links, shared changes, and known gaps for your approval if there are any).

When you press **Move to Ready** on a ticket that isn't declared, Docket doesn't just refuse. It lists exactly what's missing and offers:

- **Ask a planner to shape this**, with an optional note for the planner. The ticket becomes Needs shaping with your request recorded, and the producer picks it up. You can undo it.
- **It changes no shared part**, when you know it doesn't: that declares none, as *Edit* would, and then it can move.

Once a planner has shaped it, the ticket moves to Ready with no step from you, unless it has known gaps for you to approve.

A declaration can name a **member** of a part, such as `model:Token.expiresAt` or `table:decks.archived_at`. A part with no member means "could touch anything in it". If a change alters something you already approved, the agent marks it **Changes an approved design** and says which design, decision or acceptance criterion.

## When two items overlap

For any overlap, Docket asks three questions, in order:

1. **Can they safely run at the same time?** Then they do. That's an overlap only in shared files, or two items adding *different* members of the same part.
2. **If not, or if it's unclear, would running them in order solve it?** Then Docket adds a blocker (first claimed goes first), and the waiting agent takes other work. That's the same member, a change or removal of something the other item uses, a part with no member, or anything Docket can't judge.
3. **Neither works?** Then you get a card on **Needs you**, with the evidence and a recommendation. That's an order that would create a dependency loop, agents disputing who owns a part, or an overlap still unresolved after a day.

### A change to an approved design

If an agent declares that its work changes something you approved, it **always comes to you**, whether or not it overlaps anything, and whatever your Overlap handling says. You get a card on **Needs you** and a banner on the ticket, showing the item and which design, decision or acceptance criterion it changes.

**That item waits, and everything else continues.** An agent can't start it. If one already has it, it can't close it, and a packet it hands off stays closed to review until you decide. The agent is told to pause this work and take something else.

- **Approve the design change:** the agent goes ahead. Docket doesn't ask again unless the note, the parts or the kind of change differ.
- **Send back:** say what the agent should do instead (a note is required). A held packet is withdrawn. The item stays paused until the agent reworks it so it no longer changes the design, or declares a different change, which comes back to you.

You can undo either. Only you can clear it: an agent can't, and neither can Docket's overlap rules.

### Two different checks

**Do the lines collide?** Only a trial merge of real commits can tell. "Add-only" doesn't prevent this: two branches inserting at the same line conflict, in Markdown, models or anything else.

**Do the changes collide in meaning?** Git can merge two changes cleanly that still break each other. Declarations and agents answer this one. A clean trial merge never makes work safe on its own.

### What you see

Every outcome is on both tickets under **Shared changes**, with who decided, why and the evidence. Automatic outcomes are recorded as **Docket**, never as you. To change one, use **Run in parallel** or **Run in order** on the ticket; you can undo it. Needs you shows one quiet line, **Docket handled N overlaps today**, which opens them.

On a card that needs you:

- **Run one after the other** adds a blocker, so the second item starts once the first is merged.
- **They're compatible** lets both run. An optional note goes to both agents.
- **Open both** opens the two tickets side by side.

An overlap that has waited too long offers **Keep this order** or **Run in parallel** instead. An item that declares a new overlap while it's already in progress keeps its claim. Overlaps you've decided stay decided.

### Overlap handling

**Settings → Overlap handling** sets how much reaches you, as a default and for each project. Only you can change it.

- **Agents resolve** (the default): you see only the overlaps that need you.
- **Ask on shared data:** you also decide overlaps on tables, models and endpoints.
- **Ask on every overlap:** you decide them all, including shared files.

A change to an approved design comes to you in every mode. Single-writer leases, the required merge checks and overlaps you've already decided work the same in every mode too.

## Leases on single-writer parts

A single-writer part, such as a migrations snapshot, can only be changed by one item at a time. The agent takes a short lease (2 hours by default) before changing it, and releases it once its change is pushed. A lease also ends when the item is done or handed off, or when it expires. Another agent asking for a held lease is told who holds it and until when, and works on something else. You can end a lease with *Release lease* in the ticket's Shared changes.

## Held hand-offs

When an agent hands off (a packet, or closing as done), it lists the files it changed. If any belong to a shared part the item didn't declare, Docket asks the same three questions. A safe one is added to the declaration, recorded as Docket, and the hand-off goes on. One that has to wait gets a blocker. Only one that needs you holds the hand-off, and Needs you says, for example, "GF-312 changed shared parts it didn't declare: table decks". **Add to the declaration** accepts the change: a held packet opens for review, and a refused close can be retried. **Send back** returns the item to the agent with your note. A packet with no file list from an item with declarations says "Changed files not reported".

## The conflict radar

Set the project's repository folder, as a full path on your computer, under **Settings → Projects → Shared parts** with its main branch. Docket runs in a container and reads no git itself: the Docket helper on your computer does the reading (see **Settings → Connections → Git checks**). Every few minutes it trial-merges each in-flight branch with the main branch, and pairs of in-flight branches that change the same parts or files, and Docket flags what would conflict. It never writes to the repository and never fetches: it reads the branches your worktrees share. A pair that would conflict shows on both tickets ("Heading for a conflict with GF-240: 3 files"), as a **conflict ahead** marker on Work cards, under **Problems**, and in both agents' context. It clears once the trial merge is clean. Without a repository the card says "Radar off: no repository", and everything else still works.

**Waiting for the host helper.** Until the helper reports, the card says so and finds or clears nothing. If the helper stops, after about 10 minutes the card says its facts are **out of date**: findings stay as they were and none clears, because an old answer can never make a conflict look gone. Start or update the helper with the steps on the Git checks card.

**What the helper sends.** Branch names, commit IDs, times and counts, and one kind of file name: the files in a **real conflict** that a trial merge reports, at most 50 per merge. It never sends file contents, the other files a branch changed, or anything `git status` lists.

The radar also runs shortly after an agent reports a branch or a commit. **It sees committed local branches only**, so agents should commit and report early: work that isn't committed is invisible to it. **A clean trial merge means git can combine the branches, not that they work together.**

A real conflict between two branches **stops neither agent**. Docket picks a merge order (the first to merge, or else the earlier claim) and tells both agents which files collide. The later one rebases on the first. If that can't be done mechanically, or would change what the other work does, the agent proposes a resolution, and that reaches you.

### One root cause, one problem

A branch that conflicts with the main branch is one problem: "GF-228's branch eps5000/redesign-438-shell is out of date with main". Two branches are reported as a pair only for files that conflict beyond that, so a stale branch doesn't fill Problems with knock-on pairs. A finding clears as soon as its branch is removed from the item's branches. Radar findings go to the agents leading the items first; they reach your Problems only when nobody leads the item or after a day. See [Problems and what to do](/help/problems-and-what-to-do).

### Which branches the radar checks

The radar checks every branch reported for the item: an agent reports them when it claims the item, declares its shared changes or hands it off, and you add or remove them under **Branches** in the ticket's Shared changes. An item can have several (up to 10), for example an epic with one pull request per part. Two branches of the same item aren't checked against each other; each is checked against the main branch and the other items' branches, and a conflict names both branches ("gf-217-api vs gf-235-b"). For an item in progress with no reported branch, it looks for a local branch with the item's key (or its Jira key) in its name, such as `eps5000/gf-239-visual-shell` for GF-239. If exactly one matches, the ticket's Shared changes says "Branch found by the radar". If several match, it checks none of them and says "Several branches match; report the branch". Use *Add branch* there to name the right one. A branch you or an agent report always wins over one the radar found, and removing the last reported branch lets the radar look again.
