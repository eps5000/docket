/**
 * B28, the rename to Docket (formerly Task Lite): what was installed or
 * configured before the rename keeps working. Through the official MCP
 * client SDK and the owner's UI API, with a temporary push folder:
 * - **push install into a folder from before the rename:** the old
 *   `<!-- tasklite:begin/end -->` section is replaced with the docket
 *   markers; the `tasklite-*` skill folders the old manifest recorded are
 *   removed while unmodified, and an edited one is kept and reported; a
 *   folder no manifest recorded, the old manifest and the old check script
 *   are never touched;
 * - **drift:** the kept folder is "old name, edited locally": *Restore* is
 *   refused, *Adopt* saves it as the docket-* file (its frontmatter name
 *   updated), *Keep local* accepts it;
 * - **old keys from agents:** a report from an install made before the rename
 *   (`skill:tasklite-*`, folders recorded as `installed_as`) and a proposal
 *   with an old key are mapped.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_BEGIN, LEGACY_END } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { mapReportKeys } from '../../src/domain/drift.js';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { driftCheckOnce } from '../../src/jobs/sweeper.js';
import { tempDir, type TempDir } from '../helpers.js';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import { expectOk, startHarness, type ContractHarness } from './harness.js';

type S = Record<string, unknown>;

let h: ContractHarness | undefined;
let tmp: TempDir | undefined;
afterEach(async () => {
  await h?.close();
  tmp?.cleanup();
  h = undefined;
  tmp = undefined;
});

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A seeded harness with the shipped files, a temporary push folder, and the owner's API. */
async function start() {
  tmp = tempDir('docket-b28-');
  const root = join(tmp.dir, 'code');
  mkdirSync(join(root, 'recipes'), { recursive: true });
  h = await startHarness({ env: { DOCKET_PUSH_ROOT: root }, log: () => {} });
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
  return { owner, repo: join(root, 'recipes') };
}

const OLD_WORKER = '---\nname: tasklite-worker\ndescription: Old worker.\n---\n# Worker\n';
const OLD_PLANNER = '---\nname: tasklite-planner\ndescription: Old planner.\n---\n# Planner\n';
const OLD_BLOCK = '## Work tracking: the old name\nUse the tasklite-worker skill.';
const PRE = '# Recipes\n\nOur own rules.\n';
const POST = '\nAfter the section: also ours.\n';

/**
 * A repo as an install from before the rename left it: two recorded skill
 * folders, the old manifest and check script, and the old marked section.
 * A third folder was never recorded.
 */
function oldInstall(repo: string): void {
  const skill = (name: string, text: string) => {
    mkdirSync(join(repo, '.claude/skills', name), { recursive: true });
    writeFileSync(join(repo, '.claude/skills', name, 'SKILL.md'), text);
  };
  skill('tasklite-worker', OLD_WORKER);
  skill('tasklite-planner', OLD_PLANNER);
  skill('tasklite-mine', '# Not installed by anyone\n');
  const line = (key: string, path: string, text: string) =>
    `    ${JSON.stringify({ key, path, version_id: 'afv_old', sha256: sha256(text) })}`;
  writeFileSync(
    join(repo, '.claude/.tasklite-manifest.json'),
    [
      '{',
      '  "install_id": "ins_old",',
      '  "files": [',
      `${line('skill:tasklite-worker', '.claude/skills/tasklite-worker/SKILL.md', OLD_WORKER)},`,
      `${line('skill:tasklite-planner', '.claude/skills/tasklite-planner/SKILL.md', OLD_PLANNER)},`,
      line('agents_block', 'CLAUDE.md', OLD_BLOCK),
      '  ]',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(repo, '.claude/tasklite-check.sh'), '# the old check\n');
  writeFileSync(
    join(repo, 'CLAUDE.md'),
    `${PRE}${LEGACY_BEGIN}\n${OLD_BLOCK}\n${LEGACY_END}${POST}`,
  );
}

const openDrift = async (owner: Awaited<ReturnType<typeof start>>['owner']) =>
  ((await owner('GET', '/api/drift?state=open')).body.drift as S[]) ?? [];

describe('a push install into a folder from before the rename', () => {
  it('replaces the old section, removes unmodified recorded folders, keeps and reports the edited one', async () => {
    const { owner, repo } = await start();
    oldInstall(repo);
    // Edited locally after the old install.
    const editedPlanner = `${OLD_PLANNER}\n- Our own planning rule.\n`;
    writeFileSync(join(repo, '.claude/skills/tasklite-planner/SKILL.md'), editedPlanner);

    const r = await owner('POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      path: 'recipes',
      method: 'push',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const changes = (r.body.result as { files: { path: string; change: string }[] }).files;
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: '.claude/skills/tasklite-worker/', change: 'removed' },
        { path: '.claude/skills/tasklite-planner/', change: 'kept_edited' },
        { path: 'CLAUDE.md', change: 'updated' },
        { path: '.claude/skills/docket-worker/SKILL.md', change: 'created' },
      ]),
    );

    // The old section is replaced with the docket markers; nothing outside it changed.
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    expect(claude.startsWith(`${PRE}<!-- docket:begin -->\n`)).toBe(true);
    expect(claude.endsWith(`<!-- docket:end -->${POST}`)).toBe(true);
    expect(claude).not.toContain('tasklite:begin');
    expect(claude).not.toContain(OLD_BLOCK);

    // Only the unmodified recorded folder went; everything else is still there.
    const skills = readdirSync(join(repo, '.claude/skills')).sort();
    expect(skills).not.toContain('tasklite-worker');
    expect(skills).toEqual(expect.arrayContaining(['tasklite-planner', 'tasklite-mine']));
    expect(readFileSync(join(repo, '.claude/skills/tasklite-planner/SKILL.md'), 'utf8')).toBe(
      editedPlanner,
    );
    expect(existsSync(join(repo, '.claude/.tasklite-manifest.json'))).toBe(true);
    expect(existsSync(join(repo, '.claude/tasklite-check.sh'))).toBe(true);
    expect(existsSync(join(repo, '.claude/.docket-manifest.json'))).toBe(true);

    // The scheduled check reports both old folders the new manifest doesn't list.
    await driftCheckOnce(h!.server.runtime);
    const open = await openDrift(owner);
    expect(open.map((d) => [d.file_key, d.change]).sort()).toEqual([
      ['skill:tasklite-mine', 'extra'],
      ['skill:tasklite-planner', 'extra'],
    ]);
    const planner = open.find((d) => d.file_key === 'skill:tasklite-planner')!;
    // Compared with the file it was renamed to.
    expect(planner).toMatchObject({
      local_content: editedPlanner,
      sent_version_id: expect.stringMatching(/^afv_/),
    });
    const needs = await owner('GET', '/api/needs-you?scope=RCP');
    const reasons = (needs.body.problems as S[])
      .filter((p) => p.kind === 'agent_files_drift')
      .map((p) => p.reason);
    expect(reasons).toContain(
      'tasklite-planner (old name, edited locally) outside Docket · Recipe App · recipes · found by the scheduled check',
    );

    // Restore can't remove an edited folder; Adopt saves it as docket-planner.
    const restore = await owner('POST', `/api/drift/${planner.id as string}/restore`, {});
    expect(restore.status).toBe(400);
    expect((restore.body.error as S).message).toContain('only while it is unmodified');
    const adopt = await owner('POST', `/api/drift/${planner.id as string}/adopt`, {});
    expect(adopt.status, JSON.stringify(adopt.body)).toBe(200);
    const file = expectOk(
      await h!.call('get_agent_files', { project: 'RCP', file: 'skill:docket-planner' }),
    ).structured.files as S[];
    expect(file[0]).toMatchObject({
      key: 'skill:docket-planner',
      source: 'project',
      content: editedPlanner.replace('name: tasklite-planner', 'name: docket-planner'),
    });
    // Keep local accepts the other one; the next check is quiet.
    const mine = open.find((d) => d.file_key === 'skill:tasklite-mine')!;
    expect((await owner('POST', `/api/drift/${mine.id as string}/keep-local`, {})).status).toBe(
      200,
    );
    expect(await openDrift(owner)).toEqual([]);
  });
});

describe('old keys from agents', () => {
  it('maps a report from an install made before the rename, and keeps a leftover folder as extra', () => {
    const migrated = {
      'skill:docket-worker': { version_id: 'afv_1', sha256: 'a', installed_as: 'tasklite-worker' },
    };
    const fresh = { 'skill:docket-worker': { version_id: 'afv_2', sha256: 'b' } };
    const old = [{ key: 'skill:tasklite-worker', sha256: 'a' }];
    // An old check script on an old install: the key is the renamed file.
    expect(mapReportKeys(old, migrated)).toEqual([{ key: 'skill:docket-worker', sha256: 'a' }]);
    // No install known: mapped unless the report also has the new key.
    expect(mapReportKeys(old, undefined)).toEqual([{ key: 'skill:docket-worker', sha256: 'a' }]);
    // A new install that also wrote docket-worker: the old folder stays itself (extra).
    const both = [{ key: 'skill:docket-worker', sha256: 'b' }, ...old];
    expect(mapReportKeys(both, fresh)).toEqual(both);
  });

  it('accepts a proposal that still names skill:tasklite-*, as the docket-* file', async () => {
    await start();
    const before = expectOk(
      await h!.call('get_agent_files', { project: 'RCP', file: 'skill:tasklite-worker' }),
    ).structured.files as S[];
    expect(before[0]).toMatchObject({ key: 'skill:docket-worker' });
    const r = expectOk(
      await h!.call('propose_agent_file_change', {
        project: 'RCP',
        file: 'skill:tasklite-worker',
        content: `${before[0]!.content as string}\n- Lint first.\n`,
        reason: 'An agent with the old skill names.',
        based_on_version_id: before[0]!.version_id,
      }),
    );
    const row = h!.server.runtime.db.sqlite
      .prepare('SELECT file_key FROM agent_file_proposals WHERE id = ?')
      .get(r.structured.proposal_id) as { file_key: string };
    expect(row.file_key).toBe('skill:docket-worker');
  });
});
