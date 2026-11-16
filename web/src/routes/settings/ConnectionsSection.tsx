import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
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
  SegmentedControl,
  Skeleton,
} from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { paths } from '../../lib/paths';
import { showToast } from '../../lib/undo';

const SNIPPETS = {
  codex: `# ~/.codex/config.toml\n[mcp_servers.tasklite]\nurl = "http://127.0.0.1:7420/mcp"\nbearer_token_env_var = "TASKLITE_TOKEN"`,
  claude: `claude mcp add --transport http --scope user tasklite \\\n  http://127.0.0.1:7420/mcp \\\n  --header "Authorization: Bearer $TASKLITE_TOKEN"`,
} as const;

const CLIENT_STATUS = {
  verified: { kind: 'ok', label: '✓ Verified' },
  not_verified: { kind: 'warn', label: 'Not verified' },
  not_configured: { kind: 'neutral', label: 'Not configured' },
} as const;

/**
 * h2 "Connections" (UI_SPEC §6.7): client compatibility, client setup,
 * endpoint, and service health with *Lock this browser* / *Rotate owner
 * key* (the real B2 session routes). US10 fills the data cards.
 */
export function ConnectionsSection({ query }: { query: UseQueryResult<SettingsResponse> }) {
  const [client, setClient] = useState<'codex' | 'claude'>('codex');
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
                        <tr key={c.client}>
                          <td>
                            <b>{c.client}</b>
                          </td>
                          <td className="src">{c.transport}</td>
                          <td className="src">{c.last_seen_at ?? 'never'}</td>
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
            <pre className="code" tabIndex={0} aria-label="Client configuration">
              {SNIPPETS[client]}
            </pre>
            <div className="row" style={{ marginTop: 8 }}>
              <Button
                size="sm"
                icon="copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(SNIPPETS[client]).then(
                    () => showToast('Copied.'),
                    () => showToast('Couldn’t copy. Select the text instead.'),
                  );
                }}
              >
                Copy
              </Button>
              <Button size="sm" variant="ghost" disabled title="Lands with US10">
                Reveal token
              </Button>
            </div>
          </Card>
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

/** Service health, plus *Lock this browser* and *Rotate owner key* (both work today). */
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
            <dd>{d.health.database.state}</dd>
            <dt>Documents</dt>
            <dd>{d.health.documents.state}</dd>
            <dt>Backups</dt>
            <dd>{d.health.backups.length} locations</dd>
          </dl>
        )}
      </QueryState>
      <div className="row wrap" style={{ marginTop: 10 }}>
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
