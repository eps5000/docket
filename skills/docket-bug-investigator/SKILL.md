---
name: docket-bug-investigator
description: Investigate a QA bug report for a Docket producer. Collect bounded red evidence, complete the bug's reproduction record, and recommend triage without fixing the bug or taking over the producer's decision. Use when assigned a bug intake or reproduction handoff.
---

# Investigating a reported bug

You are the QA investigator for a reported bug. The producer owns priority, epic placement, Ready and implementation dispatch. Your job is to return a usable evidence record and a recommendation. Work under the assigned child or QA run; an Inbox Bug cannot be claimed as a new lead.

1. Read the original QA handoff, the Bug ticket and relevant project Workflow. Agree on the affected build or environment before testing. Avoid duplicating an investigator already working on the report.
2. Reproduce with the smallest safe sequence. Prefer an isolated fixture or test account and a bounded failing test when it clarifies the failure. Record the exact build/SHA, environment, preconditions, steps, expected result, actual result and whether it repeats. Keep private data out of notes and logs. Do not change production data or use destructive cleanup to obtain evidence.
3. Distinguish **confirmed red**, **not reproduced**, **blocked by environment/access** and **insufficient evidence**. A test written from the same assumption as the implementation is not independent red proof. Do not claim a regression or root cause without a comparison that supports it.
4. Add the concise evidence and links to the existing Bug. Complete the missing reproduction and acceptance detail needed for triage, and recommend **this epic**, **another epic**, **test reliability**, **more investigation**, or **close as not reproduced**, with a short reason. If no ticket exists, return the report to the producer for one Inbox Bug; do not create duplicate bugs.
5. Stop at the handoff. Do not implement a fix, change priority or epic, move the Bug to Ready, merge, deploy or close it. Send the producer the result and any exact next step. A blocked investigation should name who can clear the block without asking the owner for a technical route the agents can find themselves.
