---
title: "Run states: live, parked, stale and more"
summary: What each run state means, how sure Docket is about it, and what to do about stale, parked and failed runs.
group: Working with agents
order: 3
anchors:
  - agents.active-now
  - needs-you.agents-strip
  - item.agent-bar
  - item.lead-and-runs
related:
  - workspaces-and-pruning
  - crash-recovery
  - questions-and-notes
---

A **run** is one agent's stretch of work on an item. The agent leading an item holds its **lead claim**, so no other agent can take it. Docket never shows more certainty than it has: it only says a run is working when the agent's session is answering.

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
| **interrupted** | Stopped without finishing: its lease expired, its claim was released, or it was a subagent's run that didn't call within 15 minutes of a Docket restart. (Runs from before Docket kept work through restarts may also say the service restarted.) |

Hover a state to see its meaning. Parked runs also say what they wait on, like "parked · waiting on RCP-12", and "ready to resume" once that has cleared. Only real work resumes a parked run: an agent reading the ticket doesn't.

**Activity since parked** means something happened after the run parked: new commits on its branch, updates on the ticket, or a blocker clearing. The run stays parked, because Docket can't be sure, and its coordinator is told. The line goes away once the run or its coordinator responds. **Commits while silent** means commits are landing on a run that has stopped reporting, so that session may not have Docket.

**Producer** is the session that owns a story while smaller workers take turns on it. Handing it between them keeps it In progress ("Between workers"). If no worker picks it up within 30 minutes, it returns to Ready.

**Status updated by** names a coordinator who corrected the run's status for it. A coordinator can't claim, close or review work this way.

**Parked by X until T** means a coordinator parked the run for a limited time, because the agent stopped to wait. A park like this lasts at most 4 hours, can be renewed up to 24 hours after the agent last spoke, and always ends by itself. When it ends, the agent has 15 minutes to call back. If it does, it carries on. If it doesn't, it loses its claim the normal way and the item goes back to Ready. A park the agent set itself has no time limit.

**Waiting for** on a parked ticket says what it needs, how long it has waited, who has the next step, and how the same agent resumes. A short resume and re-park doesn't restart the clock. Docket flags a wait when nobody is moving the blocker for 15 minutes, or when it needs a decision from you that nobody has asked for. These flags go to the coordinator first and never hold up any work.

**Added after work started** means the blocker was linked after this agent had already claimed the ticket, which often means scope was added. Check that it really holds the whole story. If it holds only part, split that part out and let the rest go ahead.

**When the blocker clears,** Docket tells the coordinator which run and dispatch can continue. Docket can't message an agent's session itself, so the coordinator passes it on. If nobody does within 30 minutes, you see "Ready to resume, unattended".

## Leases

A claim comes with a lease (60 minutes by default), and every signal from the agent extends it. If the lease runs out, Docket ends the run as **interrupted**, releases the claim and moves the item back to Ready. The checklist, logs and partial work stay on the ticket. A parked run's lease is paused. If Docket restarts, open runs stay open and each lease lasts at least 15 more minutes, so the agent can simply continue.

## What to do

- **Stale:** the agent may still be working, or may have crashed. Under **Problems**, click *Inspect*. You can wait (the lease ends it on its own), or click *Release lead claim…* on the ticket (or its **Activity** tab) to free it now. Releasing marks the run **interrupted**, keeps its work, and moves the item back to Ready for another agent. If the original agent comes back, it's told the current state.
- **Needs input:** answer its question. See [Questions and notes](/help/questions-and-notes).
- **Failed:** open the item's **Activity** tab to read the error. *Return to Ready* lets another agent pick it up. Docket never launches agents itself.
- **Parked for 24 hours:** goes to its coordinator first, and reaches your Problems if it has none or it's still parked a day later. You can also click *Release lead claim…*.
- **Ready to resume, unattended:** what it waited on has cleared, but nobody has resumed it for 30 minutes. Tell your coordinator, or release the claim.
- **Interrupted:** see [Recovering after a crash](/help/crash-recovery). *Copy resume note* on the run gives a coordinator everything it needs to pick it up again.

## Where you see them

- **Overview:** the Agents card counts stories being worked on and stories waiting, not individual runs. *All runs →* under Health opens the full list.
- **Sidebar:** the number next to Agents is the stories being worked on in this project, the same as *working* on Overview.
- **Agents → Active now:** every open run, needs input first. These are runs, not stories, so a story can have several.
- **On a ticket:** the agent bar under the header, and **Activity → Lead and runs** for the full history.
