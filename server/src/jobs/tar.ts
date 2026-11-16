/**
 * A minimal tar.gz writer and reader for backups (BUILD_SPEC §5.13), on
 * Node's own zlib, so backups need no new dependency.
 *
 * - The format is POSIX ustar. A name that doesn't fit the 100-byte field,
 *   or isn't plain ASCII, gets a PAX extended header (`x`) with its `path`,
 *   so any `tar` can list and extract our archives.
 * - Only regular files and directories are written. Both directions stream:
 *   a file's bytes go from disk to gzip (and back) in chunks, so a 500 MB
 *   document never sits in memory.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';

const BLOCK = 512;
const ZERO = Buffer.alloc(BLOCK);

export interface TarFileEntry {
  /** The path inside the archive, with `/` separators. */
  name: string;
  size: number;
  mtime?: Date;
  mode?: number;
  /** The file to stream, or the bytes themselves. */
  source: { path: string } | { bytes: Buffer };
  /** Fed every byte of the file as it is written (to hash it in the same pass). */
  hash?: { update(chunk: Buffer): unknown };
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, type: '0' | 'x', mtime: Date, mode: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return h;
}

/** One PAX record: `<len> <key>=<value>\n`, where `len` counts the whole record. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body);
  let len = bodyLen + String(bodyLen).length;
  if (String(len).length !== String(len - bodyLen).length) len += 1;
  return Buffer.from(`${len}${body}`, 'utf8');
}

const padding = (size: number) => (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));

/** The blocks for one entry, the file's bytes streamed in between. */
async function* entryBlocks(entry: TarFileEntry): AsyncGenerator<Buffer> {
  const mtime = entry.mtime ?? new Date();
  const mode = entry.mode ?? 0o640;
  const plain = /^[\x20-\x7e]*$/.test(entry.name) && Buffer.byteLength(entry.name) <= 100;
  let shortName = entry.name;
  if (!plain) {
    const pax = paxRecord('path', entry.name);
    yield header(
      `PaxHeader/${entry.name.slice(-80).replace(/[^\x20-\x7e]/g, '_')}`,
      pax.length,
      'x',
      mtime,
      0o644,
    );
    yield pax;
    yield ZERO.subarray(0, padding(pax.length));
    shortName = entry.name.slice(-100).replace(/[^\x20-\x7e]/g, '_');
  }
  yield header(shortName, entry.size, '0', mtime, mode);
  let written = 0;
  if ('bytes' in entry.source) {
    written = entry.source.bytes.length;
    entry.hash?.update(entry.source.bytes);
    yield entry.source.bytes;
  } else {
    for await (const chunk of createReadStream(entry.source.path)) {
      written += (chunk as Buffer).length;
      entry.hash?.update(chunk as Buffer);
      yield chunk as Buffer;
    }
  }
  if (written !== entry.size) {
    throw new Error(`${entry.name} changed size while it was archived`);
  }
  yield ZERO.subarray(0, padding(written));
}

/** Write `entries` to a gzipped tar at `outPath` (created, never appended to). */
export async function writeTarGz(
  outPath: string,
  entries: AsyncIterable<TarFileEntry> | Iterable<TarFileEntry>,
): Promise<void> {
  async function* blocks(): AsyncGenerator<Buffer> {
    for await (const entry of entries) yield* entryBlocks(entry);
    yield ZERO;
    yield ZERO;
  }
  await pipeline(
    Readable.from(blocks()),
    createGzip({ level: 6 }),
    createWriteStream(outPath, { flags: 'wx', mode: 0o640 }),
  );
}

/** Where an entry's bytes go while reading; `null` skips it. */
export interface TarSink {
  write(chunk: Buffer): void | Promise<void>;
  end(): void | Promise<void>;
}

export interface TarEntryInfo {
  name: string;
  size: number;
  type: 'file' | 'directory' | 'other';
}

function readOctal(buf: Buffer, start: number, len: number): number {
  const text = buf
    .toString('ascii', start, start + len)
    .replace(/[\0 ]+$/g, '')
    .trim();
  return text === '' ? 0 : parseInt(text, 8);
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum === readOctal(h, 148, 8);
}

function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < buf.length) {
    const space = buf.indexOf(0x20, i);
    if (space === -1) break;
    const len = Number(buf.toString('ascii', i, space));
    if (!(len > 0)) break;
    const record = buf.toString('utf8', space + 1, i + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Read a tar.gz, calling `onEntry` for each file or directory. The sink it
 * returns gets the entry's bytes in order. Throws on a damaged archive: a
 * bad header checksum, a truncated entry, or a missing end marker.
 */
export async function readTarGz(
  path: string,
  onEntry: (entry: TarEntryInfo) => TarSink | null | Promise<TarSink | null>,
): Promise<void> {
  let buffered: Buffer = Buffer.alloc(0);
  let state: 'header' | 'body' | 'pad' | 'pax' | 'end' = 'header';
  let left = 0;
  let pad = 0;
  let sink: TarSink | null = null;
  let pax: Buffer[] = [];
  let paxPath: string | null = null;
  let zeroBlocks = 0;

  const gunzip = createReadStream(path).pipe(createGunzip());
  for await (const chunk of gunzip) {
    buffered =
      buffered.length === 0 ? (chunk as Buffer) : Buffer.concat([buffered, chunk as Buffer]);
    for (;;) {
      if (state === 'end') {
        buffered = Buffer.alloc(0);
        break;
      }
      if (state === 'header') {
        if (buffered.length < BLOCK) break;
        const h = buffered.subarray(0, BLOCK);
        buffered = buffered.subarray(BLOCK);
        if (h.equals(ZERO)) {
          zeroBlocks += 1;
          if (zeroBlocks === 2) state = 'end';
          continue;
        }
        if (zeroBlocks > 0 || !checksumOk(h))
          throw new Error('The archive is damaged (bad header).');
        const size = readOctal(h, 124, 12);
        const flag = String.fromCharCode(h[156] ?? 0);
        const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/s, '');
        const base = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
        let name = paxPath ?? (prefix ? `${prefix}/${base}` : base);
        paxPath = null;
        left = size;
        pad = padding(size);
        if (flag === 'x') {
          pax = [];
          state = 'pax';
          continue;
        }
        const type = flag === '0' || flag === '\0' ? 'file' : flag === '5' ? 'directory' : 'other';
        if (type === 'directory') name = name.replace(/\/$/, '');
        sink = await onEntry({ name, size, type });
        state = 'body';
        if (left === 0) {
          await sink?.end();
          sink = null;
          state = 'pad';
        }
        continue;
      }
      if (state === 'body' || state === 'pax') {
        if (buffered.length === 0) break;
        const n = Math.min(left, buffered.length);
        const part = buffered.subarray(0, n);
        buffered = buffered.subarray(n);
        left -= n;
        if (state === 'pax') pax.push(part);
        else if (sink) await sink.write(part);
        if (left === 0) {
          if (state === 'pax') {
            paxPath = parsePax(Buffer.concat(pax)).path ?? null;
          } else {
            await sink?.end();
            sink = null;
          }
          state = 'pad';
        }
        continue;
      }
      // state === 'pad'
      if (buffered.length < pad) break;
      buffered = buffered.subarray(pad);
      pad = 0;
      state = 'header';
    }
  }
  if (state !== 'end') throw new Error('The archive is damaged or incomplete (no end marker).');
}
