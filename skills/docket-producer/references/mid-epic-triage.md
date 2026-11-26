# Triaging work added mid-epic

**Read when:** A QA handoff or new bug arrives, or the digest lists a ticket under `added mid-flight`.
**Don't read when:** No bug report or ticket was added since the epic started.

New tickets land in Inbox, even in a running epic. Nothing joins it as Ready without triage, and the epic can't close until each one is triaged.

## A bug or QA handoff

1. **Intake, then delegate.** If the handoff has no ticket, create one Bug in Inbox with the reported symptom, source and affected scope; do not wait for a full reproduction before recording it. Check for an existing ticket first. Give a separate QA, verification or exploration agent that ticket and the original handoff, using `docket-bug-investigator`. Keep the producer's work to routing, dependencies and the final triage decision. Do not collect red evidence yourself. If the same investigator already owns this report, continue its handoff rather than starting another.
2. **Have the investigator finish the evidence.** It records the observed environment and exact build/SHA, expected and actual behavior, minimal repro or failing test, evidence location, scope and a recommended triage result on the Bug. A failed or unsafe reproduction is an explicit result, not a reason for the producer to take over investigation. The investigator fixes nothing and does not move the Bug to Ready.
3. **Triage the report.** Read the investigator's evidence and recommendation. If real and in this epic, set priority, ensure outcome, acceptance and shared changes are shaped, then move the Bug to Ready. It holds the release until fixed. If it belongs elsewhere, move it with `update_item { epic }`; a flaky test goes to the project's test-reliability epic. If evidence is inconclusive, leave it in Inbox with the next bounded investigation named. If it cannot be reproduced after a reasonable attempt, record that result and close it when existing project and owner decisions allow; ask the owner only for a real unresolved decision.
4. **Keep unrelated work moving.** An incomplete investigation holds this Bug's triage, not independent tickets. Do not make the producer's own investigation the critical path.

## A story

A story adds scope, so it's the owner's decision. Ask once with `ask_owner`, with three options: add it to this epic, defer it to a follow-up, or drop it. Then act on the answer. A story the owner adds still needs shaping before it's Ready.
