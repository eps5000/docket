/**
 * The backup archive format (jobs/tar.ts; BUILD_SPEC §5.13): a ustar/PAX
 * tar.gz that round-trips names and bytes exactly, refuses damaged input,
 * and that the system `tar` can list (so the owner can open a backup by hand).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTarGz, writeTarGz, type TarFileEntry } from '../../src/jobs/tar.js';
import { tempDir, type TempDir } from '../helpers.js';

let tmp: TempDir;
beforeEach(() => {
  tmp = tempDir('docket-tar-');
});
afterEach(() => tmp.cleanup());

async function readAll(path: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  await readTarGz(path, (e) => {
    const parts: Buffer[] = [];
    return {
      write: (c) => {
        parts.push(Buffer.from(c));
      },
      end: () => {
        out.set(e.name, Buffer.concat(parts));
      },
    };
  });
  return out;
}

const LONG = `docs/RCP/doc_01M6R87WW0T5RS0MGFZ1JEHMC4/v12/${'a-very-long-file-name-'.repeat(8)}.md`;
const UNICODE = 'docs/DOC/doc_1/v1/Résumé – planning ✓.md';

describe('tar.gz round trip', () => {
  it('keeps names (long and non-ASCII) and bytes exactly, for every size', async () => {
    const big = join(tmp.dir, 'big.bin');
    writeFileSync(big, randomBytes(3 * 1024 * 1024 + 7));
    const entries: TarFileEntry[] = [
      { name: 'docket.db', size: 0, source: { bytes: Buffer.alloc(0) } },
      { name: 'exact.bin', size: 512, source: { bytes: randomBytes(512) } },
      { name: 'odd.bin', size: 513, source: { bytes: randomBytes(513) } },
      { name: LONG, size: 5, source: { bytes: Buffer.from('hello') } },
      { name: UNICODE, size: Buffer.byteLength('été'), source: { bytes: Buffer.from('été') } },
      { name: 'docs/big.bin', size: readFileSync(big).length, source: { path: big } },
    ];
    const archive = join(tmp.dir, 'a.tar.gz');
    await writeTarGz(archive, entries);
    const got = await readAll(archive);
    expect([...got.keys()]).toEqual(entries.map((e) => e.name));
    for (const e of entries) {
      const want = 'bytes' in e.source ? e.source.bytes : readFileSync(e.source.path);
      expect(got.get(e.name)!.equals(want), e.name).toBe(true);
    }
  });

  it('refuses a truncated or damaged archive', async () => {
    const archive = join(tmp.dir, 'a.tar.gz');
    await writeTarGz(archive, [
      { name: 'x.bin', size: 100_000, source: { bytes: randomBytes(100_000) } },
    ]);
    const bytes = readFileSync(archive);
    const cut = join(tmp.dir, 'cut.tar.gz');
    writeFileSync(cut, bytes.subarray(0, bytes.length - 40));
    await expect(readAll(cut)).rejects.toThrow();
    const notGzip = join(tmp.dir, 'plain.tar.gz');
    writeFileSync(notGzip, 'hello');
    await expect(readAll(notGzip)).rejects.toThrow();
  });

  it('refuses a file that changes size while it is archived', async () => {
    const file = join(tmp.dir, 'f.txt');
    writeFileSync(file, 'four');
    await expect(
      writeTarGz(join(tmp.dir, 'a.tar.gz'), [{ name: 'f.txt', size: 10, source: { path: file } }]),
    ).rejects.toThrow(/changed size/);
  });

  const tar = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  it.skipIf(tar.status !== 0)('the system tar lists the archive, long names included', async () => {
    const archive = join(tmp.dir, 'a.tar.gz');
    await writeTarGz(archive, [
      { name: 'docket.db', size: 2, source: { bytes: Buffer.from('db') } },
      { name: LONG, size: 2, source: { bytes: Buffer.from('ok') } },
    ]);
    const listed = spawnSync('tar', ['-tzf', 'a.tar.gz'], { encoding: 'utf8', cwd: tmp.dir });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout.trim().split(/\r?\n/)).toEqual(['docket.db', LONG]);
  });
});
