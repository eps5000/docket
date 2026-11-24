# Ticket types, Release and rollout

**Read when:** You choose a ticket type, shape an epic's Release, or find a shared-environment rollout in acceptance.
**Don't read when:** You only edit the checklist of an already typed ticket.

| Type           | Use it for                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Epic           | One outcome for its users. Docket creates exactly one Release with it.                                                                                                                                       |
| Exploration    | Time-boxed research or a spike meant to learn. Record findings and a recommendation, and link tickets that use them. It may run before the epic is Ready, needs no shared-changes declaration and has no PR. |
| Design         | Product, UX, technical or data design, contracts, specs and documentation.                                                                                                                                   |
| Implementation | Code, configuration, tooling, migration or a spike whose code will remain.                                                                                                                                   |
| Bug            | Behavior that is broken and needs a fix.                                                                                                                                                                     |
| Release        | The epic's final integrated checks, deploy and release decision for its real users.                                                                                                                          |

Shape the Release during epic planning. Its acceptance and checklist cover integrated journeys, flag-on checks, deployment, smoke tests and evidence as appropriate. It waits automatically for every other ticket in its epic, including later bugs; no manual links are needed. The epic closes when its Release is Done. Two releases to real users require two epics.

An intermediate deploy to Dev, data cutover or test flag change that other tickets depend on is **Implementation with `rollout: true`**. Give it its own ticket and links from the dependent tickets. Never hide this work in another ticket's checklist. A Release stays last.

For other blockers, link only what the dependent truly needs: Exploration findings feed shaping or starting work; Design must exist before implementation starts; Implementation and Bug normally finish before dependents start. Another epic may depend on a Release. Epic links summarize; they do not block all child tickets.

Existing Story and Task tickets were inferred as Implementation. Correct their type during shaping; the inferred count in the digest shows how many remain. Jira's original type remains recorded for reference. Tools still accept Story and Task as transition aliases and store Implementation.
