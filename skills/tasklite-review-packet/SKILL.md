---
name: tasklite-review-packet
description: Hand work to the owner for human review in Task Lite. Covers declaring good human review items, preparing evidence, writing a submit_packet the owner can verify in minutes without asking you anything, and handling later rounds. Use when an item has (or needs) human review items, or when you're about to call submit_packet or get_review.
---

# Review packets the owner can clear in minutes

The packet is the most expensive moment in the loop, because it costs the owner's time. A good one lets them verify without asking you anything. A vague one costs a round trip and a second packet.

## 1. Declare human review items early

Use `declare_human_review`, ideally during Planning or at the latest when you write the plan.

| Good                                                                          | Bad                   |
| ----------------------------------------------------------------------------- | --------------------- |
| "On your phone, drag a recipe between days. Does it feel right?"              | "Check drag and drop" |
| "Export one week's list and paste it into your notes app. Does it read well?" | "Verify export works" |
| "Sign in from a second browser. Is the first one signed out within a minute?" | "Test sessions"       |

**Each item should be:**

- one plain instruction;
- something only a person can judge (feel, wording, a real device), not what your tests already prove;
- 1–5 items per packet.

**If an epic ships as one PR,** declare once on the epic. With no human review items, you close the item yourself with `set_status done`.

## 2. Before you submit

- [ ] Everything is committed, pushed and reported (`report_commit … pushed: true`).
- [ ] Agent checks pass. A failed check is allowed only with a gap that explains it. Without one, the packet is rejected.
- [ ] You know the exact commit the packet is built from (`built_from_commit`), and it's been reported.
- [ ] Screenshots or recordings are uploaded for anything visual: `put_document { kind: "packet_attachment" }`. Keep the `document_version_id`s.
- [ ] Nothing is left running for the owner. Give them commands to start what they need, instead of leaving a preview server running after your run ends.

## 3. Write the packet

Call `submit_packet` with these fields:

| Field         | How to write it                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `estimate`    | An honest owner time, such as `"10 min"`. If it's above 20 minutes, ask yourself whether the packet should be split.                                                              |
| `how`         | 1–15 numbered steps the owner can follow **without you**: exact commands, URLs, branch, test account and data, and what they should see. One action per step.                     |
| `checked`     | What you already verified, each with `provenance` (`agent`, `observed` or `ci`) and `evidence` (the command and its result, or the CI run). That way the owner doesn't repeat it. |
| `gaps`        | What you didn't or couldn't verify ("Not tested on Android"). Honest gaps build trust, and missing ones break it.                                                                 |
| `attachments` | The uploaded versions, each with a one-line caption saying what it shows.                                                                                                         |

**Example `how`:**

```
1. git fetch && git checkout rcp-12-planner && pnpm i && pnpm dev   (takes about 1 min)
2. Open http://127.0.0.1:5173/plan on your phone (same Wi-Fi) or in a narrow window.
3. Drag "Lentil soup" from Monday to Wednesday dinner: it should snap into the slot and stay after a reload.
4. Keyboard only: Tab to a recipe, Space to lift, arrows to move, Enter to drop.
```

**After submitting,** the item moves to Review. Call `finish_run { result: "finished", summary }` and stop. Don't wait in the session for the decision.

## 4. Later rounds

- **The owner sends it back:** it shows up as `resumable`. Claim it again, then call `get_review { id }`.
  - Each "changes" note is already a checklist step, or a new Bug (see `result_ref`).
  - Approved items stay approved.
  - Leave deferred items alone unless you're doing cleanup.
- **Fix, then resubmit:**
  1. Fix and report the commits.
  2. Submit a new packet from the new commit.
  3. In `how`, point the owner at what changed since the last round.
- **A commit after submitting** still gets `report_commit`. The open packet is then marked out of date for the owner, who may ask for a fresh one (it comes back as `resumable`, with a note).

## Don't

- Ask the owner to verify what tests already prove.
- Write steps that need you to explain them ("run the usual setup").
- Hide a failing check or an untested platform.
- Close the item with `set_status` while review items are undecided. It fails by design.
