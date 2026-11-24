# Closing an epic through its Release

**Read when:** You shape, dispatch or close the epic's Release, or it reports `release_gates`.
**Don't read when:** The epic is still in ordinary ticket work.

There is exactly one Release per epic, created with it and shaped during planning. It owns the integrated checks, deployment and release decision for the epic's real users. Its checklist records the journeys, flag-on checks, deploy, smoke test and evidence that apply here. An intermediate shared-environment change is its own Implementation ticket marked `rollout: true`, linked to the tickets that wait for it. Two releases to real users require two epics.

Docket makes the Release depend on every other ticket in the epic, including bugs and tickets added later. It refuses Review or Done with `release_gates` until every other ticket is Done, canceled with a reason or moved out; no bug is open; known gaps and partial exits are settled; and the Release checklist is complete. Read the refusal's details and resolve each named gate. Do not add manual links to imitate the automatic dependencies.

Dispatch the Release as a ticket with its own implementer. Attach integrated and deployment evidence there with `link_artifact`. Declare owner review on the Release when the project requires a release decision. After its checks pass, the implementer submits its packet or closes it with `set_status done` as allowed. Docket then closes the epic automatically. Verify the epic and Release states in the returned result.

For older epics, Docket converts an obvious release ticket or generates one. An ambiguous choice is marked Needs shaping: send a planner to select and shape it before starting the epic.
