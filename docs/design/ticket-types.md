# Design: ticket types by kind of work

**Status:** proposed on 2026-11-24, for the owner's review. Not approved to build.

## Why

Docket's ticket types are Jira's: Epic, Story, Task and Bug. In the pilot, Story and Task don't say what kind of work a ticket is, so they don't say what kind of dependency it creates. A ticket waiting on a design behaves differently from one waiting on a release check, and today both just say "blocked".

The owner wants types that name the work: design, documentation, implementation, verification and bugs. Each type should imply how others depend on it.

## The types

| Type | Use it for | Finished when |
| --- | --- | --- |
| **Epic** | A body of work with an outcome. It holds tickets and isn't worked directly. | Its intended tickets are done or deliberately moved, and its outcome is verified. |
| **Design** | Product, UX, technical or data design, specs, contracts and decisions to make before building. Also documentation that defines how something works. | The design is recorded and accepted, by the owner when it needs their approval. |
| **Implementation** | Building or changing something: code, configuration, tooling, migrations. | Tested, merged and deployed as the project allows. Its implementer owns all of that. |
| **Verification** | Checks that span several tickets: an epic's journey in a test environment, release QA, or an integrated privacy or accessibility pass. | The check ran on the real combined result, with evidence recorded. |
| **Bug** | Something that worked or should have worked, and doesn't. | Fixed, with a test that would have caught it, merged and deployed. |

**Feature**, a versioned grouping such as "Assets V4", stays a separate later design, as discussed on 2026-11-23.

## What isn't a type

- **Merge and PR.** These are the last steps of an Implementation or Bug ticket, owned by the same implementer. Separate tickets would bring back the waiting and handoffs that stalled the pilot.
- **QA for a single ticket.** That belongs in the ticket's acceptance criteria. A Verification ticket is only for checks across tickets.
- **Small chores**, such as CI or dependency updates. These are Implementation tickets.

## What a type implies for dependencies

A blocker's type gives the default meaning of the link, so agents don't have to choose a link stage:

| The blocker is | The dependent ticket waits to |
| --- | --- |
| Design | **start**: it can't be built before the design exists |
| Implementation or Bug | **start**, by default. A blocker that holds only part of the ticket should be split, using the owner's hard and soft dependency rules |
| Verification | **finish**: the dependent can be built, but not released or closed |
| Epic | Summary only: an epic link never blocks the child tickets on its own (owner, 2026-11-23) |

This also feeds the new **Queued** view (B73). A ticket that can start but waits on a Verification blocker to finish should read as "can start; release waits on GF-123", not as Queued.

## Moving existing tickets

- Epic and Bug stay as they are.
- Story and Task become **Implementation**, marked **inferred**. Producers correct them while shaping, for example to Design, and Docket shows how many inferred types remain so nothing is forgotten.
- A Jira import keeps Jira's original type as a reference and maps Story and Task to Implementation.
- **Agents:** `create_item` and the other tools accept the new types. For a transition period they still accept Story and Task, store Implementation, and say so in the reply, so installed skills keep working until projects update.

## Where it shows

Create and edit, Work filters and columns, the Map (an icon per type, never colour alone), Pick next epic, the daily brief, the planner and producer skills ("design before building; verification at the end of an epic"), the importer, Help and the specs.

## Open questions for the owner

1. **Documentation:** fold it into Design as above, or make a separate **Docs** type? I recommend folding it in for now, because it keeps the list short and docs that define behavior are design. A separate type can come later if filtering needs it.
2. **Research or spike:** a time-boxed investigation that answers a question. Treat it as Design, or add a type? I recommend treating it as Design.
3. **Verification per epic:** should every epic end with one Verification ticket, or only when the project's workflow asks for it? I recommend only when the workflow asks.

## Build outline, once approved

1. Types, mapping, transition aliases, the inferred marker, and the count of inferred types remaining.
2. Dependency meaning by blocker type, and the finish-wait wording in Queued and the Map.
3. Skills (planner, producer, worker), Help and the specs, within the token budgets.
