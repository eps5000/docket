/**
 * The client compatibility matrix (FR-107; UI_SPEC §6.7; BUILD_SPEC §10
 * "Smoke test with real clients", §12 V1–V3; MCP_SPEC §11).
 *
 * One row per supported surface. `verified` stays null until a person runs
 * the smoke kit in `docker/smoke/` (O07) and records the result here, in a
 * reviewed change (T146): a surface is never shown as verified by default
 * (constitution Principle III: unknown is not done).
 *
 * "Last seen" comes from runs: `client` is the normalised MCP client name
 * (BUILD_SPEC §3). Orca workers are told apart by their `agent_label`
 * starting with `orca`, which is how the coordinator skill labels them;
 * a worker that doesn't follow that convention shows under the host client.
 */
export interface CompatSurface {
  name: string;
  client: string | null;
  orca: boolean;
  transport: string;
  /** When the smoke test passed (ISO day) and what it showed; null until it has. */
  verified: { on: string; notes: string } | null;
  /** Shown while the surface is not verified. */
  notes: string;
  /** A surface that is off by default and needs setup to exist at all. */
  offByDefault?: boolean;
}

export const COMPAT_SURFACES: readonly CompatSurface[] = [
  {
    name: 'Codex CLI (host)',
    client: 'codex',
    orca: false,
    transport: 'Streamable HTTP',
    verified: null,
    notes: 'Not smoke-tested yet. Run docker/smoke (O07).',
  },
  {
    name: 'Claude Code (host)',
    client: 'claude',
    orca: false,
    transport: 'Streamable HTTP',
    // B18 (T146): the smoke kit passed headless (claude -p 2.1.318, a temporary
    // --mcp-config, a disposable instance). The README's user-scope setup, the UI checks
    // and an interactive session are still the owner's to run, so this stays unverified.
    verified: null,
    notes:
      'Headless smoke passed Nov 17 (claude -p, temporary config). Your user-scope setup: not verified yet. Run docker/smoke (O07).',
  },
  {
    name: 'Orca worker · Codex',
    client: 'codex',
    orca: true,
    transport: 'Streamable HTTP (user config)',
    verified: null,
    notes: 'Inherits the user config in discovery. Not smoke-tested yet.',
  },
  {
    name: 'Orca worker · Claude',
    client: 'claude',
    orca: true,
    transport: 'Streamable HTTP (user config)',
    verified: null,
    notes: 'Check that this surface inherits the user MCP config (V2).',
  },
  {
    name: 'Agent in another container',
    client: null,
    orca: false,
    transport: 'Docker network',
    verified: null,
    notes: 'Off by default. Needs an explicit network path (O02).',
    offByDefault: true,
  },
];
