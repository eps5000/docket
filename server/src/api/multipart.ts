/**
 * A streaming `multipart/form-data` reader for `POST /agent-upload`
 * (BUILD_SPEC §5.10; B4 note: never buffer the upload in memory).
 *
 * It reads the request body chunk by chunk and hands out one part at a time:
 * small fields are collected as text (64 KB each at most); the file part is
 * a pull-based stream, so the consumer (`documents.stage`) writes and hashes
 * each chunk as it arrives and backpressure reaches the socket. At most one
 * chunk plus the boundary is held at once.
 */
import { ToolError } from '@tasklite/shared';

const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_FIELD_BYTES = 64 * 1024;

export interface PartHeaders {
  name: string;
  filename: string | null;
  contentType: string | null;
}

const malformed = (why: string) =>
  new ToolError(
    'validation',
    `The upload is not valid multipart/form-data (${why}). Send it as a form with a file field.`,
  );

/** The boundary from a `Content-Type` header, or null. */
export function boundaryOf(contentType: string): string | null {
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function parseHeaders(raw: string): PartHeaders {
  let name: string | null = null;
  let filename: string | null = null;
  let contentType: string | null = null;
  for (const line of raw.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'content-type') contentType = value;
    if (key !== 'content-disposition') continue;
    for (const param of value.split(';').slice(1)) {
      const eq = param.indexOf('=');
      if (eq < 0) continue;
      const k = param.slice(0, eq).trim().toLowerCase();
      let v = param.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
      if (k === 'name') name = v;
      else if (k === 'filename' && filename === null) filename = v;
      else if (k === 'filename*') {
        const enc = /^[^']*'[^']*'(.*)$/.exec(v);
        try {
          filename = decodeURIComponent(enc ? enc[1]! : v);
        } catch {
          filename = v;
        }
      }
    }
  }
  if (name === null) throw malformed('a part has no name');
  return { name, filename, contentType };
}

export class MultipartReader {
  private buf: Buffer = Buffer.alloc(0);
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly delimiter: Buffer;
  private state: 'start' | 'headers' | 'body' | 'end' = 'start';

  constructor(body: ReadableStream<Uint8Array>, boundary: string) {
    this.reader = body.getReader();
    this.delimiter = Buffer.from(`\r\n--${boundary}`);
  }

  /** Read one more chunk into the buffer; false at the end of the body. */
  private async fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done) return false;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    return true;
  }

  private async need(n: number): Promise<void> {
    while (this.buf.length < n) {
      if (!(await this.fill())) throw malformed('it ends early');
    }
  }

  /** After a delimiter: `--` ends the body, CRLF starts the next part's headers. */
  private async afterDelimiter(): Promise<void> {
    await this.need(2);
    if (this.buf[0] === 0x2d && this.buf[1] === 0x2d) {
      this.state = 'end';
      this.buf = Buffer.alloc(0);
      return;
    }
    if (this.buf[0] !== 0x0d || this.buf[1] !== 0x0a) throw malformed('a boundary is malformed');
    this.buf = this.buf.subarray(2);
    this.state = 'headers';
  }

  /** The next part's headers, or null after the last part. Skips an unread body. */
  async next(): Promise<PartHeaders | null> {
    if (this.state === 'body') {
      // Drain the part nobody read.
      const rest = this.data();
      while (!(await rest.next()).done);
    }
    if (this.state === 'start') {
      // The first boundary has no CRLF before it (a preamble, if any, is skipped).
      const first = this.delimiter.subarray(2);
      for (;;) {
        const at = this.buf.indexOf(first);
        if (at >= 0) {
          this.buf = this.buf.subarray(at + first.length);
          break;
        }
        if (this.buf.length > MAX_HEADER_BYTES) throw malformed('no boundary found');
        if (!(await this.fill())) throw malformed('no boundary found');
      }
      await this.afterDelimiter();
    }
    if (this.state === 'end') return null;
    for (;;) {
      const at = this.buf.indexOf(HEADER_END);
      if (at >= 0) {
        const headers = parseHeaders(this.buf.subarray(0, at).toString('utf8'));
        this.buf = this.buf.subarray(at + HEADER_END.length);
        this.state = 'body';
        return headers;
      }
      if (this.buf.length > MAX_HEADER_BYTES) throw malformed('part headers are too long');
      if (!(await this.fill())) throw malformed('it ends early');
    }
  }

  /** The current part's bytes, chunk by chunk, up to the next boundary. */
  async *data(): AsyncGenerator<Buffer> {
    if (this.state !== 'body') return;
    const delim = this.delimiter;
    for (;;) {
      const at = this.buf.indexOf(delim);
      if (at >= 0) {
        const chunk = this.buf.subarray(0, at);
        this.buf = this.buf.subarray(at + delim.length);
        if (chunk.length > 0) yield chunk;
        await this.afterDelimiter();
        return;
      }
      // Keep a tail that could be the start of the delimiter.
      const safe = this.buf.length - (delim.length - 1);
      if (safe > 0) {
        const chunk = this.buf.subarray(0, safe);
        this.buf = this.buf.subarray(safe);
        yield chunk;
      }
      if (!(await this.fill())) throw malformed('it ends early');
    }
  }

  /** The current part as text (a form field). */
  async text(): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of this.data()) {
      size += chunk.length;
      if (size > MAX_FIELD_BYTES) throw malformed('a field is over 64 KB');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** The current part as a pull-based web stream (the file). */
  stream(): ReadableStream<Uint8Array> {
    const it = this.data();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const r = await it.next();
          if (r.done) controller.close();
          else
            controller.enqueue(new Uint8Array(r.value.buffer, r.value.byteOffset, r.value.length));
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel() {
        await it.return(undefined);
      },
    });
  }

  /**
   * After a refusal: read and drop what is left of the body (up to `max`
   * bytes) so the client gets the answer, then stop reading.
   */
  async discard(max = 64 * 1024 * 1024): Promise<void> {
    this.buf = Buffer.alloc(0);
    let left = max;
    try {
      while (left > 0) {
        const { value, done } = await this.reader.read();
        if (done) return;
        left -= value.byteLength;
      }
      await this.reader.cancel();
    } catch {
      // The client went away: nothing left to do.
    }
  }
}
