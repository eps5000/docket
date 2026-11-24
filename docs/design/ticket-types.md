# Design: ticket types by kind of work

**Status:** proposed on 2026-11-24 for the owner's review.
- **Release is approved and being built** (owner, 2026-11-24, B84).
- The other types and the open questions below still need the owner's answer.

## Why

Docket's ticket types are Jira's: Epic, Story, Task and Bug. In the pilot, Story and Task don't say what kind of work a ticket is, so they don't say what kind of dependency it creates. A ticket waiting on a design behaves differently from one waiting on a release check, and today both just say "blocked".

The owner wants types that name the work. Each type should imply how other tickets depend on it, so gates can be deterministic.

## The types

| Type | Use it for | Finished when |
| --- | --- | --- |
| **Epic** | A body of work with an outcome. It holds tickets and isn't worked directly. | Its Release ticket is done (the epic then closes on its own). |
| **Exploration** | Research that answers a question other tickets will use: a spike, a prototype to learn from, a comparison, or a measurement. Time-boxed. | Its findings are recorded on the ticket as a short write-up with a recommendation, and linked to the tickets that use them. No code is merged. |
| **Design** | Product, UX, technical or data design, specs, contracts and decisions to make before building. Also documentation that defines how something works. | The design is recorded and accepted, by the owner when it needs their approval. |
| **Implementation** | Building or changing something: code, configuration, tooling, migrations. | Tested, merged and deployed as the project allows. Its implementer owns all of that. |
| **Bug** | Something that worked or should have worked, and doesn't. | Fixed, with a test that would have caught it, merged and deployed. |
| **Release** | The one closing ticket of every epic. It owns the checks across tickets (journeys in a test environment, flag-on checks, release QA), the deploy and the release decision. | All of its gates pass (below), and its own checklist is done. |

**Feature**, a versioned grouping such as "Assets V4", stays a separate later design, as discussed on 2026-11-23.

## Release, in detail (approved 2026-11-24)

The owner's direction:
- Every epic has one mandatory Release ticket that signifies its end.
- It's part of shaping.
- It makes clear which ticket owns the final work.
- It allows deterministic gates.

These rules follow:

1. **Exactly one per epic, created with it.** Docket creates "Release <epic title>" when an epic is created. It can be renamed but not removed while the epic is open. An epic can't start without one (it fits epic readiness, decision 58).
2. **It depends on everything else in the epic, automatically.** Every other ticket in the epic, bugs included, holds the Release, without any manual links. A ticket added mid-epic is covered the moment it lands. To ship without a ticket, it has to be moved out of the epic or canceled with a reason, which is deliberate and shows in Activity. This replaces B81's guessed finish line.
3. **Deterministic gates before it can finish:**
   - every other ticket in the epic is Done, canceled or moved out;
   - no open bugs;
   - no unsettled known gaps or partial exit reports (B74, B78);
   - its own checklist is done.

   The checklist is shaped per epic: for example flag-on journeys, deploy, smoke test and evidence.
4. **The epic closes when its Release is done.**
5. **On the Map** the Release ticket always sits alone in the last column. The Bugs column (B81) stays on the left.
6. **Existing epics:**
   - An epic with an obvious release ticket has it converted, for example a ticket titled "Release ..." or one marked as B81's finish line.
   - An epic with none gets a generated one.
   - Where it's ambiguous, the producer gets a Needs shaping item (B82) to choose.

Release replaces the **Verification** type proposed earlier. Checks that span tickets live on the Release ticket's checklist, and a large one can still be its own Implementation ticket inside the epic.

## What isn't a type

- **Merge and PR.** These are the last steps of an Implementation or Bug ticket, owned by the same implementer. Separate tickets would bring back the waiting and handoffs that stalled the pilot.
- **QA for a single ticket.** That belongs in the ticket's acceptance criteria. Checks across tickets belong to the Release.
- **Small chores**, such as CI or dependency updates. These are Implementation tickets.

## What a type implies for dependencies

A blocker's type gives the default meaning of the link, so agents don't have to choose a link stage:

| The blocker is | The dependent ticket waits to |
| --- | --- |
| Exploration | **start shaping or start**, as the link says. Its findings feed the dependent's design or plan. |
| Design | **start**: it can't be built before the design exists |
| Implementation or Bug | **start**, by default. A blocker that holds only part of the ticket should be split, using the owner's hard and soft dependency rules |
| Release | Nothing inside the epic depends on it. Another epic may depend on an epic's Release. |
| Epic | Summary only: an epic link never blocks the child tickets on its own (owner, 2026-11-23) |

**Exploration and epic readiness.** An Exploration ticket can run while its epic is still being shaped. It's the one kind of work allowed before every ticket is Ready, because its job is to make them Ready. It needs no shared-changes declaration, since it changes no code.

## Moving existing tickets

- Epic and Bug stay as they are.
- Story and Task become **Implementation**, marked **inferred**. Producers correct them while shaping, for example to Design or Exploration, and Docket shows how many inferred types remain so nothing is forgotten.
- A Jira import keeps Jira's original type as a reference and maps Story and Task to Implementation.
- **Agents:** `create_item` and the other tools accept the new types. For a transition period they still accept Story and Task, store Implementation, and say so in the reply, so installed skills keep working until projects update.

## Where it shows

Docket shows the types in:
- create and edit, and Work filters and columns;
- the Map, with an icon per type and never colour alone;
- Pick next epic and the daily brief;
- the planner and producer skills, which follow the order exploration, design, build, release;
- the importer, Help and the specs.

## Open questions for the owner

1. **Documentation:** fold it into Design as above, or make a separate **Docs** type? I recommend folding it in for now, because it keeps the list short and docs that define behavior are design.
2. **Exploration:** add it as its own type, as above? I recommend yes.
   - Its result is knowledge, not code, so its gates differ: no PR and no shared changes.
   - It can run before the epic is Ready.
   - This replaces my earlier suggestion to treat spikes as Design.

## Build outline

1. **B84 (approved): the Release type**, its automatic dependencies, gates, epic closing, Map column, migration of existing epics, and skills and Help.
2. Once approved: the other types, the mapping, transition aliases, the inferred marker and the count of inferred types remaining.
3. Dependency meaning by blocker type, Exploration's readiness exception, and the finish-wait wording in Queued and the Map.
4. Skills (planner, producer, worker), Help and the specs, within the token budgets, using reference files (decision 66).
