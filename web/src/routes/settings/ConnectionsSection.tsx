import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { LEGACY_VOLUME, type SettingsResponse } from '@docket/shared';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Dialog,
  DialogCancel,
  EmptyState,
  ErrorState,
  SegmentedControl,
  Skeleton,
} from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { formatAgo, formatStamp, isoTitle, plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { showToast } from '../../lib/undo';
import { HelpLink } from '../../help/HelpLink';
import { GitHubCard } from './GitHubCard';
import { UsageSourceCard } from './UsageSourceCard';

/**
 * The user-wide client setup snippets, exactly as MCP_SPEC §11 gives them. In
 * protected mode the token is always `$DOCKET_TOKEN`, never its value; in
 * local trust (decision 32) there is no token at all (LOCAL_SNIPPETS).
 */
export const SNIPPETS = {
  codex: `# ~/.codex/config.toml\n[mcp_servers.docket]\nurl = "http://127.0.0.1:7420/mcp"\nbearer_token_env_var = "DOCKET_TOKEN"`,
  claude: `claude mcp add --transport http --scope user docket \\\n  http://127.0.0.1:7420/mcp \\\n  --header "Authorization: Bearer $DOCKET_TOKEN"`,
} as const;

/** Local trust (decision 32): the same connections without the token. */
export const LOCAL_SNIPPETS = {
  codex: '# ~/.codex/config.toml\n[mcp_servers.docket]\nurl = "http://127.0.0.1:7420/mcp"',
  claude: 'claude mcp add --transport http --scope user docket http://127.0.0.1:7420/mcp',
} as const;

/** The Security line (UI_SPEC §6.7e). */
export const SECURITY_TEXT = {
  local:
    'Local trust: anything on this computer can use Docket. Turn on protected mode to require an unlock and an agent token.',
  protected: 'Protected mode: this browser needs the owner key, and agents need the agent token.',
} as const;

/** *Reveal token* shows the token for this long, then hides it (UI_SPEC §6.7). */
export const REVEAL_MS = 30_000;

const CLIENT_STATUS = {
  verified: { kind: 'ok', label: '✓ Verified' },
  not_verified: { kind: 'warn', label: 'Not verified' },
  not_configured: { kind: 'neutral', label: 'Not configured' },
} as const;

/** Each client's result mode (MCP_SPEC §3 Results): what its model is given. */
const RESULT_MODE = {
  text: { label: 'Text only', title: 'No structuredContent: the model reads the compact text' },
  structured: { label: 'Structured', title: 'structuredContent plus the compact text' },
} as const;

type Health = SettingsResponse['health'];

const NO_PROJECTS: SettingsResponse['projects'] = [];

/**
 * h2 "Connections" (UI_SPEC §6.7): client compatibility, client setup with
 * *Reveal token*, the endpoint, and service health with the backup
 * locations, *Download diagnostic log*, *Lock this browser* and *Rotate
 * owner key*.
 */
export function ConnectionsSection({ query }: { query: UseQueryResult<SettingsResponse> }) {
  return (
    <section aria-labelledby="settings-connections" className="settings-sec">
      <h2 id="settings-connections">Connections</h2>
      <div className="grid2">
        <div className="stack">
          <Card style={{ overflow: 'auto' }} data-card="clients">
            <CardHeader
              title="Client compatibility"
              extra={
                <span className="row" style={{ gap: 6 }}>
                  <span className="src">Smoke test: claim, plan, log, read back</span>
                  <HelpLink anchor="settings.clients" />
                </span>
              }
            />
            <QueryState
              query={query}
              skeleton={
                <div className="pad">
                  <Skeleton lines={3} label="Loading clients" />
                </div>
              }
            >
              {(d) => {
                // Surfaces that are off until set up (an agent in another container) are a
                // footnote under the table, not a row (B20).
                const rows = d.connections.clients.filter((c) => c.status !== 'not_configured');
                const notes = d.connections.clients.filter((c) => c.status === 'not_configured');
                return d.connections.clients.length === 0 ? (
                  <EmptyState text="No clients seen yet." />
                ) : (
                  <>
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Client</th>
                          <th scope="col">Transport</th>
                          <th scope="col">Last seen</th>
                          <th scope="col">Status</th>
                          <th scope="col">Results</th>
                          <th scope="col">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((c) => (
                          <tr key={c.client} data-client={c.client}>
                            <td>
                              <b>{c.client}</b>
                            </td>
                            <td className="src">{c.transport}</td>
                            <td
                              className="src"
                              title={c.last_seen_at ? isoTitle(c.last_seen_at) : undefined}
                            >
                              {c.last_seen_at ? formatAgo(c.last_seen_at) : 'never'}
                            </td>
                            <td>
                              <Chip kind={CLIENT_STATUS[c.status].kind}>
                                {CLIENT_STATUS[c.status].label}
                              </Chip>
                            </td>
                            <td className="src" title={RESULT_MODE[c.result_mode].title}>
                              {RESULT_MODE[c.result_mode].label}
                            </td>
                            <td className="src">{c.notes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {notes.map((c) => (
                      <p key={c.client} className="src footnote" data-client-note={c.client}>
                        <b>{c.client}</b> ({c.transport}): not configured.
                        {c.notes ? ` ${c.notes}` : ''}
                      </p>
                    ))}
                  </>
                );
              }}
            </QueryState>
          </Card>
          <ClientSetupCard protectedMode={query.data?.connections.protected_mode} />
          <UsageSourceCard projects={query.data?.projects ?? NO_PROJECTS} />
        </div>
        <div className="stack">
          <SecurityCard query={query} />
          <Card padded data-card="endpoint">
            <h3>Endpoint</h3>
            <QueryState
              query={query}
              skeleton={<Skeleton lines={3} label="Loading the endpoint" />}
            >
              {(d) => (
                <dl className="kv">
                  <dt>MCP</dt>
                  <dd className="mono">{d.connections.endpoint.mcp_url}</dd>
                  <dt>Web UI</dt>
                  <dd className="mono">{d.connections.endpoint.web_url}</dd>
                  <dt>Bind</dt>
                  <dd>Loopback only</dd>
                  <dt>Auth</dt>
                  <dd>
                    {d.connections.endpoint.auth === 'bearer'
                      ? 'Bearer token (protected mode)'
                      : 'None (local trust)'}
                  </dd>
                  <dt>Origins</dt>
                  <dd className="mono">{d.connections.endpoint.origins.join(', ')}</dd>
                </dl>
              )}
            </QueryState>
          </Card>
          <ServiceHealthCard query={query} />
        </div>
      </div>
      <GitHubCard protectedMode={query.data?.connections.protected_mode} />
    </section>
  );
}

/**
 * Security (UI_SPEC §6.7e; decision 32): which trust mode is on, and how to
 * change it. The mode is configuration only (`DOCKET_PROTECTED_MODE`, then a
 * restart): nothing here, or anywhere an agent can reach, changes it.
 */
function SecurityCard({ query }: { query: UseQueryResult<SettingsResponse> }) {
  return (
    <Card padded data-card="security">
      <div className="withhelp wh-h3">
        <h3>Security</h3>
        <HelpLink anchor="settings.security" />
      </div>
      <QueryState query={query} skeleton={<Skeleton lines={2} label="Loading the trust mode" />}>
        {(d) =>
          d.connections.protected_mode ? (
            <div data-trust="protected">
              <p style={{ marginTop: 0 }}>{SECURITY_TEXT.protected}</p>
              <p className="src" style={{ marginBottom: 0 }}>
                To go back to local trust, set{' '}
                <span className="mono">DOCKET_PROTECTED_MODE=off</span> in{' '}
                <span className="mono">docker/.env</span>, then restart Docket.
              </p>
            </div>
          ) : (
            <div data-trust="local">
              <p style={{ marginTop: 0 }}>{SECURITY_TEXT.local}</p>
              <p className="src" style={{ marginBottom: 0 }}>
                To turn it on, set <span className="mono">DOCKET_PROTECTED_MODE=on</span> in{' '}
                <span className="mono">docker/.env</span>, then restart Docket. In both modes,
                websites and other computers can’t reach Docket, and Activity shows owner actions
                made by a script.
              </p>
            </div>
          )
        }
      </QueryState>
    </Card>
  );
}

/**
 * Client setup: the Codex | Claude Code snippet with *Copy*, for a user-wide
 * connection; installing the agent files into a repo writes its connection
 * file instead (decision 32). In protected mode, *Reveal token* fetches the
 * token on click, shows it for 30 s and then hides it. The token is kept in
 * this component's state only, never in the query cache, and is dropped
 * when the card unmounts.
 */
function ClientSetupCard({ protectedMode }: { protectedMode: boolean | undefined }) {
  const [client, setClient] = useState<'codex' | 'claude'>('codex');
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setToken(null);
  };
  useEffect(() => hide, []);
  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token: value } = await apiClient['settings.agentToken']({});
      setToken(value);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hide, REVEAL_MS);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const snippets = protectedMode ? SNIPPETS : LOCAL_SNIPPETS;
  const copy = (text: string, done: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => showToast(done),
      () => showToast('Couldn’t copy. Select the text instead.'),
    );
  };
  return (
    <Card padded data-card="client-setup">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="withhelp">
          <h3 style={{ margin: 0 }}>Client setup</h3>
          <HelpLink anchor="settings.client-setup" />
        </div>
        <SegmentedControl
          label="Client"
          value={client}
          onChange={setClient}
          options={[
            { key: 'codex', label: 'Codex' },
            { key: 'claude', label: 'Claude Code' },
          ]}
        />
      </div>
      <p className="src" style={{ marginTop: 6 }} data-connection-note="">
        Each repo needs no setup: Agent files → <b>Install</b> writes its connection file (.mcp.json
        or .codex/config.toml). This is for a user-wide connection instead.
      </p>
      <pre className="code" tabIndex={0} aria-label="Client configuration" data-snippet={client}>
        {snippets[client]}
      </pre>
      <div className="row wrap" style={{ marginTop: 8 }}>
        <Button size="sm" icon="copy" onClick={() => copy(snippets[client], 'Copied.')}>
          Copy
        </Button>
        {protectedMode &&
          (token === null ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reveal()}>
              Reveal token
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={hide}>
              Hide token
            </Button>
          ))}
        {protectedMode && (
          <span className="src">
            Put it in <span className="mono">DOCKET_TOKEN</span> where your agents run.
          </span>
        )}
      </div>
      <p className="src" data-rename-note="">
        Set up before the rename? Rename your MCP server entry from tasklite to docket; the URL is
        unchanged, so the old entry keeps working until you do.
      </p>
      {token !== null && (
        <div className="reveal" data-token-revealed="">
          <code aria-label="Agent token">{token}</code>
          <Button size="sm" icon="copy" onClick={() => copy(token, 'Token copied.')}>
            Copy token
          </Button>
          <span className="src">Hides in 30 s.</span>
        </div>
      )}
      {error !== null && (
        <div style={{ marginTop: 8 }}>
          <ErrorState error={error} />
        </div>
      )}
    </Card>
  );
}

function bytes(n: number | null): string {
  if (n === null) return 'size unknown';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function ReadyChip({ state }: { state: string }) {
  return state === 'ok' ? (
    <Chip kind="ok">✓ ready</Chip>
  ) : (
    <Chip kind="bad">Not ready: {state}</Chip>
  );
}

/** One line per backup location (UI_SPEC §6.7; BUILD_SPEC §5.13). */
function BackupLines({ health }: { health: Health }) {
  const volume = health.backups.find((b) => b.location === 'volume');
  const extra = health.backups.find((b) => b.location === 'extra');
  const when = (at: string | null) => (at ? formatStamp(at) : 'no backup yet');
  return (
    <>
      {volume && (
        <div className="backup-loc" data-backup="volume">
          <span title={volume.last_success_at ? isoTitle(volume.last_success_at) : undefined}>
            In the data volume · {when(volume.last_success_at)} · kept {volume.keep_days} days
          </span>
          {volume.last_error && (
            <div className="src" style={{ color: 'var(--bad)' }}>
              Last backup failed: {volume.last_error}
            </div>
          )}
        </div>
      )}
      {extra ? (
        <div className="backup-loc" data-backup="extra">
          <span title={extra.last_success_at ? isoTitle(extra.last_success_at) : undefined}>
            Extra copy: <span className="mono">{extra.path}</span> · {when(extra.last_success_at)}
          </span>
          {extra.last_error && (
            <div>
              <Chip kind="bad">Extra backup copy failed</Chip>{' '}
              <span className="src">{extra.last_error}</span>
            </div>
          )}
        </div>
      ) : (
        !health.extra_backup_configured && (
          <div className="src backup-loc" data-backup="extra-help">
            Mount a host folder and set DOCKET_BACKUP_EXTRA_DIR; see the README.
          </div>
        )
      )}
    </>
  );
}

/** Service health, the backups, the diagnostic log, and (protected mode) *Lock this browser* and *Rotate owner key*. */
function ServiceHealthCard({ query }: { query: UseQueryResult<SettingsResponse> }) {
  const navigate = useNavigate();
  const [rotating, setRotating] = useState(false);
  const lock = async () => {
    try {
      await apiClient['session.lock']({});
      navigate(paths.unlock(), { replace: true });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t lock. Try again.');
    }
  };
  const rotate = async () => {
    try {
      await apiClient['session.rotateKey']({});
      navigate(paths.unlock(), { replace: true });
    } catch (err) {
      setRotating(false);
      showToast(err instanceof Error ? err.message : 'Couldn’t rotate the key. Try again.');
    }
  };
  return (
    <Card padded data-card="service-health">
      <div className="withhelp wh-h3">
        <h3>Service health</h3>
        <HelpLink anchor="settings.service-health" />
      </div>
      <QueryState query={query} skeleton={<Skeleton lines={4} label="Loading service health" />}>
        {(d) => (
          <dl className="kv">
            <dt>Database</dt>
            <dd>
              <ReadyChip state={d.health.database.state} /> SQLite ·{' '}
              {bytes(d.health.database.bytes)}
            </dd>
            <dt>Documents</dt>
            <dd>
              <ReadyChip state={d.health.documents.state} /> {bytes(d.health.documents.bytes)}
            </dd>
            <dt>Volume</dt>
            <dd>
              {d.health.volume.name ? (
                <>
                  <span className="mono" data-volume>
                    {d.health.volume.name}
                  </span>{' '}
                  mounted at <span className="mono">/data</span>
                </>
              ) : (
                <>
                  The volume at <span className="mono">/data</span>
                </>
              )}
              {d.health.volume_free_bytes !== null && (
                <span className="src"> · {bytes(d.health.volume_free_bytes)} free</span>
              )}
              {d.health.volume.name === LEGACY_VOLUME && (
                <div className="src">
                  The volume from before the rename to Docket. It keeps working; the README says how
                  to move it to docket-data.
                </div>
              )}
              {d.health.volume.legacy_db_file && (
                <div className="src">
                  Its database file keeps its name from before the rename (docket.db).
                </div>
              )}
            </dd>
            <dt>Backups</dt>
            <dd>
              <BackupLines health={d.health} />
            </dd>
            <dt>Restarted</dt>
            <dd>
              <span title={isoTitle(d.health.restarted_at)}>
                {formatStamp(d.health.restarted_at)}
              </span>
              <div className="src">
                {plural(d.health.runs_kept_at_restart, 'open run')}{' '}
                {d.health.runs_kept_at_restart === 1 ? 'was' : 'were'} kept. Agents continue with
                the same run; one that doesn’t return ends when its lease runs out.
              </div>
            </dd>
          </dl>
        )}
      </QueryState>
      <div className="row wrap" style={{ marginTop: 10 }}>
        <a
          className="btn sm"
          href="/api/diagnostics/calls?days=7"
          download="docket-calls-7d.jsonl"
          title="The last 7 days of agent calls, without their contents"
        >
          Download diagnostic log
        </a>
        {/* Protected mode only (decision 32): local trust has no owner session or key to use. */}
        {query.data?.connections.protected_mode && (
          <>
            <Button size="sm" icon="lock" onClick={() => void lock()}>
              Lock this browser
            </Button>
            <Button size="sm" variant="danger-text" onClick={() => setRotating(true)}>
              Rotate owner key…
            </Button>
          </>
        )}
      </div>
      {rotating && (
        <Dialog
          title="Rotate the owner key?"
          destructive
          onClose={() => setRotating(false)}
          footer={
            <>
              <DialogCancel onClick={() => setRotating(false)} />
              <Button variant="danger" onClick={() => void rotate()}>
                Rotate key
              </Button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            This writes a new owner key and locks every browser, this one included.
          </p>
          <div className="src">
            Get the new key with:{' '}
            <span className="mono">docker compose exec docket docket owner-key</span>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
