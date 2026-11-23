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

## 2. Missing-link suggestions

**The gap.** The conflict radar and shared-part declarations see two stories touching the same files. They can't see "this story relies on behavior another story must deliver", which is how a prerequisite is often discovered only after a worker has started and has to park.

**Proposal.**

- During shaping, a story may add an optional **`relies_on`** note: a sentence or two on the behavior it needs.
- Docket matches that note against what other open stories declare they deliver: their outcome and acceptance.
- A likely match is shown as a **dismissible suggestion with its evidence** (the sentence on each side). It never creates a link by itself, and dismissing it is remembered.
- Later, the same signal can feed **Radar Insights**, which decision 43 reserved a place for and which remains unbuilt.

**Why optional.** A required field would be filled with noise. The note earns its place only where a planner knows something the file overlap can't show.

## 3. Workflow stamping and re-shaping

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
3. Missing-link suggestions, once there's enough `relies_on` data to judge the match.
4. Dependency types, only after the design conversation in section 1.
