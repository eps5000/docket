---
title: Pause a project
summary: Stop agents starting or resuming work in one project, without losing anything, and pick it up again when you're ready.
group: Working with agents
order: 7
anchors:
  - settings.pause-project
related:
  - run-states
  - decision-records
---

**Pause project** freezes one project. Use it when agents should stop, for example while you wait on a legal answer or rethink a plan. Other projects carry on as usual.

Only you can pause or resume a project. Agents can't do either.

## Pause it

Choose the project, then use **Pause project…** on Overview, or on the project's row in **Settings → Projects**. Give a short reason: agents see it, so they know why they're stopping.

The pause is recorded as one of your project decisions. Overview, Work and each ticket show a banner with who paused it, when and why. Project pickers mark it **Paused**. It doesn't add anything to **Needs you**.

## What happens while it's paused

- **Nothing new starts.** An agent that tries to claim a ticket is told the project is paused, why, and to ask you. That includes picking up an In progress ticket with no lead.
- **Parked runs stay parked.** They show *Held by your decision*, and they don't age into alerts.
- **Running work can stop safely.** An agent already working is told to save its work and park at the next safe point.
- **Nothing gets stranded.** Agents can still read, leave notes, report commits and branches, park, release a ticket and finish. A write from a parked run is recorded, and the run stays parked.
- **Coordinators aren't told to start anything.** Their digest shows one line saying the project is paused, with no next work.

## Resume it

Use **Resume project** on the banner, or on the project's row in Settings. You can also withdraw the pause on the **Project decisions** page.

Aging restarts from that moment, so you don't get a wall of alerts for the time it was paused. Any run whose blocker cleared during the pause gets one "ready to resume" notice for its coordinator.

Both actions have **Undo** for 60 seconds in the confirmation toast.
