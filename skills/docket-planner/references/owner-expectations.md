# Owner expectations and delegated choices

**Read when:** You shape a new goal or cannot tell which choices the owner delegated.
**Don't read when:** The approved design already states the outcome, constraints, review points and delegated bounds.

Before asking, read the goal, approved design, applicable owner decisions and Workflow notes. In the planning document, write four short sections:

1. **Must be true:** the user-visible outcome and acceptance checks the owner cares about. Quote or link the source; don't silently strengthen or weaken it.
2. **Must stay within:** constraints such as privacy, security, cost, compatibility, deployment scope and timing, where the source actually sets them. Note any explicit human review or approval gate.
3. **Agents may choose:** likely decisions needed to deliver the outcome, with the range of acceptable options. Include design details, technical approach, ordering and reversible implementation choices when the design permits them. Mark the scope of each bound (ticket, epic or project).
4. **Owner must settle:** genuine gaps where two reasonable paths would produce materially different outcomes, risk or cost. Give a recommendation and the consequence of each path. Group related questions in one planning exchange; don't ask the owner to reapprove already settled parts.

Ask what the owner actually cares about only where the sources leave a material boundary unclear. For example: “The design requires a Dev rollout before the final release. Does Dev count as acceptance, or must this epic also reach production?” Once answered, update the design or publish the owner decision in scope. A brief hand-back note should name any remaining unresolved boundary and the affected tickets.

When the owner approves the design, workers can choose within these bounds and proceed quietly. A consequential choice that other tickets must follow becomes a narrowly scoped **agent** decision; a local choice belongs in a ticket note. An agent decision never claims to be owner approval. A later change in owner preference becomes a change request or follow-up. A new material risk, a conflict with an owner decision, a design deviation, or a destructive action without explicit authority still goes to the owner. Project approval gates always apply.
