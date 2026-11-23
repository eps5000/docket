---
title: Questions and notes
summary: Reply when an agent asks you something, and leave a note for whoever works on an item next.
group: Working with agents
order: 2
anchors:
  - item.question
  - item.history
related:
  - review-a-packet
  - run-states
---

Agents and you talk through the item, not through chat. Whatever you write is stored on the ticket, so the next agent sees it too.

## When an agent asks you something

An agent that needs you asks a question on the item. Its run shows **needs input**, and the question appears in two places:

- **Needs you → For you now**, as "codex asks: …". Click *Answer*.
- On the ticket, in a banner above the tabs.

Type your answer and click *Send answer*. The agent reads it on its next query. Until then the ticket says "Waiting for codex to read it". Once it reads the answer, its run goes back to working.

An item has at most one open question at a time. Answer it even if the answer is "not now": the agent may be waiting on it.

## Leaving a note

To steer an agent without being asked, open the item's **Activity** tab. At the top of **History**, write in the note box and click *Add note* (or press `Ctrl+Enter`).

- The agent working on it gets the note on its next query, and it's marked read then.
- If nobody is working on it, whoever picks it up next gets it.
- "n notes not read yet" shows under the box until an agent reads them.

## Editing the ticket instead

For lasting changes, edit the ticket itself: the title, outcome, description and acceptance criteria are editable on the **Details** tab. Agents see the change on their next read. Use a note for one-off instructions, and the ticket for what should stay true.

## Waking the agent

If the optional **docket-relay** is running on your computer, a change you make doesn't have to wait for an agent to stumble on it. The relay sends the ticket's Orca **coordinator** a short message saying which ticket changed and what kind of change it was, such as "acceptance, decision". The coordinator decides whether and when to pass it on to the agent doing the work, and the agent reads the details from Docket, so your words never travel in the message.

- An answer goes straight away, along with anything else waiting on that ticket.
- Edits, notes and other changes wait until the ticket has been quiet for a minute, and at most two minutes, so a burst of saves is one message.
- A ticket with no agent working on it gets no message.
- The relay never messages the working agent directly. If it can't find a coordinator, it records the change as undelivered.
- If the relay was stopped for 24 hours or more, or can't trust where it stopped, it holds: it sends nothing until someone runs its `reconcile` command, and nothing is dropped without a record.

The message says the ticket was updated "from the owner side", because an agent using the owner API is recorded as you and Docket can't always tell them apart. The relay never changes anything in Docket. To set it up, see `tools/docket-relay/README.md` in the repository.
