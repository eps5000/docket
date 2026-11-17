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
 *
 * Each surface's result mode (MCP_SPEC §3 Results; owner decision 28) comes
 * from the `clientInfo.name` it sends and TASKLITE_TEXT_ONLY_CLIENTS, as it
 * does for a live session (mcp/server.ts `resultMode`).
 */
/** How a session's tool results are shaped (MCP_SPEC §3 Results). */
export type ResultMode = 'structured' | 'text';

/**
 * The result mode for a `clientInfo.name`: `text` when TASKLITE_TEXT_ONLY_CLIENTS
 * (lower-cased, config.ts) lists it exactly, ignoring case; else `structured`.
 */
export function resultMode(
  name: string | null | undefined,
  textOnlyClients: readonly string[],
): ResultMode {
  const lower = (name ?? '').trim().toLowerCase();
  return lower !== '' && textOnlyClients.includes(lower) ? 'text' : 'structured';
}

export interface CompatSurface {
  name: string;
  client: string | null;
  /**
   * The exact `clientInfo.name` the surface sends at `initialize`, which
   * decides its result mode; null when there's no single one.
   */
  clientInfoName: string | null;
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
    // Codex's MCP client name (its source); not yet seen from a real Codex (smoke test).
    clientInfoName: 'codex-mcp-client',
    orca: false,
    transport: 'Streamable HTTP',
    verified: null,
    notes: 'Not smoke-tested yet. Run docker/smoke (O07).',
  },
  {
    name: 'Claude Code (host)',
    client: 'claude',
    // Seen from Claude Code 2.1.318 headless (B19).
    clientInfoName: 'claude-code',
    orca: false,
    transport: 'Streamable HTTP',
    // B18 (T146): the smoke kit passed headless (claude -p 2.1.318, a temporary
    // --mcp-config, a disposable instance). The README's user-scope setup, the UI checks
    // and an interactive session are still the owner's to run, so this stays unverified.
    verified: null,
    notes:
      'Headless smoke passed Nov 17 (claude -p, temporary config). Your user-scope setup is still to check: run docker/smoke (O07).',
  },
  {
    name: 'Orca worker · Codex',
    client: 'codex',
    // Orca launches the installed client, so the worker sends the host client's name.
    clientInfoName: 'codex-mcp-client',
    orca: true,
    transport: 'Streamable HTTP (user config)',
    verified: null,
    notes: 'Inherits the user config in discovery. Not smoke-tested yet.',
  },
  {
    name: 'Orca worker · Claude',
    client: 'claude',
    clientInfoName: 'claude-code',
    orca: true,
    transport: 'Streamable HTTP (user config)',
    verified: null,
    notes: 'Check that this surface inherits the user MCP config (V2).',
  },
  {
    name: 'Agent in another container',
    client: null,
    clientInfoName: null,
    orca: false,
    transport: 'Docker network',
    verified: null,
    notes: 'Off by default. Needs an explicit network path (O02).',
    offByDefault: true,
  },
];
