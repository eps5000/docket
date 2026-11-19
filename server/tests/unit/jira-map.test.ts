/**
 * Jira mapping (tasks.md T138; BUILD_SPEC §9, §12 V4): one block per
 * mapping row, against the recorded responses in tests/fixtures/jira/
 * (synthetic: no real site, person or token), read through the client with
 * an injected fetch. No network.
 *
 * Rows: types · sub-tasks as work steps · other types · status categories ·
 * priorities · parent epic · Blocks · Relates/Duplicate/Clones/other links ·
 * labels · description (ADF → Markdown, with its losses) · comments ·
 * attachments · due date, start date, story points (field detection) ·
 * unmapped fields · secrets · the report's totals.
 */
import { AGENT_UPLOAD_MAX_BYTES } from '@docket/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { adfToMarkdown } from '../../src/import/jira/adf.js';
import { normaliseJiraSite } from '@docket/shared';
import {
  JiraClient,
  JiraError,
  NO_ACCESS_MESSAGE,
  ORG_KEY_MESSAGE,
  SCOPED_NO_ACCESS_MESSAGE,
  SITE_NOT_FOUND,
  looksLikeOrgKey,
  readJiraProject,
  retryAfterMs,
  siteOrigin,
  wrongCredentialsMessage,
} from '../../src/import/jira/client.js';
import {
  detectFields,
  labelName,
  mapSnapshot,
  searchFields,
} from '../../src/import/jira/mapper.js';
import { buildReport, findCycles } from '../../src/import/jira/report.js';
import type { ImportPlan, JiraSnapshot, PlannedItem } from '../../src/import/jira/types.js';
import {
  FIELDS,
  FIXTURE_LIMITED_TOKEN,
  FIXTURE_ORG_KEY,
  FIXTURE_SCOPED_TOKEN,
  GATEWAY_ORIGIN,
  createJiraSite,
  generateProject,
  type JiraSite,
} from '../fixtures/jira/site.mjs';

function clientFor(site: JiraSite, waits: number[] = [], token = site.token) {
  return new JiraClient({
    site: site.origin,
    email: site.email,
    token,
    fetch: site.fetch,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
}

async function read(key: string, site = createJiraSite()): Promise<JiraSnapshot> {
  return readJiraProject(clientFor(site), key);
}

let site: JiraSite;
let snapshot: JiraSnapshot;
let plan: ImportPlan;
let report: ReturnType<typeof buildReport>;
const item = (key: string): PlannedItem => {
  const found = plan.items.find((i) => i.jira_key === key);
  if (!found) throw new Error(`${key} is not an item`);
  return found;
};
const outcome = (key: string) => plan.outcomes.find((o) => o.key === key)!;
const reasons = (key: string) => outcome(key).reasons.join('; ');
const row = (jira: string, docket: string) =>
  report.mapping.find((r) => r.jira === jira && r.docket === docket);
const fieldRow = (name: string) => report.fields.find((f) => f.field === name);

beforeAll(async () => {
  site = createJiraSite();
  snapshot = await readJiraProject(clientFor(site), 'TL');
  plan = mapSnapshot(snapshot, { known: [site.token] });
  report = buildReport(plan);
});

describe('the client (REST v3, recorded responses)', () => {
  it('accepts only an https site, as its origin, normalised (B32)', () => {
    expect(siteOrigin('https://acme.example.test/jira/')).toBe('https://acme.example.test');
    expect(siteOrigin('acme.atlassian.net')).toBe('https://acme.atlassian.net');
    expect(siteOrigin('  https://acme.atlassian.net/jira/software/projects/ABC/boards/1  ')).toBe(
      'https://acme.atlassian.net',
    );
    expect(siteOrigin('acme.atlassian.net/browse/ABC-12?focused=1#x')).toBe(
      'https://acme.atlassian.net',
    );
    expect(siteOrigin('https://acme.atlassian.net///')).toBe('https://acme.atlassian.net');
    expect(normaliseJiraSite('ACME.atlassian.net/jira')).toBe('https://acme.atlassian.net');
    expect(normaliseJiraSite('http://acme.atlassian.net/jira')).toBe(
      'http://acme.atlassian.net/jira',
    );
    expect(normaliseJiraSite('')).toBe('');
    expect(() => siteOrigin('http://acme.example.test')).toThrow(/https/);
    expect(() => siteOrigin('https://user:pw@acme.example.test')).toThrow(/without a user/);
    expect(() => siteOrigin('acme')).toThrow(JiraError);
  });

  it('signs in, then reads the project, the fields, a count and every page, all on the site', async () => {
    const paths = site.requests.map((r) => `${r.method} ${r.path.split('?')[0]}`);
    expect(paths.slice(0, 6)).toEqual([
      'GET /_edge/tenant_info',
      'GET /rest/api/3/myself',
      'GET /rest/api/3/project/TL',
      'GET /rest/api/3/field',
      'POST /rest/api/3/search/approximate-count',
      'POST /rest/api/3/search/jql',
    ]);
    // The search embeds two comments per issue; TL-2 has three, read from the comment endpoint.
    expect(paths).toContain('GET /rest/api/3/issue/TL-2/comment');
    expect(snapshot.comments['TL-2']).toHaveLength(3);
    expect(snapshot.issues).toHaveLength(22);
    expect(site.requests.every((r) => r.via === 'site')).toBe(true);
  });

  it('asks for every custom field by ID (field IDs vary by site)', () => {
    const wanted = searchFields(FIELDS);
    expect(wanted).toEqual(
      expect.arrayContaining([
        'summary',
        'issuelinks',
        'customfield_10015',
        'customfield_10016',
        'customfield_10001',
      ]),
    );
  });

  it('turns a bad sign-in and an unknown project into the dialog messages', async () => {
    const bad = createJiraSite();
    await expect(readJiraProject(clientFor(bad, [], 'wrong-token'), 'TL')).rejects.toMatchObject({
      kind: 'auth',
      message: wrongCredentialsMessage(bad.email),
    });
    await expect(readJiraProject(clientFor(bad), 'ABC')).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Project ABC not found or not visible to this account.',
    });
  });

  describe('signing in: the credential matrix (B32; BUILD_SPEC §9 "Signing in")', () => {
    const signIn = async (s: JiraSite, token: string, key = 'TL', siteUrl = s.origin) => {
      const client = new JiraClient({
        site: siteUrl,
        email: s.email,
        token,
        fetch: s.fetch,
        sleep: () => Promise.resolve(),
      });
      try {
        const snap = await readJiraProject(client, key);
        return { ok: true as const, route: client.route, issues: snap.issues.length, client };
      } catch (err) {
        return { ok: false as const, route: client.route, error: err as JiraError, client };
      }
    };

    it('a classic personal token works on the site, and never touches the gateway', async () => {
      const s = createJiraSite();
      const r = await signIn(s, s.token);
      expect(r).toMatchObject({ ok: true, route: 'site', issues: 22 });
      expect(s.requests.some((q) => q.via === 'gateway')).toBe(false);
    });

    it('a scoped token: 401 on the site, then 200 through the gateway, which the whole read uses', async () => {
      const s = createJiraSite();
      const r = await signIn(s, FIXTURE_SCOPED_TOKEN);
      expect(r).toMatchObject({ ok: true, route: 'gateway', issues: 22 });
      expect(r.client.base).toBe(`${GATEWAY_ORIGIN}/ex/jira/${s.cloudId}`);
      const order = s.requests.map((q) => `${q.via} ${q.method} ${q.path.split('?')[0]}`);
      expect(order.slice(0, 4)).toEqual([
        'site GET /_edge/tenant_info',
        'site GET /rest/api/3/myself',
        'gateway GET /rest/api/3/myself',
        'gateway GET /rest/api/3/project/TL',
      ]);
      // After sign-in nothing goes to the site: search, comments, all through the gateway.
      expect(s.requests.slice(2).every((q) => q.via === 'gateway')).toBe(true);
      expect(order).toContain('gateway GET /rest/api/3/issue/TL-2/comment');
      // Attachments too, with the same credentials.
      const before = s.requests.length;
      const res = await r.client.attachment('20001');
      expect((await res.arrayBuffer()).byteLength).toBe(120);
      expect(s.requests.slice(before)).toEqual([
        {
          method: 'GET',
          path: '/rest/api/3/attachment/content/20001?redirect=false',
          via: 'gateway',
        },
      ]);
      // A full attachment URL on the site is refused for a gateway session: nothing reaches it.
      await expect(
        r.client.request(`${s.origin}/rest/api/3/attachment/content/20001`),
      ).rejects.toMatchObject({ kind: 'protocol' });
      expect(s.requests).toHaveLength(before + 1);
    });

    it('an organization API key: 401 on both, named as such', async () => {
      const s = createJiraSite();
      const r = await signIn(s, FIXTURE_ORG_KEY);
      expect(r.ok).toBe(false);
      expect(r.error).toMatchObject({ kind: 'auth', message: ORG_KEY_MESSAGE });
      expect((await signIn(s, `Bearer ${s.token}`)).error).toMatchObject({
        message: ORG_KEY_MESSAGE,
      });
      expect(looksLikeOrgKey('ATATT3xFfGF0-personal')).toBe(false);
      expect(looksLikeOrgKey('ATCTT3xFfGN0-admin')).toBe(true);
      expect(looksLikeOrgKey(' bearer abc')).toBe(true);
    });

    it('a wrong token: 401 on both, naming the email the token must belong to', async () => {
      const s = createJiraSite();
      const r = await signIn(s, 'not-the-token');
      expect(r.error).toMatchObject({
        kind: 'auth',
        message:
          "Wrong email or API token. The token must belong to owner@example.test's Atlassian account.",
      });
    });

    it("a 403: signed in, but the project can't be browsed; scoped tokens are told the scopes", async () => {
      const s = createJiraSite();
      expect((await signIn(s, s.token, 'LOCKED')).error).toMatchObject({
        kind: 'auth',
        message: NO_ACCESS_MESSAGE,
      });
      const scoped = await signIn(s, FIXTURE_SCOPED_TOKEN, 'LOCKED');
      expect(scoped.error).toMatchObject({ kind: 'auth', message: SCOPED_NO_ACCESS_MESSAGE });
      expect(SCOPED_NO_ACCESS_MESSAGE).toContain('read:jira-work and read:jira-user');
      // A scoped token without the read scopes: the gateway's "scope does not match".
      const limited = await signIn(s, FIXTURE_LIMITED_TOKEN);
      expect(limited).toMatchObject({ ok: false, route: 'gateway' });
      expect(limited.error).toMatchObject({ kind: 'auth', message: SCOPED_NO_ACCESS_MESSAGE });
    });

    it('site not found: unreachable, or no tenant info (not an Atlassian site)', async () => {
      const s = createJiraSite();
      const away = await signIn(s, s.token, 'TL', 'https://nowhere.example.test');
      expect(away.error).toMatchObject({ kind: 'not_found', message: SITE_NOT_FOUND });
      expect(SITE_NOT_FOUND).toBe(
        'Site not found: check the URL (https://yoursite.atlassian.net).',
      );
      const plain = createJiraSite({ tenantInfo: false });
      const r = await signIn(plain, plain.token);
      expect(r.error).toMatchObject({ kind: 'not_found', message: SITE_NOT_FOUND });
      // It stopped at the tenant info: the credentials were never sent anywhere.
      expect(plain.requests.map((q) => q.path)).toEqual(['/_edge/tenant_info']);
    });

    it('a pasted site URL with a path still signs in', async () => {
      const s = createJiraSite();
      const r = await signIn(s, s.token, 'TL', `${s.origin}/jira/software/projects/TL/boards/1/`);
      expect(r).toMatchObject({ ok: true, route: 'site' });
    });
  });

  it('pages through 500 issues and honours Retry-After on a 429', async () => {
    const big = createJiraSite();
    const waits: number[] = [];
    const progress: (number | null)[][] = [];
    const snap = await readJiraProject(clientFor(big, waits), 'BIG', (p) =>
      progress.push([p.done, p.total]),
    );
    expect(snap.issues).toHaveLength(500);
    expect(big.requests.filter((r) => r.path === '/rest/api/3/search/jql')).toHaveLength(6); // 5 pages + 1 throttled
    expect(waits).toEqual([1000]);
    expect(progress).toContainEqual([200, 500]);
  });

  it('retries a 429 after its Retry-After, then a 503 with backoff', async () => {
    const rate = createJiraSite();
    const waits: number[] = [];
    const snap = await readJiraProject(clientFor(rate, waits), 'RATE');
    expect(snap.issues).toHaveLength(30);
    expect(waits).toEqual([2000, 2000]);
    expect(retryAfterMs('120')).toBe(120_000);
    expect(
      retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:27:30 GMT')),
    ).toBe(30_000);
    expect(retryAfterMs(null)).toBeNull();
  });

  it('gives up after five retries with a rate-limit message', async () => {
    const always = new JiraClient({
      site: 'https://acme.example.test',
      email: 'a@example.test',
      token: 't',
      fetch: () =>
        Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '1' } })),
      sleep: () => Promise.resolve(),
    });
    await expect(always.myself()).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('never follows a redirect, and downloads attachments from the site itself', async () => {
    const s = createJiraSite();
    const client = clientFor(s);
    await expect(client.request('/rest/api/3/attachment/content/20001')).rejects.toMatchObject({
      kind: 'protocol',
    });
    const res = await client.attachment('20001');
    expect((await res.arrayBuffer()).byteLength).toBe(120);
    expect(s.requests.at(-1)!.path).toBe('/rest/api/3/attachment/content/20001?redirect=false');
    await expect(client.request('https://elsewhere.example.test/x')).rejects.toMatchObject({
      kind: 'protocol',
    });
    expect(s.requests.every((r) => !r.path.includes('elsewhere'))).toBe(true);
  });

  it('forgets the token: later requests fail as expired, and errors never quote it', async () => {
    const s = createJiraSite();
    const client = clientFor(s);
    client.forget();
    const err = await client.myself().catch((e: unknown) => e as JiraError);
    expect(err).toMatchObject({ kind: 'expired' });
    expect(JSON.stringify(err) + String(err)).not.toContain(s.token);
    const unreachable = new JiraClient({
      site: 'https://down.example.test',
      email: 'a@example.test',
      token: 'secret-value-123',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    // Unreachable at sign-in: "Site not found". Later in the session: "Couldn't reach".
    const down = await unreachable.myself().catch((e: unknown) => e as JiraError);
    expect((down as JiraError).message).toBe(SITE_NOT_FOUND);
    const later = await unreachable.fields().catch((e: unknown) => e as JiraError);
    expect((later as JiraError).message).toBe(
      "Couldn't reach https://down.example.test. Check the Jira site address.",
    );
  });
});

describe('field detection by name (BUILD_SPEC §12 V4)', () => {
  it('finds the start date, story points and sprint fields', () => {
    expect(detectFields(FIELDS)).toEqual({
      story_points: ['customfield_10028', 'customfield_10016'],
      start_date: ['customfield_10015'],
      sprint: ['customfield_10020'],
    });
  });

  it('uses the story points candidate that has values, and lists the fields used', () => {
    expect(report.fields_used).toEqual([
      { field: 'Story points', jira_field: 'customfield_10016' },
      { field: 'Start date', jira_field: 'customfield_10015' },
      { field: 'Due date', jira_field: 'duedate' },
    ]);
  });

  it('says "not found" (null) when a site has no such field', () => {
    const bare = mapSnapshot({ ...snapshot, fields: FIELDS.filter((f) => !f.custom) });
    expect(buildReport(bare).fields_used.slice(0, 2)).toEqual([
      { field: 'Story points', jira_field: null },
      { field: 'Start date', jira_field: null },
    ]);
    expect(bare.items.find((i) => i.jira_key === 'TL-2')!.effort).toBeNull();
  });
});

describe('types', () => {
  it('Epic, Story, Task and Bug keep their type', () => {
    expect(item('TL-1').type).toBe('Epic');
    expect(item('TL-2').type).toBe('Story');
    expect(item('TL-3').type).toBe('Task');
    expect(item('TL-4').type).toBe('Bug');
    expect(row('Type: Story', 'Story')).toMatchObject({ count: 6, lossy: 0 });
  });

  it('other issue types become Task, with the original type noted in the description', () => {
    expect(item('TL-6').type).toBe('Task');
    expect(item('TL-6').description_md).toContain('From Jira: type Spike');
    expect(item('TL-20').type).toBe('Task');
    expect(reasons('TL-6')).toContain('Jira type Spike imported as Task');
    expect(row('Type: Spike', 'Task')).toMatchObject({ count: 1, lossy: 1 });
  });
});

describe('sub-tasks become work steps on the parent', () => {
  it('in key order, with the state from the status category', () => {
    expect(item('TL-2').steps).toEqual([
      { jira_key: 'TL-7', text: 'Add Luhn check', state: 'done' },
      { jira_key: 'TL-8', text: 'Show inline errors', state: 'current' },
      { jira_key: 'TL-9', text: 'Copy review', state: 'todo' },
    ]);
    expect(plan.items.some((i) => ['TL-7', 'TL-8', 'TL-9'].includes(i.jira_key))).toBe(false);
  });

  it("is always a change, listing what isn't kept: comments, assignee, dates, description, attachments, links", () => {
    expect(outcome('TL-7')).toMatchObject({ outcome: 'step' });
    expect(reasons('TL-7')).toBe(
      'Became a checklist step on TL-2; not kept: assignee, 1 comment, due date, description, 1 attachment',
    );
    expect(reasons('TL-9')).toBe('Became a checklist step on TL-2; not kept: links');
    // Nothing lost, but still a change (B32): it's a step now, not an item.
    expect(outcome('TL-8')).toMatchObject({
      outcome: 'step',
      reasons: ['Became a checklist step on TL-2'],
    });
    expect(row('Type: Subtask', 'Work step')).toMatchObject({ count: 3, lossy: 3 });
  });

  it('skips a sub-task whose parent is not imported, with the reason', () => {
    expect(outcome('TL-10')).toMatchObject({
      outcome: 'skipped',
      reasons: ["Skipped: sub-task of TL-99, which isn't in this import"],
    });
  });
});

describe('status categories', () => {
  it('To Do → Inbox, In Progress → In progress (no lead, no run), Done → Done', () => {
    expect(item('TL-1').status).toBe('inbox');
    expect(item('TL-2').status).toBe('progress');
    expect(item('TL-4').status).toBe('done');
  });

  it('notes status names that are not standard', () => {
    expect(item('TL-3').status).toBe('progress');
    expect(item('TL-3').description_md).toContain('From Jira: status “Code review”');
    expect(reasons('TL-5')).toContain('status “Closed” noted; imported as Done');
    expect(reasons('TL-6')).toContain('status “Backlog” noted; imported as Inbox');
    expect(row('Status: In Progress', 'In progress')).toMatchObject({ count: 3, lossy: 1 });
  });

  it('a status with no category imports as Inbox and is listed', () => {
    expect(item('TL-11').status).toBe('inbox');
    expect(reasons('TL-11')).toBe('status “Triage” has no category; imported as Inbox');
  });
});

describe('priorities', () => {
  it('Highest and High → P1, Medium → P2, Low and Lowest → P3', () => {
    expect(
      [item('TL-2'), item('TL-1'), item('TL-3'), item('TL-4'), item('TL-5')].map((i) => i.priority),
    ).toEqual([1, 1, 2, 3, 3]);
  });

  it('anything else is P2 and listed; a missing priority is P2 and not a loss', () => {
    expect(item('TL-6').priority).toBe(2);
    expect(reasons('TL-6')).toContain("priority Critical isn't standard; imported as P2");
    expect(item('TL-11').priority).toBe(2);
    expect(row('Priority: (none)', 'P2')).toMatchObject({ count: 1, lossy: 0 });
  });
});

describe('parent epic', () => {
  it('becomes epic_id', () => {
    expect(item('TL-2').epic_key).toBe('TL-1');
    expect(item('TL-3').epic_key).toBe('TL-1');
    expect(item('TL-4').epic_key).toBeNull();
  });

  it("an epic's own parent is dropped and listed (an epic can't belong to another item)", () => {
    expect(item('TL-19').epic_key).toBeNull();
    expect(reasons('TL-19')).toBe("parent TL-20 dropped: an epic can't belong to another item");
  });
});

describe('links', () => {
  const link = (from: string, to: string) => plan.links.find((l) => l.from === from && l.to === to);

  it('Blocks → blocks, in Jira direction, once per Jira link', () => {
    expect(link('TL-3', 'TL-2')).toEqual({
      from: 'TL-3',
      to: 'TL-2',
      type: 'blocks',
      jira_types: ['Blocks'],
    });
    expect(plan.links.filter((l) => l.type === 'blocks')).toHaveLength(4);
  });

  it('Relates → relates, nothing noted', () => {
    expect(link('TL-4', 'TL-2')).toMatchObject({ type: 'relates', jira_types: ['Relates'] });
    expect(row('Link: Relates', 'relates')).toMatchObject({ count: 1, lossy: 0 });
  });

  it('Duplicate, Cloners and other types → relates, with the link type noted', () => {
    expect(link('TL-4', 'TL-5')).toMatchObject({ type: 'relates', jira_types: ['Duplicate'] });
    expect(item('TL-4').description_md).toMatch(/From Jira: duplicates TL-5$/);
    expect(link('TL-15', 'TL-11')).toMatchObject({ type: 'relates', jira_types: ['Cloners'] });
    expect(link('TL-15', 'TL-12')).toMatchObject({ type: 'relates', jira_types: ['Depends'] });
    expect(item('TL-15').description_md).toBe('---\nFrom Jira: depends on TL-12 · clones TL-11');
    expect(row('Link: Duplicate', 'relates')).toMatchObject({ lossy: 1 });
  });

  it('links to issues outside the import, or to sub-tasks, are dropped and listed', () => {
    expect(plan.links.some((l) => l.from === 'OPS-4' || l.to === 'OPS-4')).toBe(false);
    expect(reasons('TL-15')).toContain('link Blocks with OPS-4 dropped: not in this import');
    expect(reasons('TL-3')).toContain(
      'link Relates with TL-9 dropped: TL-9 is a sub-task (a work step)',
    );
  });

  it('cycles are imported as they are and reported', () => {
    expect(report.cycles).toEqual([['TL-12', 'TL-13', 'TL-14']]);
    expect(
      findCycles([
        { from: 'A-1', to: 'A-2', type: 'relates', jira_types: [] },
        { from: 'A-2', to: 'A-1', type: 'relates', jira_types: [] },
      ]),
    ).toEqual([]);
  });
});

describe('labels', () => {
  it('are created as Docket names; renamed and unusable ones are listed', () => {
    expect(item('TL-1').labels).toEqual(['payments']);
    expect(item('TL-2').labels).toEqual(['frontend', 'tech-debt']);
    expect(reasons('TL-2')).toContain('label “Tech_Debt” imported as tech-debt');
    expect(item('TL-21').labels).toEqual(['a-b-c']);
    expect(reasons('TL-21')).toContain('label “!!!” dropped: no usable characters');
    expect(labelName('  Ops / On-Call  ')).toBe('ops-on-call');
    expect(labelName('x'.repeat(60))).toHaveLength(40);
  });
});

describe('description: ADF to Markdown', () => {
  it('converts the supported nodes and marks with no loss', () => {
    const doc = snapshot.issues.find((i) => i.key === 'TL-1')!.fields.description;
    const { markdown, losses } = adfToMarkdown(doc);
    expect(losses).toEqual([]);
    expect(markdown).toBe(
      [
        '## Goal',
        'Make checkout **fast** and _boring_. See [the brief](https://docs.example.test/checkout) and run `pnpm test`.  \nOld flow is ~~gone~~',
        '- One page\n- Saved cards\n  1. Opt in\n  2. Opt out',
        '```ts\nconst total = items.reduce(sum, 0);\n```',
        '> Ship before the holidays.',
        '---',
        '| Step | Owner |\n| --- | --- |\n| Cart | Web \\| API |',
      ].join('\n\n'),
    );
    expect(item('TL-1').description_md).toBe(markdown);
  });

  it('keeps mentions, emoji, dates, status lozenges and smart links as text', () => {
    expect(item('TL-2').description_md).toContain(
      'Ask @Sam Placeholder about 💳 rules by 2025-12-01. State: [AT RISK] Spec: <https://docs.example.test/cards>',
    );
  });

  it('lists every unsupported node and mark, and keeps their text', () => {
    const doc = snapshot.issues.find((i) => i.key === 'TL-4')!.fields.description;
    const { markdown, losses } = adfToMarkdown(doc);
    expect(losses).toEqual([
      'decision',
      'expand',
      'extension (macro)',
      'layout columns',
      'media',
      'merged table cells',
      'subscript or superscript',
      'text colour',
      'underline',
      'unsupported node “fancyWidget”',
    ]);
    for (const text of [
      'Totals are red and underlined; H2O.',
      '**Repro**',
      '_(image: screenshot.png)_',
      '- Decision: Round half up',
      'Left\n\nRight',
      '- [x] Write a failing test\n- [ ] Fix rounding',
      'Unknown node text',
    ]) {
      expect(markdown).toContain(text);
    }
    expect(reasons('TL-4')).toContain('description: decision, expand, extension (macro)');
    expect(
      adfToMarkdown({ type: 'doc', content: [{ type: 'panel', content: [] }] }).losses,
    ).toEqual(['panel']);
    expect(adfToMarkdown(null)).toEqual({ markdown: '', losses: [] });
    expect(adfToMarkdown('plain text from an older API')).toEqual({
      markdown: 'plain text from an older API',
      losses: [],
    });
  });

  it('a missing description is empty and not a loss; a long one is shortened and listed', () => {
    expect(item('TL-3').description_md).toBe('---\nFrom Jira: status “Code review”');
    expect(item('TL-22').description_md).toHaveLength(20_000);
    expect(item('TL-22').description_md.endsWith('…')).toBe(true);
    expect(reasons('TL-22')).toBe('description shortened to 20,000 characters');
  });

  it('a long title is shortened to 200 characters and listed', () => {
    expect(item('TL-16').title).toHaveLength(200);
    expect(reasons('TL-16')).toBe('title shortened to 200 characters');
  });
});

describe('comments', () => {
  it('every comment is read and kept with its author and Jira date', () => {
    expect(item('TL-2').comments.map((c) => [c.author, c.created, c.text])).toEqual([
      ['Riley Example', '2026-03-04T10:00:00.000+0000', 'Can we reuse the `validateCard` helper?'],
      [
        'Jo Sample',
        '2026-03-05T09:00:00.000+0000',
        'Third comment, read from the second page.\n\n> **Info:** FYI',
      ],
    ]);
    expect(reasons('TL-2')).toContain('comment by Jo Sample: panel simplified or dropped');
  });
});

describe('attachments', () => {
  it('become documents up to 500 MB; larger ones are skipped and listed', () => {
    expect(item('TL-2').attachments.map((a) => a.name)).toEqual(['card-form.png', 'trace.log']);
    expect(item('TL-1').attachments).toEqual([
      { jira_id: '20001', name: 'plan.md', size: 120, mime: 'text/markdown' },
    ]);
    expect(report.attachments).toEqual({
      count: 3,
      bytes: 120 + 96 + 64,
      skipped: [{ key: 'TL-2', name: 'huge-recording.mp4', reason: 'larger than 500 MB' }],
    });
    expect(629145600).toBeGreaterThan(AGENT_UPLOAD_MAX_BYTES);
  });
});

describe('due date, start date and story points', () => {
  it('map to planned_end, planned_start and effort', () => {
    expect(item('TL-2')).toMatchObject({
      planned_start: '2026-11-20',
      planned_end: '2026-12-01',
      effort: 5,
    });
    expect(item('TL-3')).toMatchObject({ planned_start: null, planned_end: null, effort: 3 });
  });

  it('invalid values are dropped and listed', () => {
    expect(item('TL-21')).toMatchObject({
      planned_start: null,
      planned_end: '2026-11-01',
      effort: null,
    });
    expect(reasons('TL-21')).toContain(
      'start date 2026-11-30 dropped: after the due date 2026-11-01',
    );
    expect(reasons('TL-21')).toContain('story points -2 dropped: not a number ≥ 0');
  });
});

describe('fields that are not mapped', () => {
  it('assignee, reporter, sprint, fix versions, components and other custom fields are counted', () => {
    expect(fieldRow('Assignee')).toEqual({ field: 'Assignee', mapped: 0, skipped: 2, lossy: 0 });
    expect(fieldRow('Reporter')).toMatchObject({ mapped: 0, skipped: 21 });
    expect(fieldRow('Sprint')).toMatchObject({ mapped: 0, skipped: 1 });
    expect(fieldRow('Fix versions')).toMatchObject({ mapped: 0, skipped: 1 });
    expect(fieldRow('Components')).toMatchObject({ mapped: 0, skipped: 1 });
    expect(fieldRow('Other custom fields')).toMatchObject({ mapped: 0, skipped: 1 });
  });
});

describe('secrets (constitution Principle VI)', () => {
  it('a summary that looks like a secret skips the issue, and the title is not shown', () => {
    expect(outcome('TL-18')).toEqual({
      key: 'TL-18',
      title: '(not shown: looks like a secret)',
      outcome: 'skipped',
      reasons: ['Skipped: its summary looks like a secret (API key)'],
    });
  });

  it('a description or comment that looks like one is dropped and listed', () => {
    expect(item('TL-17').description_md).toBe('');
    expect(reasons('TL-17')).toBe('description dropped: it looks like a secret (GitHub token)');
    expect(item('TL-2').comments.some((c) => c.text.includes('Bearer'))).toBe(false);
    expect(reasons('TL-2')).toContain(
      'comment by Sam Placeholder dropped: it looks like a secret (Bearer token)',
    );
  });

  it('the Jira token itself is matched by value', async () => {
    const token = 'plain-looking-token-value-0042';
    const s = createJiraSite({ token });
    const snap = await read('TL', s);
    const tl3 = snap.issues.find((i) => i.key === 'TL-3')!;
    tl3.fields.description = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `pasted ${token} here` }] }],
    };
    const p = mapSnapshot(snap, { known: [token] });
    expect(p.items.find((i) => i.jira_key === 'TL-3')!.description_md).not.toContain(token);
    expect(JSON.stringify(buildReport(p))).not.toContain(token);
  });
});

describe('the report accounts for every issue (SC-011)', () => {
  it('issues = would import + skipped; lossy items and skipped ones are listed once each', () => {
    expect(report.totals).toEqual({ issues: 22, would_import: 20, skipped: 2, lossy: 16 });
    const listed = report.lossy_items.map((l) => l.key);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toHaveLength(report.totals.lossy + report.totals.skipped);
    const clean = plan.outcomes.filter((o) => o.reasons.length === 0).map((o) => o.key);
    expect(clean.length + listed.length).toBe(22);
  });

  it('groups the changed and skipped issues by reason, with kept and not kept (B32)', () => {
    const g = (reason: string) => report.groups.find((x) => x.reason === reason);
    expect(g('subtask')).toEqual({
      outcome: 'changed',
      reason: 'subtask',
      summary: '3 sub-tasks → checklist steps on their parent',
      kept: 'Kept: title, done or not done.',
      not_kept:
        'Not kept yet: description, comments, assignee, dates (a later update keeps the description and comments).',
      count: 3,
      items: [
        expect.objectContaining({ key: 'TL-7' }),
        expect.objectContaining({ key: 'TL-8', detail: 'Became a checklist step on TL-2' }),
        expect.objectContaining({ key: 'TL-9' }),
      ],
    });
    // Sub-tasks whose parent isn't imported stay under Skipped, with the reason.
    expect(g('skip_subtask')).toMatchObject({
      outcome: 'skipped',
      summary: '1 sub-task whose parent isn’t in this import',
      kept: null,
      items: [
        expect.objectContaining({
          key: 'TL-10',
          detail: "Skipped: sub-task of TL-99, which isn't in this import",
        }),
      ],
    });
    // Every reason the mapper writes for the fixture has a group of its own (no "other").
    expect(report.groups.map((x) => x.reason)).not.toContain('other');
    expect(report.groups.map((x) => x.reason)).not.toContain('skip_other');
    // Every changed issue is in at least one group, every skipped one in exactly one.
    const changed = new Set(
      report.groups
        .filter((x) => x.outcome === 'changed')
        .flatMap((x) => x.items.map((i) => i.key)),
    );
    expect(changed.size).toBe(report.totals.lossy);
    const skipped = report.groups
      .filter((x) => x.outcome === 'skipped')
      .flatMap((x) => x.items.map((i) => i.key));
    expect(skipped).toHaveLength(report.totals.skipped);
    for (const x of report.groups) expect(x.count).toBe(x.items.length);
  });

  it('the generated 500-issue project is accounted for in full', async () => {
    const big = mapSnapshot(await read('BIG'));
    const r = buildReport(big);
    expect(r.totals.issues).toBe(500);
    expect(r.totals.would_import + r.totals.skipped).toBe(500);
    const steps = big.items.reduce((n, i) => n + i.steps.length, 0);
    expect(big.items.length + steps + r.totals.skipped).toBe(500);
    expect(r.cycles).toEqual([]);
    expect(r.attachments.skipped).toEqual([
      { key: 'BIG-77', name: 'screen-recording.mov', reason: 'larger than 500 MB' },
    ]);
    expect(generateProject('BIG', 500).issues.map((i) => i.key)).toEqual(
      big.outcomes.map((o) => o.key),
    );
  });
});
