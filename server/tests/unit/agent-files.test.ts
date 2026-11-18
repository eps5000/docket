/**
 * Agent files and Workflow notes (owner decision 29; BUILD_SPEC §5.17;
 * FR-121–FR-123; tasks.md T153, T157): the bundled load and upgrades, the
 * three layers and their resolution, immutable versions with author and
 * note, `expected_version`, revert, the bundled-updated flag, Workflow notes
 * (versions, clearing), the events and owner undo of each edit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentFileDetail, ToolError } from '@tasklite/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BundledAgentFile, Services } from '../../src/domain/contracts.js';
import { sha256 } from '../../src/domain/agent-files.js';
import { UNDO_WINDOW_MS, undoMutation } from '../../src/domain/undo.js';
import { OWNER_ACTOR, SYSTEM_ACTOR, type WriteContext } from '../../src/domain/write.js';
import {
  DEFAULT_BUNDLED_ROOT,
  readBundledFiles,
  syncBundledFiles,
} from '../../src/jobs/bundled.js';
import { tempDir } from '../helpers.js';
import { addProject, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;

const WORKER = 'skill:tasklite-worker';
const V1: BundledAgentFile[] = [
  { key: WORKER, content: '# Worker\n\nBundled v1.\n' },
  { key: 'skill:tasklite-coordinator', content: '# Coordinator\n' },
  { key: 'agents_block', content: '## Work tracking: Task Lite\n' },
];

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'RCP');
  addProject(d, 'DOC');
  sync(V1);
});
afterEach(() => d.cleanup());

// ---- Helpers ----

function sync(files: BundledAgentFile[]) {
  return d.write(SYSTEM_ACTOR, (w, s) => s.agentFiles.syncBundled(w, { files })).added;
}

/** An owner write that returns its mutation ID too (for undo). */
function owner<T>(fn: (w: WriteContext, s: Services) => T): { result: T; mutation_id: string } {
  const out = d.server.runtime.write.run({ actor: OWNER_ACTOR, operation: 'test', args: {} }, (w) =>
    fn(w, d.services),
  );
  return { result: out.result, mutation_id: out.mutation_id };
}

const put = (
  content: string,
  opts: {
    layer?: 'service' | 'project';
    project?: string;
    expected?: number;
    note?: string;
    key?: string;
  } = {},
) =>
  owner((w, s) =>
    s.agentFiles.put(w, {
      key: opts.key ?? WORKER,
      layer: opts.layer ?? 'service',
      ...(opts.project ? { project: opts.project } : {}),
      content,
      expected_version: opts.expected ?? 0,
      ...(opts.note ? { note: opts.note } : {}),
    }),
  );

const revert = (layer: 'service' | 'project', project?: string, key = WORKER) =>
  owner((w, s) => s.agentFiles.revert(w, { key, layer, ...(project ? { project } : {}) }));

const get = (project?: string, key = WORKER): AgentFileDetail =>
  d.services.agentFiles.get(d.read(OWNER_ACTOR), { key, ...(project ? { project } : {}) });

const row = (project?: string, key = WORKER) =>
  d.services.agentFiles
    .list(d.read(OWNER_ACTOR), project ? { project } : {})
    .files.find((f) => f.key === key)!;

/** The content a project (or the service-wide view) gets. */
function effective(project?: string, key = WORKER): string {
  const detail = get(project, key);
  const layer = detail.layers[detail.effective_layer]!;
  return layer.versions.find((v) => v.version_no === layer.current_version_no)!.content;
}

function fails(fn: () => unknown, code: string): ToolError {
  try {
    fn();
  } catch (err) {
    expect((err as ToolError).code, (err as Error).message).toBe(code);
    return err as ToolError;
  }
  throw new Error(`expected a ${code} error`);
}

const events = (type: string) =>
  d.rows<{
    actor_kind: string;
    summary: string;
    inverse: string | null;
    project_key: string | null;
  }>(
    'SELECT actor_kind, summary, inverse, project_key FROM events WHERE type = ? ORDER BY seq',
    type,
  );

// ---- The bundled layer ----

describe('bundled loading (startup)', () => {
  it('loads every shipped file once, as the system, and adds nothing when nothing changed', () => {
    expect(row().effective_layer).toBe('bundled');
    expect(row().effective).toMatchObject({ version_no: 1, author: 'system' });
    expect(events('agent_file.updated')).toHaveLength(3);
    expect(
      events('agent_file.updated').every((e) => e.actor_kind === 'system' && e.inverse === null),
    ).toBe(true);
    // A restart with the same image: no new versions, no events.
    expect(sync(V1)).toEqual([]);
    expect(events('agent_file.updated')).toHaveLength(3);
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM agent_file_versions').n).toBe(3);
  });

  it('an upgrade with changed content adds a new bundled version for that file only', () => {
    const added = sync([{ ...V1[0]!, content: '# Worker\n\nBundled v2.\n' }, V1[1]!, V1[2]!]);
    expect(added).toEqual([WORKER]);
    const detail = get();
    expect(detail.layers.bundled!.current_version_no).toBe(2);
    expect(detail.layers.bundled!.versions.map((v) => v.version_no)).toEqual([2, 1]);
    expect(effective()).toContain('Bundled v2.');
    expect(events('agent_file.updated').at(-1)!.summary).toBe(
      'Bundled tasklite-worker updated: v2',
    );
  });

  it('a file removed from the image keeps its bundled layer', () => {
    sync([V1[0]!]);
    expect(d.services.agentFiles.list(d.read(), {}).files.map((f) => f.key)).toEqual([
      'skill:tasklite-coordinator',
      WORKER,
      'agents_block',
    ]);
  });

  it('reads the five skills and the AGENTS.md block from the checkout (the image layout)', () => {
    const { files, problems } = readBundledFiles(DEFAULT_BUNDLED_ROOT);
    expect(problems).toEqual([]);
    expect(files.map((f) => f.key).sort()).toEqual([
      'agents_block',
      'skill:tasklite-coordinator',
      'skill:tasklite-lead-subagents',
      'skill:tasklite-planner',
      'skill:tasklite-review-packet',
      'skill:tasklite-worker',
    ]);
    expect(files.find((f) => f.key === 'agents_block')!.content).toContain(
      'Work tracking: Task Lite',
    );
  });

  it('ships a generic AGENTS.md block with no {{…}} placeholders (B25)', () => {
    const { files } = readBundledFiles(DEFAULT_BUNDLED_ROOT);
    const block = files.find((f) => f.key === 'agents_block')!.content;
    expect(block).not.toContain('{{');
    // It points at the worker skill and at the Workflow notes in get_context, and keeps the universal rules.
    for (const rule of [
      '`tasklite-worker`',
      '`get_context`',
      'claim_lead',
      '`run_id`',
      'report_commit',
      'park_run',
      'resources_started',
      'resources_released',
      'ask_owner',
      'release_lead',
    ]) {
      expect(block).toContain(rule);
    }
  });

  it('skips folders that are not valid names and reports missing files', () => {
    const tmp = tempDir();
    try {
      mkdirSync(join(tmp.dir, 'skills', 'Bad_Name'), { recursive: true });
      writeFileSync(join(tmp.dir, 'skills', 'Bad_Name', 'SKILL.md'), '# Bad\n');
      mkdirSync(join(tmp.dir, 'skills', 'good-one'), { recursive: true });
      writeFileSync(join(tmp.dir, 'skills', 'good-one', 'SKILL.md'), '# Good\n');
      mkdirSync(join(tmp.dir, 'skills', 'no-file'), { recursive: true });
      const { files, problems } = readBundledFiles(tmp.dir);
      expect(files.map((f) => f.key)).toEqual(['skill:good-one']);
      expect(problems).toHaveLength(2);
      expect(problems.join('\n')).toMatch(/Bad_Name/);
      expect(problems.join('\n')).toMatch(/AGENTS-tasklite\.md is missing/);
    } finally {
      tmp.cleanup();
    }
  });

  it('syncBundledFiles loads the checkout into a runtime, then is a no-op', () => {
    const lines: string[] = [];
    const rt = { ...d.server.runtime, log: (l: string) => lines.push(l) };
    expect(syncBundledFiles(rt).added).toHaveLength(6);
    expect(syncBundledFiles(rt).added).toEqual([]);
    expect(lines).toEqual([]);
  });
});

// ---- Layers and resolution ----

describe('layers and resolution', () => {
  it('project override, else service-wide edit, else bundled', () => {
    expect(effective('RCP')).toContain('Bundled v1.');

    put('# Worker\n\nService edit.\n', { note: 'Our branch names.' });
    expect(effective()).toContain('Service edit.');
    expect(effective('RCP')).toContain('Service edit.');
    expect(row('RCP').effective_layer).toBe('service');

    put('# Worker\n\nRCP override.\n', { layer: 'project', project: 'RCP' });
    expect(effective('RCP')).toContain('RCP override.');
    expect(row('RCP')).toMatchObject({ effective_layer: 'project' });
    // Other projects and the service-wide view are untouched.
    expect(effective('DOC')).toContain('Service edit.');
    expect(effective()).toContain('Service edit.');
    expect(row().layers.project).toBeNull();
    expect(row('DOC').layers.project).toBeNull();
    // The list row carries each layer's current version.
    expect(row('RCP').layers).toMatchObject({
      bundled: { version_no: 1 },
      service: { version_no: 1 },
      project: { version_no: 1 },
    });
  });

  it('lists skills by name, then the AGENTS.md block, each with its kind and name', () => {
    const files = d.services.agentFiles.list(d.read(), { project: 'RCP' });
    expect(files.project).toBe('RCP');
    expect(files.files.map((f) => [f.key, f.kind, f.name])).toEqual([
      ['skill:tasklite-coordinator', 'skill', 'tasklite-coordinator'],
      [WORKER, 'skill', 'tasklite-worker'],
      ['agents_block', 'agents_block', 'AGENTS.md block'],
    ]);
  });

  it('an unknown project or key is not_found; only shipped files can be edited', () => {
    fails(() => d.services.agentFiles.list(d.read(), { project: 'NOPE' }), 'not_found');
    fails(() => get(undefined, 'skill:nope'), 'not_found');
    fails(() => put('# New\n', { key: 'skill:my-own' }), 'not_found');
    fails(() => put('# X\n', { layer: 'project', project: 'NOPE' }), 'not_found');
  });

  it('a deleted project’s overrides go with it (cascade)', () => {
    put('# Worker\n\nRCP override.\n', { layer: 'project', project: 'RCP' });
    d.sql.prepare("DELETE FROM projects WHERE key = 'RCP'").run();
    expect(
      d.row<{ n: number }>("SELECT count(*) AS n FROM agent_files WHERE layer = 'project'").n,
    ).toBe(0);
    expect(effective()).toContain('Bundled v1.');
  });
});

// ---- Versions ----

describe('versions', () => {
  it('each edit is a new immutable version with author, note and sha256', () => {
    put('A\n', { note: 'First.' });
    put('B\n', { expected: 1, note: 'Second.' });
    const service = get().layers.service!;
    expect(service.current_version_no).toBe(2);
    expect(service.versions.map((v) => [v.version_no, v.content, v.author, v.note])).toEqual([
      [2, 'B\n', 'owner', 'Second.'],
      [1, 'A\n', 'owner', 'First.'],
    ]);
    expect(service.versions[0]!.sha256).toBe(sha256('B\n'));
    // Older versions are kept exactly.
    expect(
      d.row<{ content: string }>(
        'SELECT content FROM agent_file_versions WHERE version_no = 1 AND content = ?',
        'A\n',
      ),
    ).toBeTruthy();
  });

  it('expected_version is the layer’s current version_no, 0 when it has none', () => {
    const stale = fails(() => put('A\n', { expected: 1 }), 'conflict');
    expect(stale.message).toMatch(/now v0, you sent v1/);
    put('A\n');
    fails(() => put('B\n', { expected: 0 }), 'conflict');
    // Each layer counts on its own: a project's first override is 0.
    put('P\n', { layer: 'project', project: 'RCP', expected: 0 });
    const err = fails(
      () => put('P2\n', { layer: 'project', project: 'RCP', expected: 2 }),
      'conflict',
    );
    expect(err.current).toMatchObject({ key: WORKER, project: 'RCP' });
  });

  it('records agent_file.updated with the project, objects and an inverse', () => {
    put('P\n', { layer: 'project', project: 'RCP', note: 'Ours.' });
    const e = events('agent_file.updated').at(-1)!;
    expect(e).toMatchObject({
      actor_kind: 'owner',
      summary: 'Edited tasklite-worker (RCP): v1',
      project_key: 'RCP',
    });
    expect(e.inverse).not.toBeNull();
  });
});

// ---- Revert ----

describe('revert', () => {
  it('reverting the service-wide edit restores bundled; history stays', () => {
    put('Edit\n', { note: 'Mine.' });
    const { result } = revert('service');
    expect(result.effective_layer).toBe('bundled');
    expect(result.layers.service).toMatchObject({ current_version_no: 0 });
    expect(result.layers.service!.versions).toHaveLength(1);
    expect(effective()).toContain('Bundled v1.');
    expect(events('agent_file.reverted').at(-1)!.summary).toBe(
      'Reverted tasklite-worker (service-wide) to bundled',
    );
    // The next edit starts from 0 again and continues the numbering.
    put('Edit 2\n', { expected: 0 });
    expect(get().layers.service).toMatchObject({ current_version_no: 2 });
  });

  it('reverting a project override falls back to the service-wide edit', () => {
    put('Service\n');
    put('Project\n', { layer: 'project', project: 'RCP' });
    revert('project', 'RCP');
    expect(effective('RCP')).toBe('Service\n');
    expect(row('RCP').effective_layer).toBe('service');
    expect(events('agent_file.reverted').at(-1)!.summary).toBe(
      'Reverted tasklite-worker (RCP) to service-wide edit',
    );
  });

  it('nothing to revert is not_found', () => {
    fails(() => revert('service'), 'not_found');
    fails(() => revert('project', 'RCP'), 'not_found');
    put('Edit\n');
    revert('service');
    fails(() => revert('service'), 'not_found');
  });
});

// ---- Bundled version updated (FR-122) ----

describe('the bundled-updated flag', () => {
  const upgrade = () => sync([{ ...V1[0]!, content: '# Worker\n\nBundled v2.\n' }, V1[1]!, V1[2]!]);

  it('edit, then upgrade bundled: flagged, with the three-way versions; the edit is kept', () => {
    put('Mine\n');
    expect(row().bundled_updated).toBe(false);
    expect(get().bundled_updated).toBeNull();
    upgrade();
    expect(row().bundled_updated).toBe(true);
    expect(row('RCP').bundled_updated).toBe(true);
    const detail = get();
    const bundled = detail.layers.bundled!.versions;
    expect(detail.bundled_updated).toEqual({
      edited_layer: 'service',
      from_version_id: bundled.find((v) => v.version_no === 1)!.id,
      to_version_id: bundled.find((v) => v.version_no === 2)!.id,
    });
    // Never overwritten.
    expect(effective()).toBe('Mine\n');
    // Other files aren't flagged.
    expect(row(undefined, 'agents_block').bundled_updated).toBe(false);
  });

  it('editing again re-bases the edit and clears the flag', () => {
    put('Mine\n');
    upgrade();
    put('Mine\n', { expected: 1, note: 'Reviewed bundled v2.' });
    expect(row().bundled_updated).toBe(false);
  });

  it('reverting clears the flag (bundled applies again)', () => {
    put('Mine\n');
    upgrade();
    revert('service');
    expect(row().bundled_updated).toBe(false);
    expect(effective()).toContain('Bundled v2.');
  });

  it('a project override is flagged for its project only; bundled-only files never are', () => {
    put('Ours\n', { layer: 'project', project: 'RCP' });
    upgrade();
    expect(row('RCP').bundled_updated).toBe(true);
    expect(get('RCP').bundled_updated).toMatchObject({ edited_layer: 'project' });
    expect(row('DOC').bundled_updated).toBe(false);
    expect(row().bundled_updated).toBe(false);
  });

  it('a project override over a flagged service edit is judged on its own base', () => {
    put('Service\n');
    upgrade();
    put('Ours\n', { layer: 'project', project: 'RCP' });
    expect(row().bundled_updated).toBe(true);
    expect(row('RCP').bundled_updated).toBe(false);
  });
});

// ---- Workflow notes (FR-123) ----

describe('Workflow notes', () => {
  const putWf = (content_md: string, expected: number, note?: string) =>
    owner((w, s) =>
      s.agentFiles.putWorkflow(w, {
        key: 'RCP',
        content_md,
        expected_version: expected,
        ...(note ? { note } : {}),
      }),
    );

  it('starts empty at version 0; each save is a version; empty clears', () => {
    expect(d.services.agentFiles.workflow(d.read(), { key: 'RCP' })).toEqual({
      project: 'RCP',
      version_no: 0,
      content_md: '',
      versions: [],
    });
    putWf('- Branch per item.', 0, 'First notes.');
    putWf('- Branch per item.\n- PRs to main.', 1);
    const cleared = putWf('', 2, 'Not needed.').result;
    expect(cleared).toMatchObject({ version_no: 3, content_md: '' });
    expect(cleared.versions.map((v) => [v.version_no, v.content_md, v.author, v.note])).toEqual([
      [3, '', 'owner', 'Not needed.'],
      [2, '- Branch per item.\n- PRs to main.', 'owner', null],
      [1, '- Branch per item.', 'owner', 'First notes.'],
    ]);
    expect(events('workflow.updated').map((e) => e.summary)).toEqual([
      'Edited the Workflow notes of RCP: v1',
      'Edited the Workflow notes of RCP: v2',
      'Cleared the Workflow notes of RCP: v3',
    ]);
  });

  it('a stale expected_version is a conflict; an unknown project is not_found', () => {
    putWf('A', 0);
    fails(() => putWf('B', 0), 'conflict');
    fails(() => d.services.agentFiles.workflow(d.read(), { key: 'NOPE' }), 'not_found');
  });

  it('notes are per project', () => {
    putWf('RCP notes', 0);
    expect(d.services.agentFiles.workflow(d.read(), { key: 'DOC' }).version_no).toBe(0);
  });
});

// ---- Owner undo (B21 resolution 8) ----

describe('undo', () => {
  const undo = (id: string) => undoMutation(d.server.runtime.write, id);

  it('undoes a first edit (the new layer row goes too)', () => {
    const m = put('Mine\n', { layer: 'project', project: 'RCP' });
    undo(m.mutation_id);
    expect(row('RCP').effective_layer).toBe('bundled');
    expect(
      d.row<{ n: number }>("SELECT count(*) AS n FROM agent_files WHERE layer = 'project'").n,
    ).toBe(0);
    expect(events('agent_file.updated').at(-1)!.summary).toBe(
      'Undid: Edited tasklite-worker (RCP): v1',
    );
  });

  it('undoes a later edit back to the previous version and its bundled base', () => {
    put('One\n');
    sync([{ ...V1[0]!, content: 'Bundled v2\n' }, V1[1]!, V1[2]!]);
    const m = put('Two\n', { expected: 1 });
    expect(row().bundled_updated).toBe(false);
    undo(m.mutation_id);
    expect(effective()).toBe('One\n');
    expect(get().layers.service!.versions).toHaveLength(1);
    expect(row().bundled_updated).toBe(true);
  });

  it('undoes a revert', () => {
    put('Mine\n');
    const m = revert('service');
    undo(m.mutation_id);
    expect(effective()).toBe('Mine\n');
    expect(row().effective_layer).toBe('service');
  });

  it('undoes a Workflow notes save', () => {
    owner((w, s) =>
      s.agentFiles.putWorkflow(w, { key: 'RCP', content_md: 'A', expected_version: 0 }),
    );
    const m = owner((w, s) =>
      s.agentFiles.putWorkflow(w, { key: 'RCP', content_md: 'B', expected_version: 1 }),
    );
    undo(m.mutation_id);
    expect(d.services.agentFiles.workflow(d.read(), { key: 'RCP' })).toMatchObject({
      version_no: 1,
      content_md: 'A',
    });
  });

  it('a later edit of the same layer blocks the undo; after 60 s it is refused', () => {
    const first = put('One\n');
    put('Two\n', { expected: 1 });
    expect(() => undo(first.mutation_id)).toThrow(/changed since/);
    const late = put('Three\n', { expected: 2 });
    d.clock.advance(UNDO_WINDOW_MS + 1);
    expect(() => undo(late.mutation_id)).toThrow(/60 seconds/);
  });
});
