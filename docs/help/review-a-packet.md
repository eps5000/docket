---
title: Review a handoff packet
summary: Decide each check in a packet, send work back or defer it, and what each outcome does to the ticket.
group: Working with agents
order: 1
anchors:
  - review.packet
  - needs-you.for-you
  - item.human-review
related:
  - questions-and-notes
  - blockers-and-dependencies
---

When an agent finishes work that needs your eyes, it sends a **handoff packet**: the things for you to verify, how to verify them, what it already checked, and any known gaps. The ticket can't close until you decide every item in it.

## Open it

Click *Open packet* in **Needs you → For you now**, in the amber banner on the ticket, or in the ticket's **Checklist → Human review** section. The left column lists every packet that's ready for you.

## Decide each item

Under **What you're verifying**, each item has three choices:

- **Looks good:** you checked it, and it's approved. You can add **Notes for later** (see below).
- **Needs changes:** say what needs to change (required), then choose **Send it back as**:
  - *Checklist item on this ticket*: a new work step for the agent;
  - *New bug ticket*: a Bug in Ready, linked to this ticket.
- **Defer:** you can't verify it now. Add why (optional), then choose a **Follow-up**:
  - *Create a test ticket in Inbox*: a "Verify: …" task;
  - *No ticket: agent follows the project workflow*.

  Deferring lets work continue, but the item is recorded as **not verified**, never as approved. It stays in **Deferred, not verified** on Needs you until someone verifies it.

## Approve with notes

Sometimes a finding is fine for this ticket, but there's something agents should know next time ("Fine here, but next time put the fixture in tests/fixtures/"). Choose **Looks good**, then write it under **Notes for later (optional)**. Once there's a note, **Keep it for** offers three choices:

- *This ticket* (the default): the agent on this ticket gets it as a note from you.
- *The epic's future tickets*: it's also saved as an owner decision on the ticket's epic, so agents working on the epic's other tickets get it. This choice is disabled when the ticket has no epic.
- *All … work* (the project's name): it's also saved as an owner decision for the whole project, so every agent working on it gets it.

The note always shows in the round (and in later views of it) and in the ticket's **History**. A decision made this way says "From your review of RCP-12, round 2: …" when you click *Why*, and you can withdraw or supersede it like any decision. *Undo* removes the decision along with your review.

## Submit

The button on the right names the outcome, and the line under it says exactly what will happen:

- *Decide every item first*: you haven't decided them all yet.
- *Send back to …*: at least one item needs changes. The ticket goes back to In progress, and the agent picks it up again.
- *Close ticket (n deferred)*: nothing needs changes, but some are deferred.
- *Approve and close ticket*: everything looks good. Approving can unblock the items that wait on this one.

A toast offers *Undo* for a few seconds, and the next packet opens.

## Out of date packets

If the agent reports a new commit after writing the packet, it shows **out of date**. Click *Ask for a fresh packet*: the packet is withdrawn, the ticket goes back to In progress, and the agent gets a note asking for a new one.

## Rounds

Each packet is a round. Items you approved stay approved in later rounds. Earlier rounds are read-only: pick one from the round buttons to see what you decided.
