# Working Exploration, Design, Release and rollout tickets

**Read when:** Your item is Exploration, Design or Release, or an Implementation ticket marked as a rollout.
**Don't read when:** Your item is an ordinary Implementation or Bug ticket.

- **Exploration:** research or a spike meant to learn. It may run while its epic is still being shaped, needs no shared-changes declaration and has no PR. Record findings and a recommendation in the closing `reason`, and link the tickets that use them. A spike whose code will remain is Implementation.
- **Design:** produce the design, contract, spec or documentation in its acceptance. Seek owner acceptance when the ticket declares it; do not treat a draft as approved.
- **Rollout:** an Implementation ticket marked `rollout: true` for an intermediate deploy, cutover or test flag change in a shared environment. Own the change and evidence on this ticket. Its dependents link to it. If you find such a step hidden in another ticket, tell the producer so it becomes its own rollout ticket.
- **Release:** the epic's one closing ticket. It owns integrated journeys, final deploy, smoke test and evidence for the epic's real users. Docket automatically waits for every other epic ticket, including bugs added later. `release_gates` names any open tickets, bugs, known gaps, partial exits or checklist items; settle them with the producer before Review or Done. When Release reaches Done, Docket closes the epic automatically.
