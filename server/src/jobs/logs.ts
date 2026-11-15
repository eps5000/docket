/**
 * The diagnostic call log (decision T21; BUILD_SPEC §2 volume layout, §7;
 * FR-108; MCP_SPEC §9 "Logging").
 *
 * One JSON line per MCP call in `/data/logs/calls-YYYYMMDD.jsonl` (UTC
 * date): time, tool, client, label, run, duration and result code. Never
 * arguments or results: the writer copies only those fields, so a caller
 * can't leak content by passing extra properties. Files rotate daily and
 * are kept 7 days.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorCode } from '@tasklite/shared';

export interface CallLogEntry {
  /** ISO-8601 UTC; defaults to now. */
  time?: string;
  tool: string;
  client: string | null;
  label: string | null;
  run: string | null;
  duration_ms: number;
  result: 'ok' | ErrorCode;
}

export const CALL_LOG_KEEP_DAYS = 7;
const FILE = /^calls-(\d{8})\.jsonl$/;
const DAY_MS = 86_400_000;

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

export class CallLog {
  private readonly dir: string;
  private readonly clock: () => Date;
  private readonly keepDays: number;
  private currentDay: string | null = null;

  constructor(opts: { dir: string; clock?: () => Date; keepDays?: number }) {
    this.dir = opts.dir;
    this.clock = opts.clock ?? (() => new Date());
    this.keepDays = opts.keepDays ?? CALL_LOG_KEEP_DAYS;
  }

  fileFor(date: Date): string {
    return join(this.dir, `calls-${ymd(date)}.jsonl`);
  }

  record(entry: CallLogEntry): void {
    const now = this.clock();
    const day = ymd(now);
    if (day !== this.currentDay) {
      mkdirSync(this.dir, { recursive: true });
      this.currentDay = day;
      this.prune();
    }
    // Copy the allowed fields only, in a fixed order.
    const line = {
      time: entry.time ?? now.toISOString(),
      tool: entry.tool,
      client: entry.client,
      label: entry.label,
      run: entry.run,
      duration_ms: Math.max(0, Math.round(entry.duration_ms)),
      result: entry.result,
    };
    appendFileSync(this.fileFor(now), `${JSON.stringify(line)}\n`, { mode: 0o640 });
  }

  /** Delete files older than the retention window (today counts as day 1). */
  prune(): void {
    const oldest = ymd(new Date(this.clock().getTime() - (this.keepDays - 1) * DAY_MS));
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = FILE.exec(name);
      if (m && m[1]! < oldest) rmSync(join(this.dir, name), { force: true });
    }
  }

  /** The last `days` days of log lines, oldest first (for the Settings download). */
  read(days = this.keepDays): string {
    const now = this.clock().getTime();
    const parts: string[] = [];
    for (let i = Math.min(days, this.keepDays) - 1; i >= 0; i--) {
      try {
        parts.push(readFileSync(this.fileFor(new Date(now - i * DAY_MS)), 'utf8'));
      } catch {
        // No calls that day.
      }
    }
    return parts.join('');
  }
}
