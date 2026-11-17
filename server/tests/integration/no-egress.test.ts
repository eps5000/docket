/**
 * FR-106 guard (tasks.md T145): the service never reaches another host.
 *
 * CI runs the container on an internal network with no route out
 * (docker/compose.no-egress.yaml), runs the e2e suite through it and the
 * contract suite with `--network none`, and checks the egress audit stayed
 * empty (docker/no-egress/check.sh). This file tests that audit:
 * - a deliberate outbound attempt (a TCP connect to a public address, a
 *   fetch to a public name, a UDP send) is caught: the probe that proves the
 *   guard can fail;
 * - loopback, Unix sockets and the allowlisted Jira fixture are not;
 * - a full agent and owner session against the in-process server, a Jira
 *   dry run against a loopback fixture included, makes no outbound attempt.
 */
import dgram from 'node:dgram';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectTarget,
  installEgressAudit,
  isLocal,
  type EgressAttempt,
} from '../../../docker/no-egress/egress-audit.mjs';
import { startHarness, type ContractHarness } from '../contract/harness.js';
import { ORIGIN, parseSetCookies } from './harness.js';

let uninstall: (() => void) | undefined;
let h: ContractHarness | undefined;
const servers: Server[] = [];
afterEach(async () => {
  uninstall?.();
  uninstall = undefined;
  await h?.close();
  h = undefined;
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

function audit(allow: string[] = []): EgressAttempt[] {
  const seen: EgressAttempt[] = [];
  uninstall = installEgressAudit({ allow, record: (a) => seen.push(a) });
  return seen;
}

/** Wait for a socket to connect or fail; never leave it open. */
function settle(s: net.Socket): Promise<string> {
  return new Promise((done) => {
    s.setTimeout(500, () => {
      s.destroy();
      done('timeout');
    });
    s.on('connect', () => {
      s.destroy();
      done('connected');
    });
    s.on('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'error'));
  });
}

describe('the egress audit (T145)', () => {
  it('knows what is local', () => {
    for (const h of ['localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1'])
      expect(isLocal(h), h).toBe(true);
    for (const h of ['1.1.1.1', 'example.com', 'jira-fixture.test', '10.0.0.5', '::ffff:8.8.8.8'])
      expect(isLocal(h), h).toBe(false);
  });

  it('reads every form of Socket#connect', () => {
    expect(connectTarget([443, 'example.com'])).toEqual({ host: 'example.com', port: 443 });
    expect(connectTarget([{ host: '1.1.1.1', port: 53 }])).toEqual({ host: '1.1.1.1', port: 53 });
    expect(connectTarget([[{ host: 'a.test', port: '80' }, () => {}]])).toEqual({
      host: 'a.test',
      port: 80,
    });
    expect(connectTarget([{ port: 7420 }])).toEqual({ host: 'localhost', port: 7420 });
    expect(connectTarget(['/tmp/sock'])).toBeNull();
    expect(connectTarget([{ path: '/tmp/sock' }])).toBeNull();
  });

  it('catches a deliberate outbound attempt: TCP, fetch (DNS + TCP) and UDP', async () => {
    const seen = audit();
    // TEST-NET-3: documentation addresses, never routed anywhere.
    await settle(net.connect({ host: '203.0.113.7', port: 9 }));
    await fetch('http://egress-probe.invalid/', { signal: AbortSignal.timeout(2000) }).catch(
      () => {},
    );
    const udp = dgram.createSocket('udp4');
    await new Promise<void>((done) => udp.send('x', 9, '203.0.113.8', () => done()));
    udp.close();

    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tcp', host: '203.0.113.7', port: 9 }),
        expect.objectContaining({ kind: 'dns', host: 'egress-probe.invalid' }),
        expect.objectContaining({ kind: 'udp', host: '203.0.113.8', port: 9 }),
      ]),
    );
    // What CI asserts: a run with any of these fails the build.
    expect(() => expect(seen).toEqual([])).toThrow();
  });

  it('ignores loopback, Unix sockets and the allowlisted Jira fixture', async () => {
    const seen = audit(['jira-fixture.test']);
    const server = createServer((_req, res) => res.end('ok'));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
    await settle(net.connect({ host: 'localhost', port })); // ::1 or 127.0.0.1, either is local
    await settle(net.connect({ host: 'jira-fixture.test', port: 8443 }));
    expect(seen).toEqual([]);
  });

  it('a whole agent and owner session against the server reaches no other host', async () => {
    const seen = audit();
    h = await startHarness({ log: () => {} });
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await h!.call(name, args);
      expect(res.isError, `${name}: ${JSON.stringify(res.content)}`).toBeFalsy();
      return res.structuredContent as Record<string, unknown>;
    };
    await call('whoami', {});
    await call('search_items', { project: 'RCP', filter: 'ready_to_start' });
    const { run_id } = (await call('claim_lead', { id: 'RCP-17', agent_label: 'egress' })) as {
      run_id: string;
    };
    await call('get_context', { id: 'RCP-17', run_id });
    await call('set_plan', { id: 'RCP-17', run_id, steps: [{ text: 'One' }, { text: 'Two' }] });
    await call('get_changes', { limit: 20 });
    await call('recovery_report', {});

    const app = h.server.app;
    const unlock = await app.request(`${ORIGIN}/api/session/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ key: h.server.runtime.secrets.ownerKey() }),
    });
    const cookie = Object.entries(parseSetCookies(unlock))
      .map(([k, v]) => `${k}=${v.value}`)
      .join('; ');
    for (const path of [
      '/api/bootstrap',
      '/api/needs-you?scope=all',
      '/api/work?scope=all',
      '/api/work?scope=all&layout=timeline',
      '/api/items/RCP-14',
      '/api/agents',
      '/api/settings',
    ]) {
      const res = await app.request(`${ORIGIN}${path}`, { headers: { cookie } });
      expect(res.status, path).toBe(200);
    }
    expect(seen).toEqual([]);
  });
});
