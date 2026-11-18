---
title: Dates, effort and the forecast
summary: Where planned dates and effort come from, what a date risk is, and how the burn-down and the P50 and P85 forecast are worked out.
group: Planning
order: 2
anchors:
  - item.dates
  - work.burndown
  - problems.date_risk
related:
  - blockers-and-dependencies
---

## Dates and effort on a ticket

The **Dates and effort** section on a ticket's **Details** tab shows:

- **Planned:** the planned start and end, and who set them. Agents set these; you can ask an agent to change them.
- **Effort:** an estimate in points, or "Not estimated".

The actual dates come from what happened: when work started and when it was done.

## Date risk

An item is at risk when it's planned to start before something blocking it is planned to end. It shows under **Problems** on Needs you; click *Timeline* to see it on the **Work → Timeline** layout.

## The burn-down

On **Work → Timeline**, the **Remaining effort** card shows how much estimated work is left in the current view (the project, epic or label you've filtered to). It starts collapsed; click its header to open it.

- The line is the total effort of open items at the end of each day, over the last 4 weeks.
- Small up-ticks mark work added to the scope.
- Items without an estimate are counted as "n not estimated", never as zero.
- *Show as table* lists the same numbers day by day.

Days follow the service's time zone (`TZ`), so the chart's Today and the Timeline's Now line always agree.

## The forecast

The forecast says when the remaining work is likely to finish, as two dates:

- **P50:** a 50% chance of finishing by then.
- **P85:** an 85% chance.

It's worked out from how much estimated work was completed each week over the last 4 full weeks: Docket replays those weeks at random 10,000 times until the remaining effort reaches zero. The line under the chart states the rate, the number of items it used, and how many unestimated items it left out.

It needs enough history: at least 8 estimated items completed in that window, in at least 2 different weeks. Until then it says "No forecast yet: needs 8 completed items with effort (have n)."

A forecast never changes anyone's planned dates.
