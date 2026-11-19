// @ts-check
/**
 * A synthetic Jira Cloud site: the subset of REST v3 the importer reads
 * (tasks.md T138, T139, and the e2e fixture server in server.mjs).
 *
 * Everything here is invented: no real site, person, email or token. The
 * "recorded" responses are hand-written (fields.json, tl-issues.json,
 * tl-comments.json) or generated with a seeded PRNG (`generateProject`), so
 * every run sees the same data.
 *
 * Projects:
 * - `TL`: hand-written edge cases (every type, status category, priority and
 *   link type, ADF that loses information, sub-tasks, missing fields,
 *   secret-like text, a cycle, attachments that fail or are too large);
 * - `BIG`: 500 generated issues (SC-011), five pages, and one `429` with
 *   `Retry-After: 1` on the third page;
 * - `RATE`: 30 generated issues whose first search answers `429` with
 *   `Retry-After: 2`, then `503` without one;
 * - `SLOW`: 120 generated issues in pages of 20, each page delayed (the e2e
 *   uses it to see the progress line and Cancel).
 *
 * Signing in (B32): `/_edge/tenant_info` answers the cloudId without
 * credentials (or 404 with `tenantInfo: false`). The site itself takes only
 * the classic token; `https://api.atlassian.com/ex/jira/<cloudId>/…` (the
 * gateway) takes only the scoped token, and the "no read scopes" token
 * there gets `myself` and then "Unauthorized; scope does not match". An
 * organization-key-shaped value is refused everywhere, and project `LOCKED`
 * answers 403 to every account.
 *
 * `site.fetch` is a drop-in `fetch` for tests: any origin but the site and
 * the gateway throws, as a machine with no network would. `site.handle`
 * takes a `Request`.
 */
import { readFileSync } from 'node:fs';

/** @param {string} name */
const read = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));

export const FIXTURE_ORIGIN = 'https://jira-fixture.test:8443';
export const FIXTURE_EMAIL = 'owner@example.test';
export const FIXTURE_TOKEN = 'tl-fixture-api-token-0001';
/** The gateway scoped tokens go through (B32). In the e2e it's this fixture under that name. */
export const GATEWAY_ORIGIN = 'https://api.atlassian.com';
export const FIXTURE_CLOUD_ID = '0f1e2d3c-fixture-cloud-0000-000000000001';
/** A scoped personal token: refused by the site, accepted by the gateway. */
export const FIXTURE_SCOPED_TOKEN = 'tl-fixture-scoped-token-0001';
/** A scoped token without the read scopes: `myself` works, everything else is "scope does not match". */
export const FIXTURE_LIMITED_TOKEN = 'tl-fixture-scoped-noread-0001';
/** Shaped like an organization API key (the ATCTT prefix); invented, refused everywhere. */
export const FIXTURE_ORG_KEY = 'ATCTT3xFfGN0-fixture-org-key-not-real-0001';
/** A project every account is refused (403). */
export const LOCKED_PROJECT = 'LOCKED';

/** @type {import('./site.d.mts').JiraFieldFixture[]} */
export const FIELDS = read('fields.json');

const PEOPLE = [
  { accountId: 'fixture-acct-0001', displayName: 'Riley Example' },
  { accountId: 'fixture-acct-0002', displayName: 'Sam Placeholder' },
  { accountId: 'fixture-acct-0003', displayName: 'Jo Sample' },
  { accountId: 'fixture-acct-0004', displayName: 'Alex Fixture' },
];

const TYPES = {
  epic: { id: '10000', name: 'Epic', subtask: false, hierarchyLevel: 1 },
  story: { id: '10001', name: 'Story', subtask: false, hierarchyLevel: 0 },
  task: { id: '10002', name: 'Task', subtask: false, hierarchyLevel: 0 },
  bug: { id: '10003', name: 'Bug', subtask: false, hierarchyLevel: 0 },
  subtask: { id: '10004', name: 'Subtask', subtask: true, hierarchyLevel: -1 },
};

const STATUSES = [
  { name: 'To Do', statusCategory: { id: 2, key: 'new', name: 'To Do' } },
  { name: 'In Progress', statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' } },
  { name: 'Done', statusCategory: { id: 3, key: 'done', name: 'Done' } },
  { name: 'In Review', statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' } },
  { name: 'Backlog', statusCategory: { id: 2, key: 'new', name: 'To Do' } },
];

const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
const LINK_TYPES = {
  blocks: { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  duplicate: { id: '2', name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
  relates: { id: '3', name: 'Relates', inward: 'relates to', outward: 'relates to' },
};
const WORDS = [
  'cart',
  'invoice',
  'search',
  'profile',
  'export',
  'pricing',
  'report',
  'login',
  'webhook',
  'queue',
  'cache',
  'theme',
];

/** @param {number} seed */
function mulberry32(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {string} text */
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/**
 * A project of `count` generated issues: about one in 25 an epic, about one
 * in six a sub-task, blocks links that always point forward (no cycles),
 * some relates and duplicate links, links to another project, comments,
 * attachments (one over 500 MB), labels, estimates and dates.
 *
 * @param {string} key
 * @param {number} count
 * @param {number} [seed]
 * @returns {import('./site.d.mts').FixtureProject}
 */
export function generateProject(key, count, seed = 17) {
  const rnd = mulberry32(seed);
  /** @type {<T>(list: readonly T[]) => T} */
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  /** @type {any[]} */
  const issues = [];
  /** @type {Record<string, any[]>} */
  const comments = {};
  /** @type {Record<string, { size: number; fail?: boolean }>} */
  const attachments = {};
  /** @type {string[]} */
  const epics = [];
  /** @type {string[]} */
  const parents = [];
  /** @type {{ id: string; type: any; from: string; to: string }[]} */
  const links = [];
  let linkSeq = 1;
  let attachmentSeq = 1;
  let commentSeq = 1;
  const base = Date.parse('2026-01-05T09:00:00Z');
  const at = (/** @type {number} */ hours) =>
    new Date(base + hours * 3_600_000).toISOString().replace('Z', '+0000');

  for (let n = 1; n <= count; n++) {
    const issueKey = `${key}-${n}`;
    const kind =
      n % 25 === 1
        ? 'epic'
        : n === 77
          ? 'story'
          : parents.length > 5 && rnd() < 0.17
            ? 'subtask'
            : pick(['story', 'story', 'task', 'bug']);
    const status = pick(STATUSES);
    const word = pick(WORDS);
    /** @type {Record<string, any>} */
    const fields = {
      summary: `${kind === 'epic' ? 'Epic' : 'Work'} ${n}: ${word} ${pick(WORDS)}`,
      issuetype: TYPES[/** @type {keyof typeof TYPES} */ (kind)],
      status,
      priority: { id: String(n % 5), name: pick(PRIORITIES) },
      labels: rnd() < 0.3 ? [pick(['api', 'web', 'ops', 'perf', 'UX'])] : [],
      description: {
        type: 'doc',
        version: 1,
        content: [
          para(`Generated issue ${issueKey} about the ${word}.`),
          ...(rnd() < 0.1
            ? [{ type: 'panel', attrs: { panelType: 'note' }, content: [para('A panel note.')] }]
            : []),
          ...(rnd() < 0.05
            ? [
                {
                  type: 'mediaSingle',
                  content: [{ type: 'media', attrs: { id: `m-${n}`, type: 'file' } }],
                },
              ]
            : []),
        ],
      },
      issuelinks: [],
      attachment: [],
      duedate:
        rnd() < 0.4 ? `2026-12-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}` : null,
      created: at(n),
      updated: at(n + 2),
      resolutiondate: status.statusCategory.key === 'done' ? at(n + 30) : null,
      assignee: rnd() < 0.5 ? pick(PEOPLE) : null,
      reporter: pick(PEOPLE),
    };
    if (fields.duedate && rnd() < 0.4) fields.customfield_10015 = '2026-11-02';
    if (kind !== 'epic' && kind !== 'subtask' && rnd() < 0.6) {
      fields.customfield_10016 = pick([1, 2, 3, 5, 8]);
    }
    if (rnd() < 0.3) fields.customfield_10020 = [{ id: 1, name: 'Sprint 1', state: 'closed' }];
    if (kind === 'subtask') {
      const parent = pick(parents);
      fields.parent = { key: parent };
    } else if (kind !== 'epic' && epics.length > 0 && rnd() < 0.7) {
      fields.parent = { key: pick(epics) };
    }
    const issueComments = [];
    const nComments = Math.floor(rnd() * 4);
    for (let c = 0; c < nComments; c++) {
      issueComments.push({
        id: String(50_000 + commentSeq++),
        author: pick(PEOPLE),
        created: at(n + 3 + c),
        body: { type: 'doc', version: 1, content: [para(`Comment ${c + 1} on ${issueKey}.`)] },
      });
    }
    if (issueComments.length > 0) comments[issueKey] = issueComments;
    if (rnd() < 0.15 || n === 77) {
      const id = String(60_000 + attachmentSeq++);
      const huge = n === 77;
      const size = huge ? 600 * 1024 * 1024 : 200 + Math.floor(rnd() * 3800);
      attachments[id] = { size };
      fields.attachment.push({
        id,
        filename: huge ? 'screen-recording.mov' : `${word}-${n}.txt`,
        size,
        mimeType: huge ? 'video/quicktime' : 'text/plain',
        created: at(n + 1),
      });
    }
    if (kind === 'epic') epics.push(issueKey);
    else if (kind !== 'subtask') {
      if (parents.length > 0 && rnd() < 0.25) {
        links.push({
          id: `${key}L${linkSeq++}`,
          type: LINK_TYPES.blocks,
          from: pick(parents),
          to: issueKey,
        });
      }
      if (parents.length > 0 && rnd() < 0.1) {
        links.push({
          id: `${key}L${linkSeq++}`,
          type: LINK_TYPES.relates,
          from: issueKey,
          to: pick(parents),
        });
      }
      if (parents.length > 0 && rnd() < 0.02) {
        links.push({
          id: `${key}L${linkSeq++}`,
          type: LINK_TYPES.duplicate,
          from: issueKey,
          to: pick(parents),
        });
      }
      if (rnd() < 0.01) {
        links.push({
          id: `${key}L${linkSeq++}`,
          type: LINK_TYPES.blocks,
          from: `OPS-${n}`,
          to: issueKey,
        });
      }
      parents.push(issueKey);
    }
    issues.push({ id: String(100_000 + n), key: issueKey, fields });
  }

  const byKey = new Map(issues.map((i) => [i.key, i]));
  for (const link of links) {
    byKey
      .get(link.from)
      ?.fields.issuelinks.push({ id: link.id, type: link.type, outwardIssue: { key: link.to } });
    byKey
      .get(link.to)
      ?.fields.issuelinks.push({ id: link.id, type: link.type, inwardIssue: { key: link.from } });
  }
  return { key, name: `Generated ${key}`, issues, comments, attachments, pageSize: 100 };
}

/** TL-22's description: an ADF document longer than 20,000 characters as Markdown. */
function longDescription() {
  const content = [];
  for (let i = 1; i <= 120; i++) {
    content.push(para(`Paragraph ${i}: ${'lorem ipsum dolor sit amet '.repeat(8)}`));
  }
  return { type: 'doc', version: 1, content };
}

/**
 * TL-8's description (decision 33; SC-020): a sub-task with a long
 * description (about 6,000 characters as Markdown: a heading, a list, code
 * and a panel, which the conversion simplifies), fitting the 10,000
 * character step details with its header line.
 */
function subtaskDescription() {
  const content = [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'What to show' }] },
    para('Inline errors appear under each field as soon as it loses focus.'),
    {
      type: 'bulletList',
      content: ['Card number', 'Expiry', 'Security code'].map((text) => ({
        type: 'listItem',
        content: [para(`${text}: say what is wrong and how to fix it.`)],
      })),
    },
    {
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ type: 'text', text: "showError(field, 'Check the expiry date');" }],
    },
    {
      type: 'panel',
      attrs: { panelType: 'info' },
      content: [para('Errors are announced to screen readers.')],
    },
  ];
  for (let i = 1; i <= 40; i++) {
    content.push(para(`Detail ${i}: ${'keep the message short and specific '.repeat(4)}`));
  }
  return { type: 'doc', version: 1, content };
}

/** TL-8's comments (decision 33; SC-020): four, two of them long, so the parent's note splits. */
function subtaskComments() {
  const people = [PEOPLE[2], PEOPLE[0], PEOPLE[3], PEOPLE[2]];
  const bodies = [
    'Started on the card number field.',
    `Review notes: ${'the expiry message should name the format MM/YY. '.repeat(45)}`,
    `Design pass: ${'error text uses the warning colour and an icon, never colour alone. '.repeat(40)}`,
    'Done apart from the security code copy.',
  ];
  return bodies.map((text, i) => ({
    id: String(40020 + i),
    author: people[i],
    created: `2026-03-${String(7 + i).padStart(2, '0')}T10:00:00.000+0000`,
    body: { type: 'doc', version: 1, content: [para(text)] },
  }));
}

/** @returns {import('./site.d.mts').FixtureProject} */
function edgeProject() {
  const tl = read('tl-issues.json');
  const issues = tl.issues;
  issues.find((/** @type {any} */ i) => i.key === 'TL-22').fields.description = longDescription();
  const { _comment, ...comments } = read('tl-comments.json');
  void _comment;
  // TL-8 (decision 33): a sub-task with a header line's worth of fields, a long description
  // and several comments.
  const tl8 = issues.find((/** @type {any} */ i) => i.key === 'TL-8').fields;
  Object.assign(tl8, {
    description: subtaskDescription(),
    assignee: PEOPLE[2],
    customfield_10015: '2026-11-02',
    duedate: '2026-12-04',
    customfield_10016: 3,
  });
  tl8.comment = { comments: [], maxResults: 2, total: 4, startAt: 0 };
  comments['TL-8'] = subtaskComments();
  return {
    key: 'TL',
    name: tl.project.name,
    issues,
    comments,
    attachments: {
      20001: { size: 120 },
      20002: { size: 96 },
      20003: { size: 629145600 },
      20004: { size: 64, fail: true },
      20005: { size: 40 },
    },
    pageSize: 100,
  };
}

/** Deterministic bytes for an attachment. @param {string} id @param {number} size */
export function attachmentBytes(id, size) {
  const unit = Buffer.from(`fixture attachment ${id}\n`);
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += unit.length) unit.copy(out, i, 0, Math.min(unit.length, size - i));
  return out;
}

/** @param {unknown} body @param {number} [status] @param {Record<string, string>} [headers] */
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const errors = (/** @type {number} */ status, /** @type {string} */ message) =>
  json({ errorMessages: [message], errors: {} }, status);

/** @param {string} jql */
const projectOf = (jql) =>
  /project\s*=\s*"?([A-Z][A-Z0-9_]*)"?/i.exec(jql)?.[1]?.toUpperCase() ?? null;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {import('./site.d.mts').JiraSiteOptions} [opts]
 * @returns {import('./site.d.mts').JiraSite}
 */
export function createJiraSite(opts = {}) {
  const origin = new URL(opts.origin ?? FIXTURE_ORIGIN).origin;
  const email = opts.email ?? FIXTURE_EMAIL;
  const token = opts.token ?? FIXTURE_TOKEN;
  const basic = (/** @type {string} */ t) =>
    `Basic ${Buffer.from(`${email}:${t}`).toString('base64')}`;
  const expected = basic(token);
  const scoped = basic(opts.scopedToken ?? FIXTURE_SCOPED_TOKEN);
  const limited = basic(opts.limitedToken ?? FIXTURE_LIMITED_TOKEN);
  const cloudId = opts.cloudId ?? FIXTURE_CLOUD_ID;
  const gatewayPrefix = `/ex/jira/${cloudId}`;
  const big = generateProject('BIG', 500);
  big.throttle = { 200: [{ status: 429, retryAfter: '1' }] };
  const rate = generateProject('RATE', 30, 5);
  rate.throttle = { 0: [{ status: 429, retryAfter: '2' }, { status: 503 }] };
  const slow = generateProject('SLOW', 120, 9);
  slow.pageSize = 20;
  slow.delayMs = opts.slowDelayMs ?? 400;
  /** @type {Map<string, import('./site.d.mts').FixtureProject>} */
  const projects = new Map([
    ['TL', edgeProject()],
    ['BIG', big],
    ['RATE', rate],
    ['SLOW', slow],
  ]);
  for (const p of opts.projects ?? []) projects.set(p.key, p);
  /** @type {{ method: string; path: string; via: 'site' | 'gateway' }[]} */
  const requests = [];
  const unauthorized = () =>
    new Response(
      JSON.stringify({
        errorMessages: ['Client must be authenticated to access this resource.'],
      }),
      {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Basic' },
      },
    );

  /** @param {any} issue @param {string[] | undefined} wanted @param {import('./site.d.mts').FixtureProject} project */
  function shape(issue, wanted, project) {
    const all = !wanted || wanted.includes('*all') || wanted.includes('*navigable');
    /** @type {Record<string, unknown>} */
    const fields = {};
    for (const [k, v] of Object.entries(issue.fields)) {
      if (all || wanted.includes(k)) fields[k] = structuredClone(v);
    }
    if (all || wanted.includes('comment')) {
      const list = project.comments[issue.key] ?? [];
      fields.comment = {
        comments: structuredClone(list.slice(0, 2)),
        maxResults: 2,
        total: list.length,
        startAt: 0,
      };
    }
    return { id: issue.id, key: issue.key, fields };
  }

  /** @param {Request} request */
  async function handle(request) {
    const url = new URL(request.url);
    const via = url.origin === GATEWAY_ORIGIN ? 'gateway' : 'site';
    let path = url.pathname;
    if (via === 'gateway') {
      // Scoped tokens: https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/…
      if (!path.startsWith(`${gatewayPrefix}/`)) {
        requests.push({ method: request.method, path: url.pathname + url.search, via });
        return errors(404, 'Not Found');
      }
      path = path.slice(gatewayPrefix.length);
    }
    requests.push({ method: request.method, path: path + url.search, via });
    if (via === 'site' && path === '/__health') return json({ ok: true });
    // Public, no credentials: what the importer reads the cloudId from.
    if (via === 'site' && request.method === 'GET' && path === '/_edge/tenant_info') {
      if (opts.tenantInfo === false) return errors(404, 'Not Found');
      return json({ cloudId });
    }
    const auth = request.headers.get('authorization');
    if (via === 'site' && auth !== expected) return unauthorized();
    if (via === 'gateway') {
      if (auth === limited) {
        if (!(request.method === 'GET' && path === '/rest/api/3/myself')) {
          return json({ code: 401, message: 'Unauthorized; scope does not match' }, 401);
        }
      } else if (auth !== scoped) {
        return unauthorized();
      }
    }
    let m;
    if (request.method === 'GET' && path === '/rest/api/3/myself') {
      return json({
        accountId: 'fixture-acct-0000',
        displayName: 'Owner Example',
        emailAddress: email,
      });
    }
    if (request.method === 'GET' && (m = /^\/rest\/api\/3\/project\/([^/]+)$/.exec(path))) {
      const wantedKey = decodeURIComponent(m[1]).toUpperCase();
      if (wantedKey === LOCKED_PROJECT) {
        return errors(403, 'You do not have permission to browse this project.');
      }
      const project = projects.get(wantedKey);
      if (!project) return errors(404, `No project could be found with key '${m[1]}'.`);
      return json({ id: '10100', key: project.key, name: project.name });
    }
    if (request.method === 'GET' && path === '/rest/api/3/field') return json(FIELDS);
    if (request.method === 'POST' && path === '/rest/api/3/search/approximate-count') {
      const body = await request.json();
      const project = projects.get(projectOf(String(body.jql ?? '')) ?? '');
      if (!project) return errors(400, 'The JQL query is invalid.');
      return json({ count: project.issues.length });
    }
    if (request.method === 'POST' && path === '/rest/api/3/search/jql') {
      const body = await request.json();
      const key = projectOf(String(body.jql ?? ''));
      const project = projects.get(key ?? '');
      if (!project)
        return errors(400, `The value '${key}' does not exist for the field 'project'.`);
      const offset = body.nextPageToken
        ? Number(Buffer.from(String(body.nextPageToken), 'base64url').toString('utf8'))
        : 0;
      const planned = project.throttle?.[offset];
      if (planned && planned.length > 0) {
        const next = planned.shift();
        return new Response(JSON.stringify({ errorMessages: ['Rate limit exceeded.'] }), {
          status: next.status,
          headers: {
            'content-type': 'application/json',
            ...(next.retryAfter ? { 'retry-after': next.retryAfter } : {}),
          },
        });
      }
      if (project.delayMs) await sleep(project.delayMs);
      const size = Math.min(Number(body.maxResults ?? 50), project.pageSize ?? 100);
      const page = project.issues.slice(offset, offset + size);
      const more = offset + size < project.issues.length;
      return json({
        issues: page.map((i) => shape(i, body.fields, project)),
        isLast: !more,
        ...(more
          ? { nextPageToken: Buffer.from(String(offset + size), 'utf8').toString('base64url') }
          : {}),
      });
    }
    if (request.method === 'GET' && (m = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(path))) {
      const issueKey = decodeURIComponent(m[1]);
      const project = projects.get(issueKey.split('-')[0] ?? '');
      if (!project || !project.issues.some((i) => i.key === issueKey)) {
        return errors(404, 'Issue does not exist or you do not have permission to see it.');
      }
      const list = project.comments[issueKey] ?? [];
      const startAt = Number(url.searchParams.get('startAt') ?? 0);
      const maxResults = Math.min(Number(url.searchParams.get('maxResults') ?? 50), 100);
      return json({
        startAt,
        maxResults,
        total: list.length,
        comments: structuredClone(list.slice(startAt, startAt + maxResults)),
      });
    }
    if (
      request.method === 'GET' &&
      (m = /^\/rest\/api\/3\/attachment\/content\/([^/]+)$/.exec(path))
    ) {
      const id = decodeURIComponent(m[1]);
      const found = [...projects.values()].map((p) => p.attachments[id]).find(Boolean);
      if (!found) return errors(404, 'The attachment does not exist.');
      if (url.searchParams.get('redirect') !== 'false') {
        // Real Jira redirects to its media host; the importer must never follow that.
        return new Response(null, {
          status: 303,
          headers: { location: `https://media.example.test/file/${id}/binary` },
        });
      }
      if (found.fail) return errors(500, 'Internal server error.');
      return new Response(attachmentBytes(id, found.size), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(found.size),
        },
      });
    }
    return errors(404, `No fixture route for ${request.method} ${path}.`);
  }

  return {
    origin,
    email,
    token,
    cloudId,
    projects,
    requests,
    handle,
    fetch(input, init) {
      const request = new Request(input, init);
      const target = new URL(request.url).origin;
      if (target !== origin && target !== GATEWAY_ORIGIN) {
        return Promise.reject(
          new TypeError(`fetch failed: no network in tests (${new URL(request.url).host})`),
        );
      }
      const signal = request.signal;
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        handle(request).then(
          (res) => {
            signal.removeEventListener('abort', abort);
            resolve(res);
          },
          (err) => {
            signal.removeEventListener('abort', abort);
            reject(err);
          },
        );
      });
    },
  };
}
