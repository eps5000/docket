# DKT-35 task-only broker source boundary

This module is a **fake-provider contract probe**. It does not obtain an API
credential, start Codex or Claude, connect an Orca worker, start Docker, change
user or project configuration, or accept a real provider. It builds on the
[DKT-34 STOP-only preflight](auth-route.md). A passing fake test is source
evidence, not a four-client DKT-10 receipt.

## Fake lease contract

`runFakeBrokeredPilot` accepts only a provider with `kind: "fake"`. Before
requesting its synthetic lease it requires the exact Docket MCP URL
`http://127.0.0.2:7421/mcp`, an existing task-only profile with its own home,
config and temp directories, a fake manifest with the sole sample-data volume,
and synthetic account and billing bindings. The manifest assessment is based
on caller-supplied data; it never proves Docker provenance or grants cleanup
authority.

The synthetic lease must identify DKT-10, one of the four named surfaces, the
sample pilot scope and MCP URL, the corresponding API-key environment variable,
the same account and billing bindings, least privilege, and a revocation
function. Its lifetime must be positive and at most five minutes; the fake
clock is checked again after the child exits, with expiration treated as STOP.
Only a
`FAKE_DKT35_` key can enter the fake Node child environment, and only through
the exact task-profile `fixture/fake-client.mjs` test path. The module returns
categories and booleans; it never returns or logs the key, bindings, default
file paths or provider exceptions. It calls the provider's revoke callback on
release and after a STOP. A successful callback is reported only as
`revoke_call_completed`; it does not prove the provider revoked anything. Even
an exception from `provider.issue` that mimics a local STOP code is classified
as `STOP_FAKE_BROKER_ERROR`. A missing provider, malformed lease, unsafe route/profile/resource,
failed fake child, changed default or project hash, or failed revoke stops the
probe.

The fake child inherits a synthetic key so tests can exercise the lease
lifecycle. This does **not** contain a real agent's shell or tool descendants:
the [DKT-34 regression](auth-route.test.mjs) shows that environment variables
flow into descendants unless an actual client/tool policy strips them. The
`fakeToolEnvironment` helper is a test model only. The module has no real
launcher and rejects a provider marked `real`.

## Facts still required for real startup

1. An approved dedicated API credential source and broker identity for both
   OpenAI and Anthropic, with account and billing binding, task-only scope,
   short expiration, revocation, audit custody and a reviewed in-memory
   handoff. The owner selected dedicated credentials; no actual broker,
   credential or lease has been established by that choice.
2. A separate least-privilege execution identity and proof that the installed
   Codex version excludes its API key from shell descendants. The documented
   `shell_environment_policy` candidate (`inherit=core`,
   `ignore_default_excludes=false`, explicit key exclusion) needs an artificial
   canary. Environment filtering alone does not prevent a process from reading
   credential files or helpers.
3. Installed Claude version and managed-policy review proving a no-shell,
   no-subprocess tool set with only the exact Docket MCP route. The
   `--restricted --tools "" --strict-mcp-config` flags are a candidate, not an
   observed boundary; `--tools` does not restrict MCP tools, and managed
   settings/MCP precedence must be checked. STOP if a command-capable tool
   remains.
4. Separate Orca Codex and Orca Claude proof that the actual Dispatch starts
   in the reviewed task-only environment, with the approved lease and tool
   policy. A custom terminal or ordinary `worker-start` command is not proof
   of inheritance.
5. Action-time disposable-container and volume ownership, protected live/dev
   identity and health, hash-only before/after default and project custody,
   and separately recorded DKT-10 connection, claim, plan, step, check,
   release and V1/V6/V7 observations for all four surfaces. DKT-10's two
   independent checks and DKT-2 Release remain open.

Hash comparisons detect an observed before/after change; they cannot rule out
a transient write restored between snapshots. The separate execution identity
and native tool policy must prevent default and project writes in the real
pilot, with independent action-time review.

The old task-only Temp `.pre` files remain separate legacy custody items whose
deletion was rejected by automatic approval review. They are untouched and
are not a prerequisite or owner cleanup task for a future no-copy pilot.

Official client references: [Codex authentication](https://developers.openai.com/codex/auth),
[Codex environment variables](https://developers.openai.com/codex/config-file/environment-variables),
[Codex shell environment policy](https://learn.chatgpt.com/docs/config-file/config-advanced),
[Codex security guidance](https://learn.chatgpt.com/docs/enterprise/security-cookbook),
[Claude authentication](https://code.claude.com/docs/en/authentication), and
[Claude CLI options](https://code.claude.com/docs/en/cli-reference).
