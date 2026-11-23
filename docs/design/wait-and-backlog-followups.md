# Waits and backlog: follow-ups after decision 45

**Status: proposed, not built.** B54 (owner decision 45) makes a parked story's wait visible and routes it to whoever can act. This note records what that work showed and doesn't fix. Nothing here changes how Docket behaves, and nothing here should be built until the owner has chosen it.

## 1. What kind of dependency is this? (open question)

**This is an open question, not a recommendation.** `satisfied_when` says when a blocker clears (done, merged or verified). It doesn't say what kind of dependency the link is, or which part of the blocked story it holds. The two stalls behind decision 45 raised that question, and the owner has given a direction to test before anything is designed.

**The owner's direction:**

1. **A blocker ticket's own work type usually implies the kind of dependency.** Tasks could declare a type such as planning, implementation, testing or deployment. A link would then not need its own stage in the common case.
2. **Epics don't carry a dependency type of their own.** An epic derives its type from its children.

**The case to test before deciding.** GF-229 and GF-243 were both blocked by implementation stories, yet each could continue some of its work and was held only from a later step:

- GF-229 could keep doing work that didn't touch the story's body.
- GF-243 already had a PR, which was held from the queue.

So the blocker's type alone may not say **which step of the blocked story is held**. Any design has to answer that with these two cases in hand: does the blocker's type settle it, does the blocked story need to say something too, or is it a mix?

**Questions for the design:**

- What is the list of types, and who sets a type on an imported or older ticket?
- How does an epic's derived type read when its children differ?
- If the blocked story's step matters, where is that recorded without adding a field every link must fill in?
- How would a type change what `get_context`, the wait card and the flags say? Today they stay advisory, and a type shouldn't quietly become a gate.

**Nothing is to be built until the types are designed with the owner.** B54 doesn't add a stage or a type, and doesn't change `satisfied_when` or start gating.

## 2. Hard and soft dependencies

**The definitions and the test below are owner-approved (2026-11-23).** The data model, UI and build of hard and soft links stay **proposed**. They aren't part of B54, and nothing is to be built until the owner approves that design. Today every `blocks` link stops a ticket from starting, whether the other work holds all of it or only a corner of it.

**The definitions (owner-approved):**

- **Hard.** The ticket's current acceptance criteria can't be met without the other work. It blocks.
- **Soft.** The other work affects part of the ticket or how it's implemented. It doesn't block. Whoever starts the ticket records one outcome:
  - proceed as designed;
  - adjust the implementation;
  - split the affected part into its own ticket, which is hard-blocked; or
  - upgrade the dependency to hard.

**The test for agents adding a blocker (owner-approved):** does it hold **every** acceptance criterion, or only some? If only some, prefer a split, so the rest of the ticket can proceed.

**A signal worth surfacing (proposed).** A much newer ticket becoming a prerequisite of an older, already-shaped or already-claimed ticket usually means scope was added. In both stalls behind decision 45, a new prerequisite was linked after the waiting story had been claimed: one story could still do part of its work, and the other already had a PR.

**What B54 does and doesn't do.** The wait card now says when a blocker was linked after the claim, and suggests checking whether it holds the whole story. That is one line of advice. B54 adds no hard or soft link type, no recorded outcome and no gate.

**Questions for the design of hard and soft links:**

- Does soft replace part of what section 1's dependency types would say, or do the two answer different questions?
- Who may mark a dependency soft, and can an import ever set it?
- Where is the recorded outcome kept, and does anyone review it?
- How much newer is "much newer", and should the signal reach the planner while shaping, rather than only the waiting run?

## 3. Missing-link suggestions

**The gap.** The conflict radar and shared-part declarations see two stories touching the same files. They can't see "this story relies on behavior another story must deliver", which is how a prerequisite is often discovered only after a worker has started and has to park.

**Proposal.**

- During shaping, a story may add an optional **`relies_on`** note: a sentence or two on the behavior it needs.
- Docket matches that note against what other open stories declare they deliver: their outcome and acceptance.
- A likely match is shown as a **dismissible suggestion with its evidence** (the sentence on each side). It never creates a link by itself, and dismissing it is remembered.
- Later, the same signal can feed **Radar Insights**, which decision 43 reserved a place for and which remains unbuilt.

**Why optional.** A required field would be filled with noise. The note earns its place only where a planner knows something the file overlap can't show.

## 4. First Radar Insight: possible split

**Status: proposed. Nothing is to be built until the owner approves the design.**

**The owner's idea.** Radar flags a ticket whose dependency lies outside its epic and is shared by no other ticket in that epic, and Overview suggests the work may need splitting.

**Backtest on one live snapshot (2026-11-23):**

| Pattern | Matches |
|---|---|
| Open `blocks` links | 96 |
| Links that cross epics | 28 |
| The plain pattern: outside the epic, and shared by no other ticket in it | 22 of the 28 |
| Also: the ticket is active, and the link was added after it was claimed | 3 tickets |
| Also: the blocker has no live run | 2 tickets, exactly the two stalled stories |

The plain pattern is too noisy to show on its own.

**Proposed rule.** Show the 3-ticket tier as **"check whether this should split"**, and rank those with an idle blocker first.

**It follows the Overview design's Insight rules** (`docs/design/overview-page.md`):

- it cites the evidence and links to the affected work;
- it is a proposal only, and Radar never changes a ticket, link or plan by itself;
- the owner can accept or dismiss it, and a dismissed insight doesn't return;
- it adds nothing to the Needs you badge.

**The limit.** The rule was tuned on the two known cases and one snapshot. It needs more real history before its precision can be trusted.

## 5. Workflow stamping and re-shaping

**The gap.** When a project's workflow changes materially, older items remain sliced for the old rules. Nothing says which items those are, so an agent can pick one up and follow instructions that no longer fit how it was shaped.

**Precondition: a version needs a display label.** Docket numbers Workflow notes `v1`, `v2` and so on, and those aren't the project's own names. For example, the pilot's **Workflow 4.3 is published in Docket as v7**. An advisory that says "sliced before v7" means nothing to someone who knows it as 4.3, so each version needs an optional display label, shown as "Workflow 4.3 (v7)".

**Proposal.**

- **Stamp each item** with the workflow version and the date it was sliced.
- **Backfilled values are labelled inferred,** never presented as recorded fact.
- **A workflow version can be marked breaking,** with a note saying what changed.
- **Items sliced before a breaking version get an advisory** on `get_context` and at claim: "may need audit and re-slicing". Work already in progress gets a prompt for a design and ticket review instead.
- **A re-shaping queue** lists the affected items, starting with those that block active work.
- **Old versions never block delivery.** Every part of this is advisory, as decision 45's flags are.

## Order, if the owner wants them

1. The display label for workflow versions: small, and useful alone.
2. Workflow stamping and the breaking-version advisory.
3. The possible-split Insight, once more real history supports its precision.
4. Missing-link suggestions, once there's enough `relies_on` data to judge the match.
5. Dependency types and the build of hard and soft links, only after the design conversation in sections 1 and 2.
