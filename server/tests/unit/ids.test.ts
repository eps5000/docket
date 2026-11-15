import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ID_PREFIXES, allocateItemId, isItemId, newId, parseItemId } from '../../src/domain/ids.js';
import { createTestDb, insertProject, type TestDb } from '../helpers.js';

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
  insertProject(t.db, 'RCP');
  insertProject(t.db, 'DOC');
});
afterEach(() => t.cleanup());

describe('item IDs', () => {
  it('numbers items per project through next_seq', () => {
    const ids = t.db.sqlite
      .transaction(() => [
        allocateItemId(t.db.sqlite, 'RCP'),
        allocateItemId(t.db.sqlite, 'RCP'),
        allocateItemId(t.db.sqlite, 'DOC'),
      ])
      .immediate();
    expect(ids).toEqual(['RCP-1', 'RCP-2', 'DOC-1']);
  });

  it('returns the number when the creating transaction rolls back', () => {
    expect(() =>
      t.db.sqlite
        .transaction(() => {
          allocateItemId(t.db.sqlite, 'RCP');
          throw new Error('rollback');
        })
        .immediate(),
    ).toThrow('rollback');
    expect(t.db.sqlite.transaction(() => allocateItemId(t.db.sqlite, 'RCP')).immediate()).toBe(
      'RCP-1',
    );
  });

  it('must run inside a transaction', () => {
    expect(() => allocateItemId(t.db.sqlite, 'RCP')).toThrow(/transaction/);
  });

  it('returns not_found for an unknown or deleted project', () => {
    t.db.sqlite
      .prepare("UPDATE projects SET deleted_at = '2026-11-14T00:00:00Z' WHERE key = 'DOC'")
      .run();
    for (const key of ['NOPE', 'DOC']) {
      expect(() =>
        t.db.sqlite.transaction(() => allocateItemId(t.db.sqlite, key)).immediate(),
      ).toThrow(expect.objectContaining({ code: 'not_found' }));
    }
  });

  it('recognises item IDs', () => {
    expect(isItemId('RCP-14')).toBe(true);
    expect(isItemId('rcp-14')).toBe(false);
    expect(isItemId('RCP-0')).toBe(false);
    expect(isItemId('TOOLONG-1')).toBe(false);
    expect(parseItemId('DOC-10')).toEqual({ project: 'DOC', n: 10 });
  });
});

describe('prefixed ULIDs', () => {
  it.each(['wst', 'chk', 'hr', 'run', 'q', 'lnk', 'doc', 'dv', 'pkt', 'dec'] as const)(
    'makes %s_ IDs',
    (prefix) => {
      expect(newId(prefix)).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
    },
  );

  it('covers every agent-visible prefix from MCP_SPEC §3', () => {
    expect(Object.values(ID_PREFIXES)).toEqual(
      expect.arrayContaining(['wst', 'chk', 'hr', 'run', 'q', 'lnk', 'doc', 'dv', 'pkt', 'dec']),
    );
  });

  it('is unique and sortable by time', () => {
    const ids = Array.from({ length: 200 }, () => newId('run'));
    expect(new Set(ids).size).toBe(200);
    expect([...ids].sort()).toEqual(ids);
  });
});
