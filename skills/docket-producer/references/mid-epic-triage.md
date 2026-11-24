# Triaging work added mid-epic

**Read when:** The digest lists a ticket under `added mid-flight`, or a new bug or story arrives in your running epic.
**Don't read when:** Nothing was added to the epic since it started.

New tickets land in Inbox, even in a running epic. Nothing joins it as Ready without triage, and the epic can't close until each one is triaged.

## A bug

1. **Start a short, read-only reproduction agent** (a subagent, not an implementer). It confirms the bug, finds whether this epic's work caused it, and leaves the steps or a failing test in an `add_note`. It fixes nothing.
2. **Real and belongs here:** set its priority, shape it (outcome, acceptance and shared changes) and move it to Ready in this epic. It then holds the epic's release until it's fixed.
3. **Belongs elsewhere:** move it with `update_item { epic }`. A flaky test goes to the project's test-reliability epic.
4. **Can't be reproduced:** say so in an `add_note` and `ask_owner` whether to close it.

## A story

A story adds scope, so it's the owner's decision. Ask once with `ask_owner`, with three options: add it to this epic, defer it to a follow-up, or drop it. Then act on the answer. A story the owner adds still needs shaping before it's Ready.
