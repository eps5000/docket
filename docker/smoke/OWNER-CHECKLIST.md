# Owner checklist: real clients, PDF preview, and NVDA

The owner remains responsible for the onboarding and Settings acceptance pass. Record a
result for each observed surface and each interactive question; leave everything else
**Not verified**. The three DKT-10 pilot receipts below are bounded runtime evidence, not
a complete four-surface or owner verdict.

| Surface               | Bounded pilot observation                                                                               | Owner result |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------ |
| Installed Codex CLI   | RCP-32: connection, claim, plan, step, six-PASS check, release                                          |              |
| Installed Claude Code | RCP-33: same receipts on another disposable item; default `.claude.json` changed and needs owner review |              |
| Orca Codex worker     | RCP-32 on another instance: same receipts through its worker's direct MCP SDK route                     |              |
| Orca Claude worker    | Not verified; separate supervised Claude Dispatch and startup isolation gate remain                     |              |

DKT-10 holds the installed-client phase-one document and later Orca Codex worker evidence.
Repeated RCP-32 identifies different disposable instances.

## 0. Prove the disposable boundary

- [ ] Read live and dev container IDs, published addresses, mounts, volume names, and health.
      The live `127.0.0.1:7420` and dev `127.0.0.1:7421` instances are outside this pilot.
- [ ] Use [README.md](README.md#safe-disposable-route) to create a uniquely named container
      and named volume with no host-code bind, publishing **only** `127.0.0.2:7421:7420`.
      Stop if the exact bind or readback fails. Do not use the checked-in compose file or an
      older checklist unchanged.
- [ ] Record exact disposable container/image/volume identity, mount, bind, and health.
      Set `DOCKET_URL=http://127.0.0.2:7421` in the task process and run
      `node docker/smoke/smoke.mjs preflight`. Confirm that MCP readback is from that
      disposable instance before any `prepare`, `check`, or `pdf` write.
- [ ] Record only hashes and presence for default user Codex config/auth, default Claude
      config/auth including `.claude.json`, and relevant project MCP files. Do not copy,
      print, edit, or restore those files. If a default hash changes, stop and preserve
      evidence for owner recovery rather than overwriting concurrent state.

## 1. Installed Codex CLI

- [ ] Follow [codex.md](codex.md) with task-only startup and already available isolated
      auth. Stop if isolated auth or the invocation-scoped route cannot be proved.
- [ ] Record the new item ID, client identity, Docket run ID, six smoke PASS/FAIL lines,
      and the claim, plan, first step, readback, and release receipts.
- [ ] **V1:** Observe an interactive open session across the idle window; record live or
      reported. **V6:** Observe the result part the model actually receives. **V7:** Observe
      skill loading from a task-only location. Otherwise each is **Not verified**.

## 2. Installed Claude Code

- [ ] Follow [claude-code.md](claude-code.md). `CLAUDE_CONFIG_DIR` plus strict task-only
      MCP is a candidate that needs invocation-scoped startup proof and isolated auth.
- [ ] Record the same item, identity, run, six checks, and tool receipts as step 1.
- [ ] **V1:** Observe an interactive idle window. **V3:** Observe the relevant expansion
      behavior without exposing a token. **V6:** Observe what reaches the model. **V7:**
      Observe skill loading from the isolated task location. Otherwise **Not verified**.
- [ ] Compare the default `.claude.json` hash. If changed, stop for owner recovery; do not
      restore a backup over it. The earlier pilot's config change is a separate owner-review
      concern, even though the disposable-ticket receipts passed.

## 3. Orca Codex worker

- [ ] Follow [orca-codex.md](orca-codex.md) with a supervised Dispatch and explicit
      worker-process MCP SDK route or proved task-only Codex startup. Do not count an
      inherited host config as a connection receipt.
- [ ] Record the item, worker/Dispatch identity, run, six checks, and actual tool receipts.
      Observe interactive V1–V3/V6/V7 only if tested; otherwise **Not verified**.

## 4. Orca Claude worker

- [ ] Ask the DKT-1 producer for a **separate supervised Claude Dispatch** only after an
      invocation-scoped startup route is proved. A standard Orca worker launch has no
      per-worker environment flag and does not isolate Claude automatically.
- [ ] Follow [orca-claude.md](orca-claude.md). Stop if isolated auth is absent, routing is
      uncertain, or default `.claude.json` changes.
- [ ] Record the item, worker/Dispatch identity, run, six checks, and actual tool receipts.
      This surface and its V1–V3/V6/V7 observations remain **Not verified** until then.

## 5. Owner UI and accessibility review

- [ ] On the **disposable** instance, read Agents for the four runs and their client/label,
      and Settings → Connections for last-seen state. Do not mark a compatibility entry
      verified from a client config file or a partial pilot receipt.
- [ ] With the disposable URL still proved, use `node docker/smoke/smoke.mjs pdf`. In
      Chrome, open RCP-14 → Details → Documents → **pdf-preview-check.pdf**; verify its
      one-page preview and Download.
- [ ] With NVDA in Chrome, open RCP-12 from Needs you. Check its card, packet heading,
      decision controls, required note announcement, and disabled submit state. Navigate
      away without submitting. Record anything NVDA missed or read incorrectly.
- [ ] Complete the separate owner onboarding review. Any compatibility matrix,
      BUILD_SPEC §12, or T146 source change needs pinned scope, independent review,
      focused tests, PR/CI/queue/main gates, and explicit owner acceptance.

## 6. Close the disposable attempt

- [ ] Compare both existing containers' IDs, mounts, published addresses, and health with
      pre-state. Compare default user/project config/auth hashes and presence with pre-state.
- [ ] Release **only** the exact disposable container and volume created and verified for
      this attempt, container first. Stop if ownership or identity is uncertain. Leave live
      Docket and the dev instance running.
