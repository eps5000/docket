// @ts-check
/**
 * The Jira fixture as an HTTPS server, for the end-to-end tests (tasks.md
 * T141; web/e2e/us9-jira.spec.ts). It serves the same synthetic site as the
 * unit tests (site.mjs), on the compose network only: see
 * docker/compose.jira-fixture.yaml. It is the one place the container may
 * reach out to (FR-106; the no-egress check in T145 allows only it).
 *
 * It also stands in for Atlassian's gateway (B32): on JIRA_FIXTURE_GATEWAY_PORT
 * (443) it answers as https://api.atlassian.com, the name the compose file
 * gives it on the test network (with a certificate from the test CA), so a
 * scoped token's sign-in and reads go "through the gateway" without leaving
 * the network. Set JIRA_FIXTURE_GATEWAY_PORT=0 to leave it off.
 *
 * Environment: JIRA_FIXTURE_CERT and JIRA_FIXTURE_KEY (PEM files, from
 * docker/jira-fixture/make-certs.sh), JIRA_FIXTURE_PORT (8443),
 * JIRA_FIXTURE_ORIGIN (https://jira-fixture.test:8443), JIRA_FIXTURE_TOKEN,
 * JIRA_FIXTURE_GATEWAY_PORT (443).
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { GATEWAY_ORIGIN, createJiraSite } from './site.mjs';

const port = Number(process.env.JIRA_FIXTURE_PORT ?? 8443);
const site = createJiraSite({
  origin: process.env.JIRA_FIXTURE_ORIGIN ?? `https://jira-fixture.test:${port}`,
  token: process.env.JIRA_FIXTURE_TOKEN || undefined,
});

const tls = {
  cert: readFileSync(process.env.JIRA_FIXTURE_CERT ?? '/certs/server.pem'),
  key: readFileSync(process.env.JIRA_FIXTURE_KEY ?? '/certs/server.key'),
};

/** @param {string} origin The origin requests on this listener are for. */
const listener = (origin) =>
  /** @type {import('node:http').RequestListener} */ (
    async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        /** @type {Record<string, string>} */
        const headers = {};
        for (const name of ['authorization', 'content-type', 'accept']) {
          const value = req.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        const method = req.method ?? 'GET';
        const request = new Request(new URL(req.url ?? '/', origin), {
          method,
          headers,
          body:
            method === 'GET' || method === 'HEAD' || chunks.length === 0
              ? undefined
              : Buffer.concat(chunks),
        });
        const response = await site.handle(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"errorMessages":["fixture error"]}');
      }
    }
  );

createServer(tls, listener(site.origin)).listen(port, '0.0.0.0', () => {
  // Never logs a request's headers.
  console.log(`Jira fixture listening on ${site.origin}`);
});

const gatewayPort = Number(process.env.JIRA_FIXTURE_GATEWAY_PORT ?? 443);
if (gatewayPort > 0) {
  createServer(tls, listener(GATEWAY_ORIGIN)).listen(gatewayPort, '0.0.0.0', () => {
    console.log(`Jira fixture gateway listening as ${GATEWAY_ORIGIN} on port ${gatewayPort}`);
  });
}
