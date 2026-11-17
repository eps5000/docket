---
title: "Run states: live, parked, stale and more"
summary: What each run state means, how sure Task Lite is about it, and what to do about stale, parked and failed runs.
group: Working with agents
order: 3
anchors:
  - agents.active-now
  - needs-you.agents-strip
  - item.agent-bar
  - item.lead-and-runs
  - problems.stale_run
  - problems.failed_run
  - problems.parked_too_long
  - problems.resume_unattended
related:
  - workspaces-and-pruning
  - crash-recovery
  - questions-and-notes
---

A **run** is one agent's stretch of work on an item. The agent leading an item holds its **lead claim**, so no other agent can take it. Task Lite never shows more certainty than it has: it only says a run is working when the agent's session is answering.

## The states

| State | What it means |
|---|---|
| **live** | Working: the agent's session is answering right now. |
| **reported** | The agent says it's working, but its session hasn't answered for 2 minutes. |
| **stale** | No signal for 30 minutes (the default). The state is unknown, **not** finished. |
| **parked** | Waiting on purpose: on another item, the coordinator, a person, or a time. It keeps its claim and never goes stale. |
| **needs input** | Waiting on you: it asked a question. |
| **failed** | The run ended with an error. |
| **finished** | The run ended normally. |
| **interrupted** | Stopped without finishing: its lease expired, its claim was released, or the service restarted. |

Hover a state to see its meaning. Parked runs also say what they wait on, like "parked · waiting on RCP-12", and "ready to resume" once that has cleared.

## Leases

A claim comes with a lease (60 minutes by default), and every signal from the agent extends it. If the lease runs out, Task Lite ends the run as **interrupted**, releases the claim and moves the item back to Ready. The checklist, logs and partial work stay on the ticket. A parked run's lease is paused.

## What to do

- **Stale:** the agent may still be working, or may have crashed. Under **Problems**, click *Inspect*. You can wait (the lease ends it on its own), or click *Release lead claim…* on the ticket (or its **Activity** tab) to free it now. Releasing marks the run **interrupted**, keeps its work, and moves the item back to Ready for another agent. If the original agent comes back, it's told the current state.
- **Needs input:** answer its question. See [Questions and notes](/help/questions-and-notes).
- **Failed:** open the item's **Activity** tab to read the error. *Return to Ready* lets another agent pick it up. Task Lite never launches agents itself.
- **Parked for 24 hours:** shows under Problems. The coordinator should resume it or release it; you can also click *Release lead claim…*.
- **Ready to resume, unattended:** what it waited on has cleared, but nobody has resumed it for 30 minutes. Tell your coordinator, or release the claim.
- **Interrupted:** see [Recovering after a crash](/help/crash-recovery). *Copy resume note* on the run gives a coordinator everything it needs to pick it up again.

## Where you see them

- **Needs you:** the Agents line counts each state; click a count to see those runs.
- **Agents → Active now:** every open run, needs input first.
- **On a ticket:** the agent bar under the header, and **Activity → Lead and runs** for the full history.
