/**
 * The item-reference write check (MCP_SPEC §3.4 and its B11 resolutions;
 * tasks.md T106): item IDs in text that don't exist are accepted with a
 * warning, applied once in the write path so every text-writing tool and
 * owner route gets it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mentionedIds, referenceWarnings, stripCode } from '../../src/domain/references.js';
import type { Actor } from '../../src/domain/write.js';
import { addProject, startDomain, type Domain } from '../us1-helpers.js';

describe('mentionedIds', () => {
  it('finds item-shaped IDs in order, once each', () => {
    expect(mentionedIds('See RCP-12, then RCP-99 and RCP-12 again (DOC-4).')).toEqual([
      'RCP-12',
      'RCP-99',
      'DOC-4',
    ]);
  });

  it('skips lowercase, embedded and zero-padded forms', () => {
    expect(mentionedIds('rcp-12 XRCPXX-1 RCP-12a aRCP-3 RCP-007')).toEqual([]);
  });

  it('skips IDs in inline code and fenced code blocks', () => {
    const text = [
      'Fixes RCP-1; the test uses `RCP-99` and ``RCP-98``.',
      '```ts',
      "const id = 'RCP-97';",
      '```',
      '~~~',
      'RCP-96',
      '~~~',
      'Then RCP-2.',
    ].join('\n');
    expect(mentionedIds(text)).toEqual(['RCP-1', 'RCP-2']);
    expect(stripCode(text)).not.toContain('RCP-97');
  });

  it('an unclosed fence hides the rest of the text', () => {
    expect(mentionedIds('RCP-1\n```\nRCP-2')).toEqual(['RCP-1']);
  });
});

describe('the write check', () => {
  let d: Domain;
  let claude: Actor;
  beforeEach(() => {
    d = startDomain({ seed: false });
    addProject(d, 'RCP');
    claude = d.agent('claude');
  });
  afterEach(() => d.cleanup());

  const create = (title: string) =>
    d.write(claude, (w, s) =>
      s.items.create(w, { project: 'RCP', type: 'Task', title, priority: 2, status: 'planning' }),
    ).id;

  /** A write through the write path with these args, returning its warnings. */
  const warn = (args: unknown) =>
    d.server.runtime.write.run({ actor: claude, operation: 'test', args }, () => null).warnings;

  it('warns only for IDs of existing projects that don’t exist', () => {
    const a = create('A');
    expect(
      warn({ text: `${a} is fine; RCP-99 is not; UTF-8, SHA-256, ISO-8601 and XYZ-9 are not IDs` }),
    ).toEqual(["RCP-99 doesn't exist"]);
  });

  it('never scans identifier and locator fields', () => {
    expect(
      warn({
        id: 'RCP-90',
        from: 'RCP-91',
        to: 'RCP-92',
        epic: 'RCP-93',
        blocked_by: ['RCP-94'],
        url: 'https://example.test/RCP-95',
        branch: 'feature/RCP-96',
        workspace: { path: 'C:/w/RCP-97' },
        external: { note: 'RCP-98' },
        note: 'RCP-99',
      }),
    ).toEqual(["RCP-99 doesn't exist"]);
  });

  it('nested text is scanned (plan steps, review items, waiting_on)', () => {
    expect(warn({ steps: [{ text: 'After RCP-50' }], waiting_on: { items: ['RCP-51'] } })).toEqual([
      "RCP-50 doesn't exist",
      "RCP-51 doesn't exist",
    ]);
  });

  it('an item created by the same write counts as existing', () => {
    const out = d.server.runtime.write.run(
      { actor: claude, operation: 'test', args: { description_md: 'Follow-up to RCP-1' } },
      (w) =>
        d.services.items.create(w, {
          project: 'RCP',
          type: 'Task',
          title: 'First',
          priority: 2,
          status: 'inbox',
        }),
    );
    expect(out.result.id).toBe('RCP-1');
    expect(out.warnings).toEqual([]);
  });

  it('the write is accepted, and the warning comes back on an idempotent replay', () => {
    const a = create('A');
    const run = (key: string) =>
      d.server.runtime.write.run(
        {
          actor: claude,
          operation: 'add_note',
          args: { id: a, text: 'Blocked on RCP-77' },
          idempotencyKey: key,
        },
        (w) => d.services.evidence.addNote(w, { id: a, text: 'Blocked on RCP-77' }),
      );
    const first = run('k1');
    expect(first.warnings).toEqual(["RCP-77 doesn't exist"]);
    expect(d.rows("SELECT seq FROM events WHERE type = 'note.added'")).toHaveLength(1);
    const again = run('k1');
    expect(again.replayed).toBe(true);
    expect(again.warnings).toEqual(["RCP-77 doesn't exist"]);
  });

  it('caps the list at ten, then summarises', () => {
    const text = Array.from({ length: 13 }, (_, i) => `RCP-${100 + i}`).join(' ');
    const out = referenceWarnings(d.server.runtime.db, { text });
    expect(out).toHaveLength(11);
    expect(out.at(-1)).toBe("3 more item IDs don't exist");
  });
});
