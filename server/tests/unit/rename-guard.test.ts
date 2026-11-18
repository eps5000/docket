/**
 * The rename guard (B28): the product is Docket, formerly Task Lite. No
 * tracked file may name it the old way (`tasklite`, `TASKLITE`, "Task Lite",
 * in any case) except where this allowlist says why:
 *
 * - **phrases** that are allowed anywhere: the "(formerly Task Lite)" note on
 *   a doc's first mention, the README's "Moving from Task Lite", and the
 *   one-line "rename your MCP server entry from tasklite to docket";
 * - **files**, each with the most lines it may have, for the compatibility
 *   code (old settings, markers, manifest, skill keys, database file and
 *   backups), its tests, the docs that explain it, and history.
 *
 * Paths such as `specs/001-task-lite-v1/` (the repo was renamed eps5000/docket; GitHub redirects the old URL)
 * don't match: the repo and the Spec Kit folder keep their names.
 *
 * A new match fails with its file and line. When a compatibility file gains a
 * legitimate line, raise its count here; when it loses one, lower it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const OLD = /tasklite|task lite/i;

/** Allowed anywhere: removed from a line before it is checked. */
const PHRASES = [
  /\(formerly Task Lite[);,]/g,
  /\*Formerly Task Lite\./g,
  /Docket \(formerly Task Lite\)/g,
  /Moving from Task Lite/g,
  /from tasklite to docket/g,
];

/** File → the most lines it may have that name the old product, and why. */
const FILES: Record<string, { lines: number; why: string }> = {
  // Compatibility code.
  'shared/src/legacy.ts': { lines: 26, why: 'every old name, in one place' },
  'shared/src/install.ts': { lines: 4, why: 'old markers and manifest (comments)' },
  'shared/src/enums.ts': { lines: 1, why: 'install changes for old skill folders' },
  'server/src/config.ts': { lines: 5, why: 'TASKLITE_* fallback, tasklite.db' },
  'server/src/runtime.ts': { lines: 1, why: 'the TASKLITE_* startup warnings' },
  'server/src/jobs/backup.ts': { lines: 3, why: 'old backups stay restorable' },
  'server/src/db/migrations/0005_docket_rename.sql': {
    lines: 11,
    why: 'renames skill:tasklite-* keys',
  },
  'server/src/domain/install-scripts.ts': { lines: 6, why: 'old markers, old folders' },
  'server/src/domain/check-scripts.ts': { lines: 2, why: 'old manifest and folders' },
  'server/src/domain/installs.ts': { lines: 7, why: 'old manifest and folders (push)' },
  'server/src/domain/push-root.ts': { lines: 1, why: 'the one recorded-folder removal' },
  'server/src/domain/drift.ts': { lines: 3, why: 'old keys, "old name, edited locally"' },
  'server/src/domain/agent-proposals.ts': { lines: 2, why: 'old keys are mapped' },
  'web/src/routes/agent-files/Drift.tsx': { lines: 1, why: 'old-name drift card' },
  'web/e2e/fixtures/container.ts': { lines: 2, why: 'never reset the old data volume' },
  'docker/Dockerfile': { lines: 2, why: 'the health check reads TASKLITE_PORT' },
  'docker/compose.yaml': { lines: 3, why: 'the old volume, never touched' },
  'docker/.env.example': { lines: 4, why: 'documents the TASKLITE_* fallback' },
  // Tests of the compatibility rules.
  'server/tests/unit/rename-guard.test.ts': { lines: 12, why: 'this guard' },
  'server/tests/unit/config.test.ts': { lines: 17, why: 'old settings and database file' },
  'server/tests/unit/migration-docket-rename.test.ts': { lines: 7, why: 'the key migration' },
  'server/tests/contract/b28-rename-compat.test.ts': { lines: 33, why: 'old installs, keys' },
  'server/tests/integration/install-shell.test.ts': { lines: 26, why: 'old installs, by shell' },
  'server/tests/integration/us10-ops.test.ts': { lines: 8, why: 'old backups restore' },
  'shared/tests/install.test.ts': { lines: 8, why: 'old markers and names' },
  // Docs that explain the rename and the compatibility rules.
  'README.md': { lines: 8, why: '"Moving from Task Lite"' },
  'docs/BUILD_SPEC.md': { lines: 5, why: '§5.17 old-name rules, decision R1' },
  'docs/help/agent-files.md': { lines: 1, why: 'the old-folder removal' },
  'docs/help/backups-restore-export.md': { lines: 1, why: 'old backups and volume' },
  'specs/001-task-lite-v1/spec.md': { lines: 1, why: 'FR-125 names the old skill folders' },
  // History.
  'docs/REQUIREMENTS_DRAFT.md': { lines: 5, why: 'superseded draft, keeps its name' },
  'design/prototype.html': { lines: 5, why: 'the design reference as approved' },
};

const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|gz|tgz|zip|db|mp4|webm)$/i;

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter((f) => f && !BINARY.test(f));
}

/** Each file's lines that still name the old product, after the allowed phrases. */
function matches(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of trackedFiles()) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    if (!OLD.test(text)) continue;
    const lines = text.split(/\r?\n/).flatMap((line, i) => {
      const rest = PHRASES.reduce((l, p) => l.replace(p, ''), line);
      return OLD.test(rest) ? [`${file}:${i + 1}: ${line.trim().slice(0, 160)}`] : [];
    });
    if (lines.length > 0) found.set(file, lines);
  }
  return found;
}

describe('the rename guard (B28)', () => {
  it('no stray tasklite, TASKLITE or "Task Lite" outside the allowlist', () => {
    console.log(
      [
        'Rename guard allowlist (B28):',
        `  phrases: ${PHRASES.map((p) => p.source).join(' | ')}`,
        ...Object.entries(FILES).map(([f, a]) => `  ${f}: up to ${a.lines} line(s), ${a.why}`),
      ].join('\n'),
    );
    const found = matches();
    const strays: string[] = [];
    for (const [file, lines] of found) {
      const allowed = FILES[file]?.lines ?? 0;
      if (lines.length > allowed) {
        strays.push(
          `${file}: ${lines.length} line(s), ${allowed} allowed`,
          ...lines.map((l) => `    ${l}`),
        );
      }
    }
    expect(strays, strays.join('\n')).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    const found = matches();
    const stale = Object.entries(FILES)
      .filter(([file, a]) => (found.get(file)?.length ?? 0) < a.lines)
      .map(
        ([file, a]) =>
          `${file}: ${found.get(file)?.length ?? 0} line(s), allowlist says ${a.lines}`,
      );
    expect(stale, 'lower these counts (or remove the entry)').toEqual([]);
  });
});
