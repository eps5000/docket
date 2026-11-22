/**
 * US14 contract, drift: the SC-017 drift suite (tasks.md T161; owner decision
 * 30; FR-131–FR-133; BUILD_SPEC §5.19), through the official MCP client SDK
 * and the owner's UI API, with a temporary push folder:
 * - **push:** install, hand-edit, and the scheduled check (a short interval
 *   here) finds it within one interval; a check never writes in the folder,
 *   and a quiet check writes nothing to the database;
 * - **agent reports:** install, hand-edit, then `claim_lead` with the
 *   `docket-check` report finds it; the run shows "edited locally";
 * - **remedies:** *Adopt* (undoable), *Restore* (push rewrites the files; a
 *   command install returns the command), *Keep local* (the same hash stays
 *   quiet, a new hash alerts again);
 * - missing and extra files, unknown files (listed, never a problem), a
 *   report without an install, and hashes in upper case.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { driftCheckOnce, startDriftCheck } from '../../src/jobs/sweeper.js';
import { tempDir, type TempDir } from '../helpers.js';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import { expectOk, startHarness, tokens, type ContractHarness } from './harness.js';

type S = Record<string, unknown>;

let h: ContractHarness | undefined;
let tmp: TempDir | undefined;
afterEach(async () => {
  await h?.close();
  tmp?.cleanup();
  h = undefined;
  tmp = undefined;
});

const WORKER = 'skill:docket-worker';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A seeded harness with the shipped files, a temporary push folder, and the owner's API. */
async function start(opts: { push?: boolean } = { push: true }) {
  tmp = tempDir('docket-us14-drift-');
  const root = join(tmp.dir, 'code');
  mkdirSync(join(root, 'recipes'), { recursive: true });
  h = await startHarness({
    env: opts.push === false ? {} : { DOCKET_PUSH_ROOT: root },
    log: () => {},
  });
  syncBundledFiles(h.server.runtime);
  const app = h.server.app;
  const req = (path: string, init?: RequestInit) =>
    Promise.resolve(app.request(`${ORIGIN}${path}`, init));
  const res = await req('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: h.server.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  const cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${cookies.docket_csrf!.value}`;
  const owner = async (method: string, path: string, body?: unknown) => {
    const r = await req(path, {
      method,
      headers: {
        cookie,
        ...(method === 'GET' ? {} : { 'x-docket-csrf': cookies.docket_csrf!.value }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as S };
  };
  const repo = join(root, 'recipes');
  return { owner, root, repo };
}

type Owner = Awaited<ReturnType<typeof start>>['owner'];

async function pushInstall(owner: Owner): Promise<string> {
  const r = await owner('POST', '/api/installs', {
    client: 'claude',
    target_kind: 'repo',
    project: 'RCP',
    path: 'recipes',
    method: 'push',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.install_id as string;
}

const openDrift = async (owner: Owner) =>
  ((await owner('GET', '/api/drift?state=open')).body.drift as S[]) ?? [];

const workerPath = (repo: string) => join(repo, '.claude/skills/docket-worker/SKILL.md');

/** Every file under `dir` with its bytes and mtime: a check must leave them all as they were. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(p, `${statSync(p).mtimeMs}:${sha256(readFileSync(p, 'latin1'))}`);
    }
  };
  walk(dir);
  return out;
}

const eventCount = () =>
  (h!.server.runtime.db.sqlite.prepare('SELECT count(*) AS n FROM events').get() as { n: number })
    .n;

/** The docket-check report for `repo`, as the installed script prints it. */
function checkReport(repo: string, opts: { withText?: string[] } = {}) {
  const manifest = JSON.parse(
    readFileSync(join(repo, '.claude/.docket-manifest.json'), 'utf8'),
  ) as { install_id: string; files: { key: string; path: string; sha256: string }[] };
  // Like docket-check, a report leaves out the installed scripts (decision 40).
  const reported = manifest.files.filter((f) => !f.key.startsWith('script:'));
  const files = reported.flatMap((f) => {
    // docket-check leaves the connection file out (decision 32).
    if (f.key === 'connection') return [];
    let text: string;
    try {
      text = readFileSync(join(repo, f.path), 'utf8').replace(/\r/g, '');
    } catch {
      return [];
    }
    if (f.key === 'agents_block') {
      const m = /<!-- docket:begin -->\n([\s\S]*?)\n<!-- docket:end -->/.exec(text);
      if (!m) return [];
      text = m[1]!;
    }
    const sha = sha256(text);
    return [
      {
        key: f.key,
        sha256: sha,
        ...(sha !== f.sha256 || opts.withText?.includes(f.key) ? { content: text } : {}),
      },
    ];
  });
  return { install_id: manifest.install_id, files };
}

describe('the scheduled push check (SC-017: within one interval)', () => {
  it('finds a hand edit within one interval, never writes in the folder, and is quiet otherwise', async () => {
    const { owner, repo } = await start();
    await pushInstall(owner);
    // A check with nothing changed writes nothing at all.
    const before = eventCount();
    expect((await driftCheckOnce(h!.server.runtime)).drift_ids).toEqual([]);
    expect(eventCount()).toBe(before);

    // Count the scheduled checks, and note which one first recorded drift.
    const drift = h!.server.runtime.services.drift;
    const realCheck = drift.checkPushInstalls;
    const realRecord = drift.recordChecks;
    let started = 0;
    let foundBy: number | null = null;
    drift.checkPushInstalls = (r) => {
      started++;
      return realCheck(r);
    };
    drift.recordChecks = (w, input) => {
      const index = started;
      const out = realRecord(w, input);
      if (out.drift_ids.length > 0 && foundBy === null) foundBy = index;
      return out;
    };
    const INTERVAL = 300;
    const job = startDriftCheck(h!.server.runtime, { intervalMs: INTERVAL });
    try {
      await new Promise((r) => setTimeout(r, 50));
      const edited = `${readFileSync(workerPath(repo), 'utf8')}\n- Hand edit in VS Code.\n`;
      writeFileSync(workerPath(repo), edited);
      const atEdit = started;
      const folder = snapshot(repo);
      const t0 = Date.now();
      let found: S[] = [];
      while (Date.now() - t0 < 20 * INTERVAL && found.length === 0) {
        await new Promise((r) => setTimeout(r, 20));
        found = await openDrift(owner);
      }
      const took = Date.now() - t0;
      expect(found, 'detected').toHaveLength(1);
      // Within one interval: the first check that started after the edit found it
      // (wall time is only loosely bounded: a busy test machine delays timers).
      expect(foundBy).not.toBeNull();
      expect(foundBy! - atEdit).toBeLessThanOrEqual(1);
      expect(took).toBeLessThanOrEqual(2 * INTERVAL + 2_000);
      console.log(
        `drift check every ${INTERVAL} ms: found by check ${foundBy! - atEdit} after the edit, ${took} ms later`,
      );
      expect(found[0]).toMatchObject({
        project: 'RCP',
        file_key: WORKER,
        change: 'edited',
        state: 'open',
        local_sha256: sha256(edited),
        local_content: edited,
        install: { client: 'claude', target_kind: 'repo', method: 'push', path: 'recipes' },
        found_by: { source: 'push_check', run_id: null, item_id: null },
      });
      // More checks: still one open record, and the folder is untouched.
      await new Promise((r) => setTimeout(r, 2 * INTERVAL));
      expect(await openDrift(owner)).toHaveLength(1);
      expect(snapshot(repo)).toEqual(folder);

      // Needs you: one Problems row, key fact first, linking to the record.
      const needs = await owner('GET', '/api/needs-you?scope=RCP');
      const row = (needs.body.problems as S[]).find((p) => p.kind === 'agent_files_drift');
      expect(row).toMatchObject({
        item_id: null,
        drift_id: found[0]!.id,
        reason:
          'docket-worker edited outside Docket · Recipe App · recipes · found by the scheduled check',
      });
    } finally {
      job.stop();
    }
  });

  it('is off when the interval is off', async () => {
    tmp = tempDir('docket-us14-drift-');
    h = await startHarness({
      env: { DOCKET_PUSH_ROOT: tmp.dir, DOCKET_DRIFT_CHECK_INTERVAL: 'off' },
    });
    expect(h.server.runtime.config.driftCheckIntervalMs).toBeNull();
    let calls = 0;
    const real = h.server.runtime.services.drift.checkPushInstalls;
    h.server.runtime.services.drift.checkPushInstalls = (r) => {
      calls++;
      return real(r);
    };
    const job = startDriftCheck(h.server.runtime);
    await new Promise((r) => setTimeout(r, 50));
    job.stop();
    expect(calls).toBe(0);
  });
});

describe('the installed docket-wait script (decision 40)', () => {
  const WAIT = 'script:docket-wait.sh';
  const waitPath = (repo: string) => join(repo, '.claude/docket-wait.sh');

  it('an edit is drift: restore or keep it, never adopt it; an agent report leaves it alone', async () => {
    const { owner, repo } = await start();
    await pushInstall(owner);
    expect((await driftCheckOnce(h!.server.runtime)).drift_ids).toEqual([]);

    writeFileSync(waitPath(repo), `${readFileSync(waitPath(repo), 'utf8')}# hand edit\n`);
    await driftCheckOnce(h!.server.runtime);
    const [found] = await openDrift(owner);
    expect(found).toMatchObject({ file_key: WAIT, change: 'edited', state: 'open' });

    const adopt = await owner('POST', `/api/drift/${String(found!.id)}/adopt`, {});
    expect(adopt.status).toBe(400);
    expect(JSON.stringify(adopt.body)).toContain("isn't one of the files Docket ships");

    // An agent's report doesn't cover scripts: it neither closes nor adds a record.
    expectOk(
      await h!.call('claim_lead', {
        id: 'RCP-17',
        agent_label: 'orca-w3',
        instructions: checkReport(repo),
      }),
    );
    expect((await openDrift(owner)).map((d) => d.file_key)).toEqual([WAIT]);

    const restored = await owner('POST', `/api/drift/${String(found!.id)}/restore`, {});
    expect(restored.status).toBe(200);
    expect(readFileSync(waitPath(repo), 'utf8')).not.toContain('# hand edit');
    expect(await openDrift(owner)).toEqual([]);
  });

  it('a deleted script is reported missing', async () => {
    const { owner, repo } = await start();
    await pushInstall(owner);
    rmSync(waitPath(repo));
    await driftCheckOnce(h!.server.runtime);
    expect(await openDrift(owner)).toEqual([
      expect.objectContaining({ file_key: WAIT, change: 'missing' }),
    ]);
  });
});

describe('remedies', () => {
  it('Adopt saves the local text as the project’s copy (undoable), and the same hash stays quiet', async () => {
    const { owner, repo } = await start();
    await pushInstall(owner);
    const edited = `${readFileSync(workerPath(repo), 'utf8')}\n- Adopt me.\n`;
    writeFileSync(workerPath(repo), edited);
    await driftCheckOnce(h!.server.runtime);
    const [d] = await openDrift(owner);
    const ok = await owner('POST', `/api/drift/${d!.id as string}/adopt`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.drift).toMatchObject({ state: 'adopted', resolved_at: expect.any(String) });
    const file = expectOk(await h!.call('get_agent_files', { project: 'RCP', file: WORKER }))
      .structured.files as S[];
    expect(file[0]).toMatchObject({ source: 'project', content: edited });
    const detail = await owner('GET', `/api/agent-files/${encodeURIComponent(WORKER)}?project=RCP`);
    expect(
      (detail.body.layers as { project: { versions: S[] } }).project.versions[0],
    ).toMatchObject({ author: 'owner', note: 'Adopted the local edit from recipes' });
    // The same hash is accepted: the next check raises nothing.
    expect((await driftCheckOnce(h!.server.runtime)).drift_ids).toEqual([]);
    expect(await openDrift(owner)).toEqual([]);

    // Undo: the copy goes, the record is open again.
    const undo = await owner('POST', `/api/mutations/${ok.body.mutation_id as string}/undo`, {});
    expect(undo.status).toBe(200);
    expect((await openDrift(owner)).map((x) => x.id)).toEqual([d!.id]);
  });

  it('Restore reinstalls by push (the files are Docket’s again) and resolves every record of the install', async () => {
    const { owner, repo } = await start();
    const first = await pushInstall(owner);
    const sent = readFileSync(workerPath(repo), 'utf8');
    writeFileSync(workerPath(repo), `${sent}\n- Restore me.\n`);
    rmSync(join(repo, '.claude/skills/docket-planner/SKILL.md'));
    await driftCheckOnce(h!.server.runtime);
    const open = await openDrift(owner);
    expect(open.map((x) => [x.file_key, x.change]).sort()).toEqual([
      ['skill:docket-planner', 'missing'],
      [WORKER, 'edited'],
    ]);
    const r = await owner('POST', `/api/drift/${open[0]!.id as string}/restore`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.install).toMatchObject({ install_id: expect.not.stringMatching(first) });
    expect(readFileSync(workerPath(repo), 'utf8')).toBe(sent);
    expect(statSync(join(repo, '.claude/skills/docket-planner/SKILL.md')).isFile()).toBe(true);
    expect(await openDrift(owner)).toEqual([]);
    expect((await driftCheckOnce(h!.server.runtime)).drift_ids).toEqual([]);
    // Not undoable.
    const undo = await owner('POST', `/api/mutations/${r.body.mutation_id as string}/undo`, {});
    expect(undo.status).toBe(400);
  });

  it('missing and extra files: Adopt refuses missing, Restore refuses extra, Keep local takes both', async () => {
    const { owner, repo } = await start();
    await pushInstall(owner);
    rmSync(join(repo, '.claude/skills/docket-planner/SKILL.md'));
    mkdirSync(join(repo, '.claude/skills/docket-old'));
    writeFileSync(join(repo, '.claude/skills/docket-old/SKILL.md'), '# Old skill\n');
    mkdirSync(join(repo, '.claude/skills/my-own-skill'));
    await driftCheckOnce(h!.server.runtime);
    const open = await openDrift(owner);
    const missing = open.find((x) => x.change === 'missing')!;
    const extra = open.find((x) => x.change === 'extra')!;
    expect(open).toHaveLength(2);
    expect(missing).toMatchObject({ file_key: 'skill:docket-planner', local_sha256: null });
    expect(extra).toMatchObject({
      file_key: 'skill:docket-old',
      local_sha256: sha256('# Old skill\n'),
      local_content: '# Old skill\n',
      sent_version_id: null,
    });
    const adopt = await owner('POST', `/api/drift/${missing.id as string}/adopt`, {});
    expect(adopt.status).toBe(400);
    const restore = await owner('POST', `/api/drift/${extra.id as string}/restore`, {});
    expect(restore.status).toBe(400);
    expect((restore.body.error as S).message).toContain('Docket never deletes files');
    for (const d of open) {
      expect((await owner('POST', `/api/drift/${d.id as string}/keep-local`, {})).status).toBe(200);
    }
    expect(await openDrift(owner)).toEqual([]);
    expect((await driftCheckOnce(h!.server.runtime)).drift_ids).toEqual([]);
  });
});

/** Every text value in the database, to prove a secret was never stored. */
function wholeDatabase(): string {
  const sql = h!.server.runtime.db.sqlite;
  const tables = sql
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return tables
    .map((t) => JSON.stringify(sql.prepare(`SELECT * FROM "${t.name}"`).all()))
    .join('\n');
}

describe('a secret in a reported file never blocks claiming', () => {
  const SECRET = `ghp_${'Z'.repeat(36)}`;

  it('claim_lead succeeds; the text is withheld and never stored; the entry says why; Adopt is refused with it', async () => {
    const { owner, repo } = await start();
    await pushInstall(owner);
    const edited = `${readFileSync(workerPath(repo), 'utf8')}\n- Push with ${SECRET} (pasted by mistake).\n`;
    writeFileSync(workerPath(repo), edited);
    const report = checkReport(repo);
    expect(report.files.find((f) => f.key === WORKER)).toMatchObject({ content: edited });

    const claim = await h!.call('claim_lead', {
      id: 'RCP-17',
      agent_label: 'orca-w3',
      instructions: report,
      idempotency_key: 'claim-with-secret-1',
    });
    const ok = expectOk(claim);
    expect(ok.structured.run_id).toMatch(/^run_/);

    // Nothing anywhere holds the text: the report, drift, events, idempotency.
    expect(wholeDatabase()).not.toContain(SECRET);
    expect(wholeDatabase()).not.toContain('pasted by mistake');
    const stored = JSON.parse(
      (
        h!.server.runtime.db.sqlite
          .prepare('SELECT files FROM instruction_reports WHERE run_id = ?')
          .get(ok.structured.run_id) as { files: string }
      ).files,
    ) as Record<string, S>;
    expect(stored[WORKER]).toEqual({ sha256: sha256(edited), withheld: 'secret' });

    // The drift entry keeps the hash and says why the text is missing.
    const [d] = await openDrift(owner);
    expect(d).toMatchObject({
      file_key: WORKER,
      change: 'edited',
      local_sha256: sha256(edited),
      local_content: null,
      content_withheld: 'secret',
    });
    const adopt = await owner('POST', `/api/drift/${d!.id as string}/adopt`, {});
    expect(adopt.status).toBe(400);
    expect((adopt.body.error as S).message).toContain(
      'Content withheld: the local text of docket-worker looked like a secret',
    );
    expect(JSON.stringify(adopt.body)).not.toContain(SECRET);
    // The other remedies still work.
    expect((await owner('POST', `/api/drift/${d!.id as string}/keep-local`, {})).status).toBe(200);
  });

  it('the push check withholds it the same way', async () => {
    const { owner, repo } = await start();
    await pushInstall(owner);
    writeFileSync(
      workerPath(repo),
      `${readFileSync(workerPath(repo), 'utf8')}\n- Token: ${SECRET}\n`,
    );
    expect((await driftCheckOnce(h!.server.runtime)).drift_ids).toHaveLength(1);
    const [d] = await openDrift(owner);
    expect(d).toMatchObject({ local_content: null, content_withheld: 'secret' });
    expect(wholeDatabase()).not.toContain(SECRET);
  });

  it('a file without a secret still carries its text (content_withheld is null)', async () => {
    const { owner, repo } = await start();
    await pushInstall(owner);
    writeFileSync(workerPath(repo), `${readFileSync(workerPath(repo), 'utf8')}\n- Fine.\n`);
    expectOk(await h!.call('claim_lead', { id: 'RCP-17', instructions: checkReport(repo) }));
    const [d] = await openDrift(owner);
    expect(d).toMatchObject({ content_withheld: null });
    expect(d!.local_content).toContain('- Fine.');
  });
});

describe('agent reports on claim_lead (SC-017: by the next claim)', () => {
  it('finds a hand edit on the next claim; Keep local keeps that hash quiet; a new edit alerts again', async () => {
    // A command-style install: no push folder, so only agents can report.
    const { owner, repo } = await start();
    await pushInstall(owner);
    const edited = `${readFileSync(workerPath(repo), 'utf8')}\n- Hand edit.\n`;
    writeFileSync(workerPath(repo), edited);
    const report = checkReport(repo);
    // Only the edited file carries its text.
    expect(report.files.filter((f) => 'content' in f).map((f) => f.key)).toEqual([WORKER]);
    const claim = expectOk(
      await h!.call('claim_lead', {
        id: 'RCP-17',
        agent_label: 'orca-w3',
        workspace: { path: 'C:/work/rcp-17', branch: 'rcp-17' },
        instructions: report,
      }),
    );
    // Token cost (B27 constraint): a typical claim (nothing edited) carries hashes only.
    const base = { id: 'RCP-17', agent_label: 'orca-w3', workspace: { path: 'C:/work/rcp-17' } };
    const typical = {
      install_id: report.install_id,
      files: report.files.map((f) => ({ key: f.key, sha256: f.sha256 })),
    };
    const sizes = {
      without: JSON.stringify(base),
      typical: JSON.stringify({ ...base, instructions: typical }),
      edited: JSON.stringify({ ...base, instructions: report }),
    };
    console.log(
      [
        '| claim_lead arguments | characters | tokens (÷ 4) |',
        '|---|---:|---:|',
        `| without instructions | ${sizes.without.length} | ${tokens(sizes.without)} |`,
        `| with instructions, 6 files, none edited (typical) | ${sizes.typical.length} | ${tokens(sizes.typical)} |`,
        `| with instructions, docket-worker edited (its ${edited.length}-character text included) | ${sizes.edited.length} | ${tokens(sizes.edited)} |`,
      ].join('\n'),
    );
    expect(tokens(sizes.typical) - tokens(sizes.without)).toBeLessThanOrEqual(250);
    const runId = claim.structured.run_id as string;
    const [d] = await openDrift(owner);
    expect(d).toMatchObject({
      file_key: WORKER,
      change: 'edited',
      local_content: edited,
      found_by: {
        source: 'agent',
        run_id: runId,
        item_id: 'RCP-17',
        client: 'claude',
        label: 'orca-w3',
      },
    });
    // The run shows which instructions it worked from, edited locally flagged.
    const item = await owner('GET', '/api/items/RCP-17');
    const ri = (item.body.run_instructions as S[])[0]!;
    expect(ri).toMatchObject({ run_id: runId, install_id: report.install_id });
    const files = ri.files as S[];
    expect(files[0]).toEqual({
      key: WORKER,
      name: 'docket-worker',
      source: 'default',
      version_no: 1,
      edited_locally: true,
      drift_id: d!.id,
    });
    expect(files.filter((f) => f.edited_locally)).toHaveLength(1);
    // The problem names who reported it.
    const needs = await owner('GET', '/api/needs-you?scope=all');
    expect((needs.body.problems as S[]).find((p) => p.drift_id === d!.id)?.reason).toBe(
      'docket-worker edited outside Docket · Recipe App · recipes · reported by claude · orca-w3 on RCP-17',
    );

    // Keep local: the same hash, reported again, raises nothing.
    expect((await owner('POST', `/api/drift/${d!.id as string}/keep-local`, {})).status).toBe(200);
    expectOk(await h!.call('release_lead', { id: 'RCP-17', run_id: runId, reason: 'test' }));
    expectOk(await h!.call('claim_lead', { id: 'RCP-17', instructions: checkReport(repo) }));
    expect(await openDrift(owner)).toEqual([]);

    // A further edit alerts again.
    writeFileSync(workerPath(repo), `${edited}- And another.\n`);
    const again = expectOk(
      await h!.call('claim_lead', { id: 'RCP-25', instructions: checkReport(repo) }),
    );
    expect(again.structured.run_id).toBeTruthy();
    const reopened = await openDrift(owner);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.id).not.toBe(d!.id);
  });

  it('upper-case hashes compare equal; unknown files are listed, never a problem; no install raises nothing', async () => {
    const { owner, repo } = await start();
    await pushInstall(owner);
    const report = checkReport(repo);
    const upper = {
      install_id: report.install_id,
      files: [
        ...report.files.map((f) => ({ key: f.key, sha256: f.sha256.toUpperCase() })),
        { key: 'skill:my-own', sha256: 'a'.repeat(64) },
      ],
    };
    const claim = expectOk(await h!.call('claim_lead', { id: 'RCP-17', instructions: upper }));
    expect(await openDrift(owner)).toEqual([]);
    const item = await owner('GET', '/api/items/RCP-17');
    const files = ((item.body.run_instructions as S[])[0]!.files as S[]).filter(
      (f) => f.key === 'skill:my-own',
    );
    expect(files).toEqual([
      {
        key: 'skill:my-own',
        name: 'my-own',
        source: null,
        version_no: null,
        edited_locally: false,
        drift_id: null,
      },
    ]);
    const stored = h!.server.runtime.db.sqlite
      .prepare('SELECT * FROM instruction_reports WHERE run_id = ?')
      .get(claim.structured.run_id) as S;
    expect(stored).toMatchObject({
      source: 'agent',
      install_id: report.install_id,
      project_key: 'RCP',
    });

    // Without an install: stored on the run and shown, but no drift.
    const noInstall = expectOk(
      await h!.call('claim_lead', {
        id: 'RCP-25',
        instructions: { files: [{ key: WORKER, sha256: 'b'.repeat(64), content: '# mine\n' }] },
      }),
    );
    expect(await openDrift(owner)).toEqual([]);
    const ri = ((await owner('GET', '/api/items/RCP-25')).body.run_instructions as S[])[0]!;
    expect(ri).toMatchObject({ run_id: noInstall.structured.run_id, install_id: null });
    expect(ri.files).toEqual([
      {
        key: WORKER,
        name: 'docket-worker',
        source: null,
        version_no: null,
        edited_locally: false,
        drift_id: null,
      },
    ]);
  });

  it('a report that matches again resolves the open record', async () => {
    const { owner, repo } = await start();
    await pushInstall(owner);
    const sent = readFileSync(workerPath(repo), 'utf8');
    writeFileSync(workerPath(repo), `${sent}\n- Temporary.\n`);
    const c1 = expectOk(
      await h!.call('claim_lead', { id: 'RCP-17', instructions: checkReport(repo) }),
    );
    expect(await openDrift(owner)).toHaveLength(1);
    writeFileSync(workerPath(repo), sent);
    expectOk(
      await h!.call('release_lead', {
        id: 'RCP-17',
        run_id: c1.structured.run_id,
        reason: 'test',
      }),
    );
    expectOk(await h!.call('claim_lead', { id: 'RCP-17', instructions: checkReport(repo) }));
    expect(await openDrift(owner)).toEqual([]);
    const all = (await owner('GET', '/api/drift')).body.drift as S[];
    expect(all.map((x) => x.state)).toEqual(['restored']);
  });

  it('a command install: Restore returns the command, and Adopt without text says how to send it', async () => {
    const { owner } = await start({ push: false });
    const created = await owner('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      method: 'command',
    });
    const installId = created.body.install_id as string;
    // The agent's report says the worker was edited, without its text.
    expectOk(
      await h!.call('claim_lead', {
        id: 'RCP-17',
        instructions: { install_id: installId, files: [{ key: WORKER, sha256: 'c'.repeat(64) }] },
      }),
    );
    const open = await openDrift(owner);
    const worker = open.find((x) => x.file_key === WORKER)!;
    expect(worker.local_content).toBeNull();
    const adopt = await owner('POST', `/api/drift/${worker.id as string}/adopt`, {});
    expect(adopt.status).toBe(400);
    expect((adopt.body.error as S).message).toContain('Run docket-check on that machine');
    const r = await owner('POST', `/api/drift/${worker.id as string}/restore`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body.install as S).command).toMatchObject({
      bash: expect.stringContaining('/install/'),
      powershell: expect.stringContaining('/install/'),
    });
    expect(r.body.drift).toMatchObject({ state: 'restored' });
    expect(await openDrift(owner)).toEqual([]);
  });
});
