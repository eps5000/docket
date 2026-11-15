# Task Lite: roadmap and references

Status: 2026-11-14. This file holds three things:
1. what has to happen before a pilot;
2. what is deliberately **not** in V1, and what would trigger building it;
3. the TERSL/Tourbillon reference notes.

**Nothing here is a build instruction for V1.** The V1 contract is [BUILD_SPEC.md](BUILD_SPEC.md), [MCP_SPEC.md](MCP_SPEC.md) and [UI_SPEC.md](UI_SPEC.md).

---

## 1. Before the pilot

Do these after V1 passes M8 and before a real project depends on Task Lite.

1. **Use it to build itself.** Once M4 is done, load milestones M5–M8 into Task Lite and have the integration agent work them as real tickets, with human review on the UI ones. It's the cheapest real test of the tool descriptions, `get_context`, packets and decisions.
2. **Have a way out.** Make the `tasklite export` CLI (a stretch goal in M7) required: a complete JSON export plus the documents (O06). Without it, a pilot that goes badly has no clean exit.
3. **Run a restore drill.** Restore one nightly backup into a scratch container and confirm that items, events and documents come back.
4. **Choose the pilot project.**
   - Run the Jira import dry run on the candidate and read the report before committing.
   - Fill in [templates/AGENTS-tasklite.md](templates/AGENTS-tasklite.md) for it: who moves work to Ready, when human review is required, which planning docs are expected, and its blocker rule.
5. **Write down what success looks like.** For example:
   - two weeks of real work;
   - agents use Task Lite without reminders;
   - packets let the owner verify without asking the agent anything;
   - nothing is lost;
   - the owner checks Needs you instead of Jira.

   **Measure what the TERSL benchmarks measure:** tokens per call (logged), tool calls per item, time from Ready to Done, and how often agents get conflicts or validation errors.

---

## 2. Not in V1, on purpose

Each entry has a trigger: the evidence that would justify building it.

| Idea | Why not now | Trigger to reconsider |
|---|---|---|
| **A dispatcher**: Task Lite (or a companion process) notices newly eligible work and starts agents | Owner decision 18: Task Lite coordinates and Orca dispatches. Dispatching adds agent capacity, worker choice, worktrees and failure handling. | The pilot shows agents idle while ready work waits, and Orca can't be configured to poll `ready_to_start`. If so, build it as a **separate process** (for example `tasklite-dispatch`, using `get_changes` and the `orca` CLI), not inside the service, and add a "became startable" event to the change feed first. |
| **GitHub and CI integration** (A14) | It needs credentials, webhooks or polling, and a mapping of repos to projects. | Agent-reported merges (`satisfied_when: merged`) prove unreliable, or the owner wants packets to verify their commit really landed. It would make "merged" and CI state *observed* rather than reported. |
| **Versioned contracts and invalidation**: an interface document (an API schema, say) has versions, dependents record the version they built against, and a new version flags them | V1 has the pieces (document versions, packet staleness, decision records) but not the linkage. | Agents build against a stale interface during the pilot, i.e. a "context freshness" failure. |
| **A knowledge layer beyond decision records**: lessons learned and architecture notes, with provenance and contradiction checks | Decision records cover "rules agents must follow". General memory is a different product. | Agents repeatedly rediscover the same things. Evaluate tersl-brain-style source hashing and contradiction flags (§3), or an existing memory tool, before building one. |
| **A "became startable" event, `next_work`, `wait_for_work`** | The owner chose polling with `search_items` (2026-11-08). | Comes with the dispatcher, if that happens. |
| **Editing dates, blockers and acceptance in the UI** (H11); a cancel action; a restore UI; bulk agent tools (A12) | The scope cuts listed in BUILD_SPEC §1. | Owner friction during the pilot. |

---

## 3. TERSL / Tourbillon: reference and learnings

**Owner decision 20:** use TERSL as a reference, not a dependency.

**Why it came up.** A ChatGPT conversation (2026-11-14) suggested reframing Task Lite as an "agent-first development control plane", built on or alongside Tourbillon's TERSL. This section records:
- what Tourbillon actually offers, checked against its site and repositories on 2026-11-14;
- what we took from it;
- why we didn't adopt it.

### What it is
- **TERSL** (the repository calls it **TERSE**) is "an open hierarchical state language for humans and AI agents".
  - **State and patches:** "the file *is* the state, and agents patch it by declaration instead of rewriting whole documents"; "what you don't restate, you don't change".
  - **Queries:** start with `?`, for example `? Cases.* [WHERE Its.priority == "high"]`.
  - **Mutations:** use `+`/`-` attribute prefixes, `[MERGED]` and `[REMOVED]`.
  - **License and maturity:** Apache-2.0, v0.2.8, "pre-release. APIs and spec details may change before 1.0". Sources: [tourbillon.ai](https://tourbillon.ai/), [cheatsheet](https://tourbillon.ai/cheatsheet), [terse-lang/terse](https://github.com/terse-lang/terse).
- **terse-mcp** (open source) is "intended for local single-user agentic workflows", with "No multi-client concurrency". Concurrent operator and AI writes "can lose updates". Concurrency at the database layer is described only for an unpublished enterprise product, whose link is "TBD". Source: [terse-mcp README](https://github.com/terse-lang/terse/tree/main/terse-mcp).
- **TERSL/DB** is described only on the homepage: "Transaction-level support, up to full serializability", access control and encryption. There's no documentation page. Hosted plans run from free to $99/month, plus enterprise. Source: [tourbillon.ai](https://tourbillon.ai/).
- **tersl-memory:** one-person agent memory over MCP, with lint checks (dangling refs, schema violations, secret leaks). Its README says: "One human … not a team substrate."
- **tersl-brain:** an LLM-maintained wiki. Sources are registered with sha256 hashes, and it flags drift, contradictions and unsourced claims.
- **CodeBoss:** a separate MIT-licensed tool that drives Claude Code by injecting input through OS accessibility APIs. Its README calls this "a bit of a hack".
- **Benchmarks are vendor-run:**
  - ~2.5× fewer tokens than JSON, on "our internal corpus" (1.5–3× depending on shape);
  - one knowledge-base workload (72 graded answers per arm): 6.5× fewer tool calls, 3.5× faster and 2.9× fewer input tokens, at similar accuracy (91.7% vs 93.1%).

  The page's own caveats: a single workload, the choice of judge shifts pass rates, and the format is pre-1.0. The harness is said to ship in the repo, but we couldn't find it. Source: [benchmarks](https://tourbillon.ai/benchmarks).

### What we took (V1)
| TERSL idea | Applied in Task Lite |
|---|---|
| "Silence preserves": patch by declaration, don't rewrite | `set_plan` and `set_checks` default to patch mode; `update_item` changes only the fields sent; `add_labels` and `remove_labels` (MCP_SPEC §3.3) |
| Identity-first, low-punctuation state | The compact text format for every tool result, with IDs first, bare-word flags and checklist markers. It's our own output format, not TERSL (MCP_SPEC §3.1). |
| Targeted queries instead of reading everything | `get_item` `view` and `fields`, and `get_context` with budgets (MCP_SPEC §3.2, BUILD_SPEC §5.15) |
| Lint checks on writes (secret leak, dangling ref) | Secret-looking text is rejected; references to items that don't exist produce warnings (MCP_SPEC §3.4) |
| Source hashing and drift (tersl-brain) | Already present: document versions carry sha256, and packets go stale when a newer commit is reported. Contract invalidation (§2) would extend it. |
| Measure tokens and tool calls, not just accuracy | Token budgets in the contract tests (MCP_SPEC §10), and the pilot metrics (§1) |

### Why not adopt it
- **Concurrency is our core requirement, and the open-source TERSL stack doesn't offer it.** Multiple agents claiming and updating the same items is exactly what Task Lite must get right (A07, A15). terse-mcp is single-user and can lose updates. TERSL/DB, which claims serializable transactions, is closed and undocumented. SQLite with `BEGIN IMMEDIATE` already gives one local service serializable writes.
- **Maturity.** It's pre-1.0, has 3 commits on the main repo, and isn't published as a package.
- **MCP is JSON by design.** Agents' clients already parse JSON tool results. The token cost sits in what we choose to *return*, which we now control with views, budgets and the compact text format.
- **The benchmarks are the vendor's own,** on workloads unlike issue tracking.

### Optional experiment, after V1
If token cost turns out to matter in the pilot, run the ChatGPT conversation's comparison with real V1 traffic. Encode the same results three ways:
1. Task Lite JSON (`structuredContent`);
2. Task Lite's compact text;
3. a TERSL encoding of the same state.

**Compare:** tokens per task, tool calls per item, task completion and correctness across the §7 flows in MCP_SPEC, and recovery after a conflict. Adopt TERSL as an *output encoding* only if it clearly beats the compact text on both tokens and correctness. Its database isn't in question.
