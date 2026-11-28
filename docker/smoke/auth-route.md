# DKT-34 no-copy client startup boundary

This source artifact prepares a DKT-10 pilot; it does not authenticate or start a client.
`auth-route.mjs` performs a read-only, hash-only preflight and reports `STOP` until a
separately reviewed task-only authentication source and Orca process startup route exist.
Never treat its output as a four-client smoke receipt or an owner verdict.

## Candidate route

- **Installed Codex:** Create an absolute task-only `CODEX_HOME` before launch.
  One-process `cli_auth_credentials_store=ephemeral` and an invocation-only MCP
  override are candidates. A fresh ChatGPT login must occur in that **same**
  process; an ephemeral login in a separate `codex login` process cannot carry
  over. An approved API/access-token or managed identity route is another
  candidate. Never reuse default `auth.json`.
- **Installed Claude:** Use an absolute task-only `CLAUDE_CONFIG_DIR` and home
  with strict invocation-only MCP config. Fresh task-only login or an approved
  process-injected API/OAuth credential is needed; never copy default
  `.credentials.json`. Console keyless sign-in may reside outside
  `CLAUDE_CONFIG_DIR` and requires a separate boundary proof.
- **Orca Codex and Orca Claude:** A custom terminal running the isolated
  process, followed by `worker-start --terminal`, is a candidate. Prove that
  the terminal preserves task-only startup and authorized auth on the exact
  Dispatch.

The custom-terminal path is documented by the installed Orca CLI but remains a
**candidate** until an independent process-level test proves its environment and
the worker Dispatch binds to that exact terminal. Standard `worker-start --agent`
does not offer a per-worker environment flag. No command may place a credential
value in terminal arguments, a command string, Docket evidence, logs, or source.
The preflight lists environment variable **names** as candidates only; a name
does not prove a usable token, approved provider, billing choice, or startup
boundary. The fake-process guard compares default/project hashes before and
after and throws STOP with logical labels on drift. Real client launching is
intentionally absent pending an independently reviewed auth source.

## Child process containment remains a gate

An API key placed in a client environment can also reach its shell, tool, or
other child processes. The fake-client test demonstrates this inheritance for
all four named surfaces, then demonstrates stripping in a **test-only** child
environment. `fakeToolEnvironment` is a model, not a hook into Codex, Claude,
or Orca, and it cannot establish real containment.

For a real Codex pilot, independently review the installed version's
`shell_environment_policy` with `inherit=core`,
`ignore_default_excludes=false`, and an explicit API-key exclusion. Prove with
an artificial canary that commands do not inherit it. This filter alone does
not prevent reads from credential files or helpers, so the process also needs
a separate least-privilege execution identity and a task-only profile.

For a real Claude pilot, `--restricted --tools "" --strict-mcp-config` is a
candidate for removing command, code, and file tools while retaining only the
exact Docket MCP route. Review installed-version behavior, managed settings and
managed MCP precedence, and prove that no shell or other subprocess-capable
tool remains. Claude does not have a proven general shell-environment key
filter here. If tool containment cannot be proven, STOP that surface. Orca
Codex and Orca Claude need separate proof that their actual Dispatch uses the
reviewed task-only startup and tool policy; a custom terminal alone is not
that proof.

Any task-only broker lease must be short-lived, least-privilege, bound to the
approved account and billing context, restricted to the intended surface, and
revoked on STOP, default/project drift, or release. No real key, lease, client,
Docker resource, or host action is exercised by this harness.

## Required gate sequence

1. Owner settles only the material account/auth-source choice after the options
   and costs are presented. A new API key or broker is never inferred from an
   existing subscription. Independent review checks current official client
   behavior and the proposed provider without accessing existing credentials.
2. Confirm a unique sample-seeded container and volume, exact
   `127.0.0.2:7421` bind, and unchanged identities of live 7420 and the dev
   instance. The pure manifest check returns `IDENTITY_CANDIDATE` for
   caller-supplied fields; it does **not** prove Docker provenance or authorize
   cleanup. The supplied manifest must show the pilot's sole mount as its exact
   disposable volume at `/data`; action-time Docker inspection must prove sole
   use independently.
   `auth-route.mjs` rejects any other endpoint or a task profile
   under the default user home or project root. Its current preflight never
   starts Docker or a client.
3. Record hashes and presence only for default Codex/Claude auth/config and
   relevant project config. Do not save credential/config copies. Use an
   approved task-only profile (including its own temp directory) and an explicit
   process route. Stop if auth or
   startup isolation is absent or if any default/project hash changes; do not
   attribute unproved drift to a particular process.
4. Only after review and action-time gates, test each surface separately with
   actual connection, claim, plan, step, check, and release. Observe V1/V6/V7
   directly; mark missing observations **Not verified**. Clean up only the
   exact created container and volume after sole-use/identity recheck.

The two old Temp `.pre` credential/config files are separate legacy custody
items whose deletion was blocked by automatic approval review. Leave them
untouched; they are not a prerequisite for a new no-copy pilot and are not
routine owner cleanup work.

Official behavior: [Codex authentication](https://developers.openai.com/codex/auth),
[Codex environment variables](https://developers.openai.com/codex/config-file/environment-variables),
[Claude authentication](https://code.claude.com/docs/en/authentication),
[Claude settings](https://code.claude.com/docs/en/settings),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Codex shell environment policy](https://learn.chatgpt.com/docs/config-file/config-advanced),
and [Codex security guidance](https://learn.chatgpt.com/docs/enterprise/security-cookbook).
A DKT-33 reviewer must recheck these before any real invocation.
