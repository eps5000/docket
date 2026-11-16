import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { SettingsResponse } from '@tasklite/shared';
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

/**
 * The client setup snippets, exactly as MCP_SPEC §11 gives them: the token
 * is always `$TASKLITE_TOKEN`, never its value.
 */
export const SNIPPETS = {
  codex: `# ~/.codex/config.toml\n[mcp_servers.tasklite]\nurl = "http://127.0.0.1:7420/mcp"\nbearer_token_env_var = "TASKLITE_TOKEN"`,
  claude: `claude mcp add --transport http --scope user tasklite \\\n  http://127.0.0.1:7420/mcp \\\n  --header "Authorization: Bearer $TASKLITE_TOKEN"`,
} as const;

/** *Reveal token* shows the token for this long, then hides it (UI_SPEC §6.7). */
export const REVEAL_MS = 30_000;

const CLIENT_STATUS = {
  verified: { kind: 'ok', label: '✓ Verified' },
  not_verified: { kind: 'warn', label: 'Not verified' },
  not_configured: { kind: 'neutral', label: 'Not configured' },
} as const;

type Health = SettingsResponse['health'];

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
              extra={<span className="src">Smoke test: claim, plan, log, read back</span>}
            />
            <QueryState
              query={query}
              skeleton={
                <div className="pad">
                  <Skeleton lines={3} label="Loading clients" />
                </div>
              }
            >
              {(d) =>
                d.connections.clients.length === 0 ? (
                  <EmptyState text="No clients seen yet." />
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Client</th>
                        <th scope="col">Transport</th>
                        <th scope="col">Last seen</th>
                        <th scope="col">Status</th>
                        <th scope="col">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.connections.clients.map((c) => (
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
                          <td className="src">{c.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </QueryState>
          </Card>
          <ClientSetupCard />
        </div>
        <div className="stack">
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
                  <dd>Bearer token</dd>
                  <dt>Origins</dt>
                  <dd className="mono">{d.connections.endpoint.origins.join(', ')}</dd>
                </dl>
              )}
            </QueryState>
          </Card>
          <ServiceHealthCard query={query} />
        </div>
      </div>
    </section>
  );
}

/**
 * Client setup: the Codex | Claude Code snippet with *Copy*, and *Reveal
 * token*, which fetches the token on click, shows it for 30 s and then
 * hides it. The token is kept in this component's state only, never in the
 * query cache, and is dropped when the card unmounts.
 */
function ClientSetupCard() {
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
  const copy = (text: string, done: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => showToast(done),
      () => showToast('Couldn’t copy. Select the text instead.'),
    );
  };
  return (
    <Card padded data-card="client-setup">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Client setup</h3>
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
      <pre className="code" tabIndex={0} aria-label="Client configuration" data-snippet={client}>
        {SNIPPETS[client]}
      </pre>
      <div className="row wrap" style={{ marginTop: 8 }}>
        <Button size="sm" icon="copy" onClick={() => copy(SNIPPETS[client], 'Copied.')}>
          Copy
        </Button>
        {token === null ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reveal()}>
            Reveal token
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={hide}>
            Hide token
          </Button>
        )}
        <span className="src">
          Put it in <span className="mono">TASKLITE_TOKEN</span> where your agents run.
        </span>
      </div>
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
            Mount a host folder and set TASKLITE_BACKUP_EXTRA_DIR; see the README.
          </div>
        )
      )}
    </>
  );
}

/** Service health, the backups, the diagnostic log, *Lock this browser* and *Rotate owner key*. */
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
      <h3>Service health</h3>
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
              <span className="mono">tasklite-data</span>
              {d.health.volume_free_bytes !== null && (
                <span className="src"> · {bytes(d.health.volume_free_bytes)} free</span>
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
                {plural(d.health.interrupted_at_restart, 'run')}{' '}
                {d.health.interrupted_at_restart === 1 ? 'was' : 'were'} active. Any active run
                would show as interrupted, not finished.
              </div>
            </dd>
          </dl>
        )}
      </QueryState>
      <div className="row wrap" style={{ marginTop: 10 }}>
        <a
          className="btn sm"
          href="/api/diagnostics/calls?days=7"
          download="tasklite-calls-7d.jsonl"
          title="The last 7 days of agent calls, without their contents"
        >
          Download diagnostic log
        </a>
        <Button size="sm" icon="lock" onClick={() => void lock()}>
          Lock this browser
        </Button>
        <Button size="sm" variant="danger-text" onClick={() => setRotating(true)}>
          Rotate owner key…
        </Button>
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
            <span className="mono">docker compose exec tasklite tasklite owner-key</span>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
