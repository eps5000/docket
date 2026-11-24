/**
 * Problems that say what's wrong, who fixes it and what to do (owner
 * decision 37; BUILD_SPEC §5.22 Problems, §5.21 B42; FR-165–FR-172; tasks.md
 * T186–T189), through the official MCP client SDK and the owner API:
 *
 * - one root cause, one problem: the Gameflow-like fixture (4 stale epic
 *   branches, 2 current ones) gives 4 "out of date with main" findings and
 *   only the genuine pair conflicts;
 * - one note per item from the radar ("Docket's conflict radar: …");
 * - agent problems go to the items' leads first: they reach the owner's
 *   Problems only with no lead ("Nobody is working on GF-228") or after the
 *   grace period ("Not fixed by an agent for an hour"), time-controlled;
 * - *Not an active branch* clears the finding at once, and Undo brings both
 *   back; an agent clearing its branches does too;
 * - *Remind the agent* posts the explanation as an undoable owner note;
 * - *Acknowledge* (undoable) and its return when a proposal arrives;
 * - `propose_resolution`, *Go a different way*, proposing again, *Approve*,
 *   each posted to the item and shown in `get_context`.
 *
 * The explanation text for every kind, and the acknowledgement rule, are
 * unit tests (tests/unit/problems.test.ts).
 */
import { CSRF_HEADER_NAME, reminderText, type Problem } from '@docket/shared';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { planRadar } from '../../src/domain/radar.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { radarRunOnce } from '../../src/jobs/sweeper.js';
import { hostGitPass } from '../host-git.js';
import { git, makeStaleRepo } from '../fixtures/radar-repo.js';
import { insertItem, insertProject, tempDir } from '../helpers.js';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import { expectOk, expectToolError, startHarness, type ContractHarness } from './harness.js';

let h: ContractHarness | undefined;
let tmp: { dir: string; cleanup(): void } | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  tmp?.cleanup();
  tmp = undefined;
});

type S = Record<string, unknown>;
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const sql = () => h!.server.runtime.db.sqlite;
const hours = (n: number) => n * 3_600_000;

/** An owner client: unlock, then requests with the session cookie and the CSRF header. */
async function owner() {
  const app = h!.server.app;
  const res = await app.request(`${ORIGIN}/api/session/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: h!.server.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  const csrf = cookies.docket_csrf!.value;
  const cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${csrf}`;
  return async (method: string, path: string, body?: unknown) => {
    const r = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie,
        ...(method === 'GET'
          ? {}
          : { 'content-type': 'application/json', [CSRF_HEADER_NAME]: csrf }),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    return { status: r.status, body: (await r.json()) as S };
  };
}
type Api = Awaited<ReturnType<typeof owner>>;

const ITEMS: [string, string][] = [
  ['GF-228', 'stale-228'],
  ['GF-235', 'stale-235'],
  ['GF-302', 'stale-302'],
  ['GF-310', 'stale-310'],
  ['GF-240', 'cur-240'],
  ['GF-241', 'cur-241'],
];

/** The Gameflow-like project: six in-flight items, each reporting its branch; the radar set up. */
async function gameflow(env: Record<string, string> = {}) {
  tmp = tempDir('docket-b42-');
  const { repo } = makeStaleRepo(tmp.dir);
  // B76: no push folder: the helper reads the repository on the host.
  h = await startHarness({ env });
  const api = await owner();
  const db = h.server.runtime.db;
  insertProject(db, 'GF');
  for (const [id, branch] of ITEMS) {
    insertItem(db, { id, status: 'progress', title: `Epic ${id}` });
    expectOk(await h.call('declare_shared_changes', { id, none: true, branches: [branch] }));
  }
  expect(
    (await api('PUT', '/api/projects/GF/radar', { repo_path: repo, main_branch: 'main' })).status,
  ).toBe(200);
  return api;
}

const needsYou = async (api: Api) => (await api('GET', '/api/needs-you?scope=GF')).body;
const radarRows = (rows: unknown) => (rows as Problem[]).filter((p) => p.kind === 'radar_conflict');
const findingRows = (radar: S) =>
  (radar.findings as S[]).map((f) => [
    f.branch_a,
    f.branch_b,
    (f.item_a as S).id,
    (f.item_b as S | null)?.id ?? null,
    f.files,
  ]);

describe('one root cause, one problem (decision 37; the radar refinement)', () => {
  it.skipIf(!HAS_GIT)(
    'the Gameflow-like fixture: 4 out of date with main, plus only the genuine pair conflicts',
    async () => {
      const api = await gameflow();
      const r = { db: h!.server.runtime.db, actor: OWNER_ACTOR, now: '2026-11-06T11:00:00.000Z' };
      await hostGitPass(h!.server, { home: tmp!.dir });
      const plan = await planRadar(r, h!.server.runtime.config, 'GF');
      const conflicting = plan.checks.filter((c) => c.files.length > 0);
      // Before B42 every conflicting pair was a finding: 4 with main and 11 pairs, 15 in all.
      const before = conflicting.length + plan.suppressed.length;
      expect(before).toBe(15);
      expect(
        plan.suppressed.map((p) => `${p.branch_a} vs ${p.branch_b}: ${p.files.join(', ')}`),
      ).toEqual(
        expect.arrayContaining([
          'stale-228 vs stale-235: shell.txt',
          'cur-240 vs stale-228: shell.txt',
        ]),
      );
      expect(plan.suppressed).toHaveLength(9);
      // The pair with a file beyond main keeps only that file.
      if (process.env.DOCKET_B42_EVIDENCE) {
        console.log(
          JSON.stringify(
            {
              before: [
                ...conflicting.map((c) => `${c.branch_a} vs ${c.branch_b}: ${c.files.join(', ')}`),
                ...plan.suppressed.map(
                  (p) => `${p.branch_a} vs ${p.branch_b}: ${p.files.join(', ')}`,
                ),
              ],
              after: conflicting.map(
                (c) => `${c.branch_a} vs ${c.branch_b}: ${c.files.join(', ')}`,
              ),
            },
            null,
            2,
          ),
        );
      }

      await hostGitPass(h!.server, { home: tmp!.dir });
      const run = await api('POST', '/api/projects/GF/radar/run', {});
      expect(run.status).toBe(200);
      expect(findingRows(run.body.radar as S)).toEqual(
        expect.arrayContaining([
          ['stale-228', 'main', 'GF-228', null, ['shell.txt']],
          ['stale-235', 'main', 'GF-235', null, ['shell.txt']],
          ['stale-302', 'main', 'GF-302', null, ['shell.txt']],
          ['stale-310', 'main', 'GF-310', null, ['shell.txt']],
          ['cur-240', 'stale-302', 'GF-240', 'GF-302', ['api.txt']],
          ['cur-240', 'cur-241', 'GF-240', 'GF-241', ['docs.txt']],
        ]),
      );
      expect((run.body.radar as S).findings as unknown[]).toHaveLength(6);

      // Nobody leads these items, so each finding is the owner's at once, saying why.
      const rows = radarRows((await needsYou(api)).problems);
      expect(rows).toHaveLength(6);
      const row228 = rows.find((p) => p.item_id === 'GF-228' && p.related.length === 0)!;
      expect(row228.explanation).toEqual({
        what: "GF-228's branch stale-228 is out of date with main: 1 file conflicts (shell.txt).",
        fix: "Rebase it onto main, or split it into short story PRs. If it's an old draft, remove it from GF-228's branches.",
        who: 'agent',
        who_text: 'An agent (GF-228 has no lead yet)',
      });
      expect(row228.reached_you).toBe('Nobody is working on GF-228');
      expect(row228.branches).toEqual([{ item_id: 'GF-228', branch: 'stale-228' }]);
      const pair = rows.find((p) => p.related.includes('GF-241'))!;
      expect(pair.explanation?.what).toBe(
        "GF-240's branch cur-240 and GF-241's branch cur-241 change the same lines: 1 file conflicts (docs.txt).",
      );
      expect(pair.reached_you).toBe('Nobody is working on GF-240 or GF-241');
      expect(pair.branches).toEqual([
        { item_id: 'GF-240', branch: 'cur-240' },
        { item_id: 'GF-241', branch: 'cur-241' },
      ]);

      // One note per item with the run's new findings; GF-240 has two in one note.
      const notes = (id: string) =>
        (
          sql()
            .prepare('SELECT text FROM owner_notes WHERE item_id = ? ORDER BY created_at, id')
            .all(id) as { text: string }[]
        ).map((n) => n.text);
      expect(notes('GF-228')).toEqual([
        "Docket's conflict radar: GF-228's branch stale-228 is out of date with main: 1 file conflicts (shell.txt). Rebase it onto main, or split it into short story PRs. If it's an old draft, remove it from GF-228's branches.",
      ]);
      expect(notes('GF-240')).toHaveLength(1);
      expect(notes('GF-240')[0]).toContain(' Also: ');
      // A second run with nothing new posts nothing.
      await hostGitPass(h!.server, { home: tmp!.dir });
      await api('POST', '/api/projects/GF/radar/run', {});
      expect(notes('GF-228')).toHaveLength(1);
      // The lead reads it with get_item, like any owner note.
      const item = expectOk(await h!.call('get_item', { id: 'GF-228' }));
      expect(item.text).toContain("Docket's conflict radar: GF-228's branch stale-228");
    },
    60_000,
  );
});

describe('agent problems go to the leads first (decision 37)', () => {
  it.skipIf(!HAS_GIT)(
    'with a lead: Agents are handling it; after the grace period it reaches you, saying why',
    async () => {
      // A one-hour grace period and a three-hour claim, so the lead still holds it after.
      const api = await gameflow({ DOCKET_AGENT_PROBLEM_GRACE_HOURS: '1', DOCKET_LEASE: '3h' });
      expectOk(await h!.call('claim_lead', { id: 'GF-228' }));
      await hostGitPass(h!.server, { home: tmp!.dir });
      await api('POST', '/api/projects/GF/radar/run', {});
      let view = await needsYou(api);
      const handled = radarRows(view.agent_problems);
      expect(handled.map((p) => p.item_id)).toEqual(['GF-228']);
      expect(handled[0]!.explanation?.who_text).toBe('An agent (the lead of GF-228)');
      expect(handled[0]!.reached_you).toBeNull();
      expect(radarRows(view.problems).map((p) => p.item_id)).not.toContain('GF-228');
      // Bootstrap counts only the owner's problems.
      const boot = (await api('GET', '/api/bootstrap')).body as { counts: { problems: number } };
      const all = (await api('GET', '/api/needs-you?scope=all')).body;
      expect(boot.counts.problems).toBe((all.problems as unknown[]).length);

      // An hour later, still open: it reaches the owner.
      h!.server.clock.advance(hours(1));
      view = await needsYou(api);
      expect(radarRows(view.agent_problems)).toEqual([]);
      const reached = radarRows(view.problems).find((p) => p.item_id === 'GF-228')!;
      expect(reached.reached_you).toBe('Not fixed by an agent for an hour');

      // The agent's get_context carries the same words, with the ID to propose against.
      const ctx = expectOk(await h!.call('get_context', { id: 'GF-228' }));
      expect(ctx.text).toContain(
        `- ${reached.id} radar_conflict: GF-228's branch stale-228 is out of date with main: 1 file conflicts (shell.txt).`,
      );
      expect(ctx.text).toContain('who acts: An agent (the lead of GF-228)');
    },
    60_000,
  );
});

describe('card actions (decision 37)', () => {
  it.skipIf(!HAS_GIT)(
    'Not an active branch clears the finding at once; Undo brings back the branch and the finding',
    async () => {
      const api = await gameflow();
      await hostGitPass(h!.server, { home: tmp!.dir });
      await api('POST', '/api/projects/GF/radar/run', {});
      const open = () =>
        (
          sql()
            .prepare(
              'SELECT branch_a, branch_b FROM radar_findings WHERE cleared_at IS NULL ORDER BY branch_a, branch_b',
            )
            .all() as { branch_a: string; branch_b: string }[]
        ).map((f) => `${f.branch_a} vs ${f.branch_b}`);
      expect(open()).toContain('stale-228 vs main');

      const removed = await api('POST', '/api/items/GF-228/shared/branches', {
        op: 'remove',
        branch: 'stale-228',
      });
      expect(removed.status).toBe(200);
      // No radar run: the finding cleared with the branch.
      expect(open()).not.toContain('stale-228 vs main');
      expect(radarRows((await needsYou(api)).problems).map((p) => p.item_id)).not.toContain(
        'GF-228',
      );
      const undo = await api('POST', `/api/mutations/${removed.body.mutation_id as string}/undo`);
      expect(undo.status, JSON.stringify(undo.body)).toBe(200);
      expect(open()).toContain('stale-228 vs main');
      expect(
        ((await api('GET', '/api/items/GF-228/shared')).body.branches as S).reported,
      ).toMatchObject([{ name: 'stale-228' }]);

      // An agent clearing its branches clears its findings at once too.
      expectOk(await h!.call('declare_shared_changes', { id: 'GF-310', none: true, branches: [] }));
      expect(open()).not.toContain('stale-310 vs main');
    },
    60_000,
  );

  // B45: the branch below names its item, so discovery would adopt it again.
  const namedBranch = async (api: Api) => {
    git(`${tmp!.dir}/gf-stale`, 'branch', 'gf-228-old', 'stale-228');
    expectOk(
      await h!.call('declare_shared_changes', {
        id: 'GF-228',
        none: true,
        branches: ['gf-228-old'],
      }),
    );
    await hostGitPass(h!.server, { home: tmp!.dir });
    await api('POST', '/api/projects/GF/radar/run', {});
    const finding = () =>
      sql()
        .prepare(
          "SELECT id FROM radar_findings WHERE branch_a = 'gf-228-old' AND cleared_at IS NULL",
        )
        .get() as { id: string } | undefined;
    const id = finding()?.id;
    expect(id).toMatch(/^rdf_/);
    return { finding, id: id! };
  };
  const remove = (api: Api) =>
    api('POST', '/api/items/GF-228/shared/branches', {
      op: 'remove',
      branch: 'gf-228-old',
      not_active: true,
    });

  it.skipIf(!HAS_GIT)(
    'a radar run between Not an active branch and Undo leaves the undo working (B45)',
    async () => {
      const api = await gameflow();
      const { finding, id } = await namedBranch(api);
      const removed = await remove(api);
      expect(finding()).toBeUndefined();

      // The scheduled run lands inside the undo window: it must not adopt the branch again.
      const events = sql().prepare('SELECT count(*) AS n FROM events');
      const before = events.get();
      await hostGitPass(h!.server, { home: tmp!.dir });
      await radarRunOnce(h!.server.runtime, 'GF');
      expect(finding()).toBeUndefined();
      expect(events.get()).toEqual(before);

      const undo = await api('POST', `/api/mutations/${removed.body.mutation_id as string}/undo`);
      expect(undo.status, JSON.stringify(undo.body)).toBe(200);
      expect(finding()?.id).toBe(id);
      expect(
        ((await api('GET', '/api/items/GF-228/shared')).body.branches as S).reported,
      ).toMatchObject([{ name: 'gf-228-old' }]);
    },
    60_000,
  );

  it.skipIf(!HAS_GIT)(
    'a removed branch stays out of discovery until someone reports it again (B45)',
    async () => {
      const api = await gameflow();
      const { finding } = await namedBranch(api);
      await remove(api);
      await hostGitPass(h!.server, { home: tmp!.dir });
      await radarRunOnce(h!.server.runtime, 'GF');
      await hostGitPass(h!.server, { home: tmp!.dir });
      await radarRunOnce(h!.server.runtime, 'GF');
      expect(finding()).toBeUndefined();
      expect((await api('GET', '/api/items/GF-228/shared')).body.branches).toMatchObject({
        reported: [],
        discovered: null,
        matches: [],
      });

      // Reporting it again is the way back.
      await api('POST', '/api/items/GF-228/shared/branches', { op: 'add', branch: 'gf-228-old' });
      await hostGitPass(h!.server, { home: tmp!.dir });
      await radarRunOnce(h!.server.runtime, 'GF');
      expect(finding()).toBeDefined();

      // A plain Remove (the Shared changes section) still lets the radar find it by name.
      await api('POST', '/api/items/GF-228/shared/branches', {
        op: 'remove',
        branch: 'gf-228-old',
      });
      await hostGitPass(h!.server, { home: tmp!.dir });
      await radarRunOnce(h!.server.runtime, 'GF');
      expect((await api('GET', '/api/items/GF-228/shared')).body.branches).toMatchObject({
        reported: [],
        discovered: 'gf-228-old',
      });
    },
    60_000,
  );

  it.skipIf(!HAS_GIT)(
    'removing a reported branch the radar had also discovered clears its finding (B45)',
    async () => {
      const api = await gameflow();
      git(`${tmp!.dir}/gf-stale`, 'branch', 'gf-228-old', 'stale-228');
      // Discovered first, with no reported branch; then reported under the same name.
      expectOk(await h!.call('declare_shared_changes', { id: 'GF-228', none: true, branches: [] }));
      await hostGitPass(h!.server, { home: tmp!.dir });
      await api('POST', '/api/projects/GF/radar/run', {});
      expect((await api('GET', '/api/items/GF-228/shared')).body.branches).toMatchObject({
        discovered: 'gf-228-old',
      });
      expectOk(
        await h!.call('declare_shared_changes', {
          id: 'GF-228',
          none: true,
          branches: ['gf-228-old'],
        }),
      );
      await hostGitPass(h!.server, { home: tmp!.dir });
      await api('POST', '/api/projects/GF/radar/run', {});
      await remove(api);
      const open = sql()
        .prepare(
          "SELECT count(*) AS n FROM radar_findings WHERE branch_a = 'gf-228-old' AND cleared_at IS NULL",
        )
        .get() as { n: number };
      expect(open.n).toBe(0);
    },
    60_000,
  );

  it.skipIf(!HAS_GIT)(
    'Remind the agent posts the explanation as an owner note, and Undo takes it back',
    async () => {
      const api = await gameflow();
      await hostGitPass(h!.server, { home: tmp!.dir });
      await api('POST', '/api/projects/GF/radar/run', {});
      const row = radarRows((await needsYou(api)).problems).find((p) => p.item_id === 'GF-302')!;
      const text = reminderText(row.explanation!);
      expect(text).toBe(
        "Reminder from Docket's Problems: GF-302's branch stale-302 is out of date with main: 1 file conflicts (shell.txt). Rebase it onto main, or split it into short story PRs. If it's an old draft, remove it from GF-302's branches.",
      );
      const posted = await api('POST', '/api/items/GF-302/notes', { text });
      expect(posted.status).toBe(200);
      const count = () =>
        (
          sql()
            .prepare(
              "SELECT count(*) AS n FROM owner_notes WHERE item_id = ? AND text LIKE 'Reminder%'",
            )
            .get('GF-302') as { n: number }
        ).n;
      expect(count()).toBe(1);
      expect(
        (await api('POST', `/api/mutations/${posted.body.mutation_id as string}/undo`)).status,
      ).toBe(200);
      expect(count()).toBe(0);
    },
    60_000,
  );
});

describe('Acknowledge and proposed resolutions (decision 37)', () => {
  it.skipIf(!HAS_GIT)(
    'Acknowledge leaves Needs you (undoable); a proposal brings it back; a different way, again, approve',
    async () => {
      const api = await gameflow();
      await hostGitPass(h!.server, { home: tmp!.dir });
      await api('POST', '/api/projects/GF/radar/run', {});
      const pick = async () =>
        radarRows((await needsYou(api)).problems).find(
          (p) => p.item_id === 'GF-228' && p.related.length === 0,
        );
      const problem = (await pick())!;
      const id = problem.id!;
      expect(id).toMatch(/^rdf_/);

      // Acknowledge: it leaves Needs you, and the item's banner still has it.
      const ack = await api('POST', '/api/problems/acknowledge', { problem_id: id });
      expect(ack.status, JSON.stringify(ack.body)).toBe(200);
      expect(ack.body.acknowledged).toEqual({ by: 'owner', at: '2026-11-06T11:00:00.000Z' });
      expect(await pick()).toBeUndefined();
      let view = await needsYou(api);
      expect((view.acknowledged as Problem[]).map((p) => p.id)).toContain(id);
      const detail = (await api('GET', '/api/items/GF-228')).body as { problems: Problem[] };
      expect(detail.problems.find((p) => p.id === id)?.acknowledged).toEqual({
        by: 'owner',
        at: '2026-11-06T11:00:00.000Z',
      });
      // Undo: it is back.
      expect(
        (await api('POST', `/api/mutations/${ack.body.mutation_id as string}/undo`)).status,
      ).toBe(200);
      expect((await pick())?.id).toBe(id);
      await api('POST', '/api/problems/acknowledge', { problem_id: id });
      expect(await pick()).toBeUndefined();
      expect((await api('POST', '/api/problems/acknowledge', { problem_id: 'nope' })).status).toBe(
        404,
      );

      // A proposal arrives after the acknowledgement: the problem comes back, with a card.
      h!.server.clock.advance(60_000);
      const proposed = expectOk(
        await h!.call('propose_resolution', {
          problem: id,
          kind: 'split',
          plan_md: '1. Land the shell tokens as one story.\n2. Rebase the rest.',
          reason: 'The branch is 53 files behind main.',
        }),
      );
      const first = (proposed.structured.resolution as { id: string }).id;
      expect(proposed.text).toBe(
        `Proposed split for GF-228 (${id}) · ${first} · waiting for the owner`,
      );
      view = await needsYou(api);
      expect((await pick())?.resolution).toMatchObject({ id: first, state: 'open' });
      expect((view.resolutions as { id: string }[]).map((x) => x.id)).toEqual([first]);
      const boot = (await api('GET', '/api/bootstrap')).body as { counts: { for_you: number } };
      expect(boot.counts.for_you).toBeGreaterThanOrEqual(1);

      // Go a different way: a note is required; it reaches the item; the problem stays open.
      expect(
        (await api('POST', `/api/resolutions/${first}/decide`, { decision: 'different' })).status,
      ).toBe(400);
      const different = await api('POST', `/api/resolutions/${first}/decide`, {
        decision: 'different',
        note: 'Keep the epic whole; rebase it in two passes.',
      });
      expect(different.status, JSON.stringify(different.body)).toBe(200);
      expect(different.body.resolution).toMatchObject({ state: 'different', decided_by: 'owner' });
      expect(await pick()).toBeUndefined(); // the decision counts as acknowledging it
      view = await needsYou(api);
      expect(view.resolutions).toEqual([]);
      expect((view.acknowledged as Problem[]).map((p) => p.id)).toContain(id);
      let ctx = expectOk(await h!.call('get_context', { id: 'GF-228' })).text;
      expect(ctx).toContain(
        `- ${first} split for ${id} · go a different way; propose again · owner: Keep the epic whole; rebase it in two passes.`,
      );
      const item = expectOk(await h!.call('get_item', { id: 'GF-228' })).text;
      expect(item).toContain(
        `Not this way (${first}): Keep the epic whole; rebase it in two passes.`,
      );
      // Deciding it again is a conflict.
      expect(
        (await api('POST', `/api/resolutions/${first}/decide`, { decision: 'approve' })).status,
      ).toBe(409);

      // The agent proposes again: back on Needs you; Approve.
      h!.server.clock.advance(60_000);
      const again = expectOk(
        await h!.call('propose_resolution', {
          problem: id,
          id: 'GF-228',
          kind: 'reorder',
          plan_md: '1. Rebase onto main in two passes.',
          reason: 'As you asked.',
        }),
      );
      const second = (again.structured.resolution as { id: string }).id;
      expect((await pick())?.resolution).toMatchObject({ id: second, state: 'open' });
      const approved = await api('POST', `/api/resolutions/${second}/decide`, {
        decision: 'approve',
      });
      expect(approved.status).toBe(200);
      expect(await pick()).toBeUndefined();
      ctx = expectOk(await h!.call('get_context', { id: 'GF-228' })).text;
      expect(ctx).toContain(`- ${second} reorder for ${id} · approved: go ahead`);
      expect(
        (
          sql()
            .prepare("SELECT summary FROM events WHERE type = 'resolution.decided' ORDER BY seq")
            .all() as { summary: string }[]
        ).map((e) => e.summary),
      ).toEqual([
        "You asked for a different way on claude's proposal to split the work on GF-228: Keep the epic whole; rebase it in two passes.",
        "You approved claude's proposal to change the order of work on GF-228",
      ]);
    },
    60_000,
  );

  it('propose_resolution about an item in general; a newer one replaces an open one; bad input is refused', async () => {
    h = await startHarness();
    const api = await owner();
    const one = expectOk(
      await h.call('propose_resolution', {
        id: 'RCP-14',
        kind: 'rescope',
        plan_md: 'Drop the units table from this ticket.',
        reason: 'It belongs to RCP-18.',
      }),
    );
    const firstId = (one.structured.resolution as { id: string }).id;
    expect(one.structured.resolution).toMatchObject({ problem_id: null, state: 'open' });
    const two = expectOk(
      await h.call('propose_resolution', {
        id: 'RCP-14',
        kind: 'other',
        plan_md: 'Ask the owner first.',
        reason: 'Second thoughts.',
      }),
    );
    expect(two.structured.superseded).toEqual([firstId]);
    expect(two.text).toContain(`replaces ${firstId}`);
    const detail = (await api('GET', '/api/items/RCP-14')).body as {
      resolutions: { kind: string }[];
    };
    expect(detail.resolutions.map((x) => x.kind)).toEqual(['other']);
    // Acknowledge (fine, proceed) on an item-level proposal.
    const id2 = (two.structured.resolution as { id: string }).id;
    const ackd = await api('POST', `/api/resolutions/${id2}/decide`, { decision: 'acknowledge' });
    expect(ackd.body.resolution).toMatchObject({ state: 'acknowledged' });

    expectToolError(
      await h.call('propose_resolution', { kind: 'split', plan_md: 'x', reason: 'y' }),
      'validation',
    );
    expectToolError(
      await h.call('propose_resolution', {
        problem: 'stale_run:run_nope',
        kind: 'split',
        plan_md: 'x',
        reason: 'y',
      }),
      'not_found',
    );
  });
});
