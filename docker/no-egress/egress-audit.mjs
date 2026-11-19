/**
 * Egress audit (FR-106; tasks.md T145): records every attempt this Node
 * process makes to reach another host, so CI can assert there were none.
 *
 * Loaded with `node --import=<this file>` (NODE_OPTIONS) when
 * DOCKET_EGRESS_LOG names a file. It watches:
 * - TCP and TLS connects (`net.Socket.prototype.connect`, which `fetch`,
 *   `http`, `https` and `tls` all go through);
 * - UDP sends and connects (`dgram`);
 * - DNS lookups and queries (`dns.lookup`, `dns.resolve*`, and the promise
 *   forms).
 *
 * Loopback (localhost, 127.0.0.0/8, ::1) and Unix sockets are local and never
 * recorded. DOCKET_EGRESS_ALLOW is a comma-separated list of host names
 * that may be reached (CI allows only `jira-fixture.test` and `api.atlassian.com`,
 * the fixture under both names). Everything else
 * is appended to the log as one JSON line and echoed to stderr as
 * "EGRESS ATTEMPT …". The attempt itself still runs, so behaviour is
 * unchanged; on an internal network it simply fails.
 *
 * No dependencies; plain ESM so the container (compiled JS) and Vitest can
 * both load it. Only used by docker/compose.no-egress.yaml and the tests.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
import net from 'node:net';

/** Is `host` this machine? */
export function isLocal(host) {
  if (host === undefined || host === null || host === '') return true;
  const h = String(host)
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^::ffff:127\.\d+\.\d+\.\d+$/.test(h)) return true;
  return false;
}

/** The host and port a `Socket#connect(...)` call targets, or null for a Unix socket. */
export function connectTarget(args) {
  let first = args[0];
  // net.connect() passes its normalised [options, callback] array.
  if (Array.isArray(first)) first = first[0];
  if (first === null || first === undefined) return null;
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null; // a path
  if (typeof first === 'object') {
    if (first.path) return null;
    return { host: first.host ?? 'localhost', port: Number(first.port) };
  }
  const host = typeof args[1] === 'string' ? args[1] : 'localhost';
  return { host, port: Number(first) };
}

/**
 * Patch the networking entry points. `record(attempt)` is called for each
 * attempt to reach a host that is neither local nor in `allow`. Returns a
 * function that removes the patches.
 */
export function installEgressAudit({ allow = [], record }) {
  const allowed = new Set(allow.map((h) => h.trim().toLowerCase()).filter(Boolean));
  const ok = (host) => isLocal(host) || allowed.has(String(host).toLowerCase());
  const note = (kind, host, port) => {
    if (ok(host)) return;
    record({ at: new Date().toISOString(), pid: process.pid, kind, host: String(host), port });
  };
  const restore = [];
  const patch = (obj, key, wrap) => {
    const orig = obj[key];
    if (typeof orig !== 'function') return;
    obj[key] = wrap(orig);
    restore.push(() => {
      obj[key] = orig;
    });
  };

  patch(
    net.Socket.prototype,
    'connect',
    (orig) =>
      function connect(...args) {
        const t = connectTarget(args);
        if (t) note('tcp', t.host, t.port);
        return orig.apply(this, args);
      },
  );
  patch(
    dgram.Socket.prototype,
    'send',
    (orig) =>
      function send(...args) {
        // send(msg[, offset, length], port[, address][, callback])
        const nums = args.filter((a) => typeof a === 'number');
        const host = args.find((a, i) => i > 0 && typeof a === 'string');
        if (nums.length > 0) note('udp', host ?? 'localhost', nums[nums.length - 1]);
        return orig.apply(this, args);
      },
  );
  patch(
    dgram.Socket.prototype,
    'connect',
    (orig) =>
      function connect(port, address, ...rest) {
        note('udp', typeof address === 'string' ? address : 'localhost', port);
        return orig.call(this, port, address, ...rest);
      },
  );
  const dnsNames = [
    'lookup',
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCname',
    'resolveMx',
    'resolveNs',
    'resolveSrv',
    'resolveTxt',
  ];
  for (const name of dnsNames) {
    patch(
      dns,
      name,
      (orig) =>
        function dnsCall(hostname, ...rest) {
          if (typeof hostname === 'string' && net.isIP(hostname) === 0) note('dns', hostname);
          return orig.call(this, hostname, ...rest);
        },
    );
    patch(
      dns.promises,
      name,
      (orig) =>
        function dnsCall(hostname, ...rest) {
          if (typeof hostname === 'string' && net.isIP(hostname) === 0) note('dns', hostname);
          return orig.call(this, hostname, ...rest);
        },
    );
  }
  return () => {
    for (const undo of restore.reverse()) undo();
  };
}

// Loaded with --import: audit this process.
const log = process.env.DOCKET_EGRESS_LOG;
if (log) {
  installEgressAudit({
    allow: (process.env.DOCKET_EGRESS_ALLOW ?? '').split(','),
    record: (attempt) => {
      const line = JSON.stringify(attempt);
      try {
        appendFileSync(log, `${line}\n`);
      } catch {
        // The log is unwritable: stderr still has it.
      }
      process.stderr.write(`EGRESS ATTEMPT ${line}\n`);
    },
  });
}
