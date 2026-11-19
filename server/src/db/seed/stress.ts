/**
 * The stress project (B35, Gameflow pilot follow-ups): a second seeded
 * project, `STR`, shaped like a real imported Jira project rather than the
 * tidy prototype data. It loads with the sample seed when DOCKET_SEED_STRESS=1
 * (the e2e instance and CI set it), so layout checks see:
 *
 * - titles of about 120 characters, some with one long unbroken token (a URL
 *   or a path);
 * - cards with 6 or more labels, some with long label names;
 * - epics with 0 children (STR-1 In progress, STR-6 Inbox), 1 child (STR-2),
 *   30 or more children in mixed states (STR-3, STR-5), and an epic In
 *   progress whose children are all still to do (STR-4);
 * - 300 items in all;
 * - blocked chains (STR-160 → … → STR-164, a fan-in on STR-170, and one inside
 *   STR-3);
 * - steps with long Markdown details;
 * - imported items with Jira keys (STR-201…STR-210 ↔ STRESS-101…STRESS-110)
 *   whose sub-task steps carry their own keys as `source` (STR-203's
 *   "Prove SVG admission…" step is STRESS-227).
 *
 * Deterministic: the same output on every call (a fixed-seed generator, no
 * clock, no randomness). It never asks for the owner's attention, so the
 * Needs you queue and its tests are unchanged: no runs, questions, packets,
 * planning items, canceled blockers, cycles or dates on blocked items.
 */
import type { SampleData } from './loader.js';

type Item = SampleData['items'][number];
type Detail = SampleData['detail'][string];
type Work = NonNullable<Detail['work']>[number];
type Status = 'inbox' | 'ready' | 'progress' | 'review' | 'done' | 'canceled';

export const STRESS_PROJECT = 'STR';
export const STRESS_ITEMS = 300;
/** The Jira project the imported STR items came from. */
export const STRESS_JIRA = 'STRESS';

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS: [string, string][] = [
  ['ui', 'Screens and components.'],
  ['api', ''],
  ['svg', 'Vector assets and the SVG admission pipeline.'],
  ['perf', ''],
  ['docs', ''],
  ['audio', ''],
  ['accessibility-and-keyboard-navigation', 'Every screen works with a keyboard alone.'],
  ['performance-budget-regression-watch', ''],
  ['cross-platform-rendering-pipeline', ''],
  ['save-game-compatibility-and-migration', ''],
  ['localisation-right-to-left-layouts', ''],
  ['tech-debt', ''],
];

const VERBS = [
  'Prove',
  'Refactor',
  'Investigate why',
  'Add telemetry for',
  'Harden',
  'Document',
  'Fix flicker in',
  'Split',
  'Migrate',
  'Profile',
  'Make keyboard-only play possible in',
  'Stop leaking memory in',
];
const SUBJECTS = [
  'the SVG admission controller for user-uploaded level art',
  'save-game migration from schema v11 to v12 on cloud and local slots',
  'the cross-platform renderer when the window is resized during a cutscene',
  'the matchmaking lobby when two players join the same party within 50 ms',
  'right-to-left layouts in the inventory, crafting and quest log panels',
  'achievement sync with the platform service after an offline session',
  'the audio mixer ducking rules for dialogue over combat music',
  'tile atlas packing for the world-03 biome and its seasonal variants',
  'the controller remapping screen for players with one-handed setups',
  'the replay recorder when the frame budget drops below 30 fps',
];
const TAILS = [
  'so the nightly build stops timing out on the slow runner',
  'and keep the old behaviour behind a flag until the next season ships',
  'before the certification submission window closes for console builds',
  'without changing the public modding API that community tools rely on',
  'and add a regression test that runs on every pull request',
  'with a written rollback plan the release manager can follow alone',
];
/** Long unbroken tokens, as Jira titles carry them. */
const TOKENS = [
  'https://assets.stress.example/levels/world-03/tiles/atlas-highres-v12-final-final-2.svg?cache=0&rev=8841',
  'src/engine/render/pipelines/svg/admission/AdmissionControllerFactoryProviderImpl.ts',
  'C:\\Users\\builder\\AppData\\Local\\StressGame\\Saved\\SaveGames\\slot_03_autosave_backup.sav',
];

/** About 120 characters: verb, subject, tail, trimmed at a word. */
function longTitle(r: () => number, withToken: boolean): string {
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
  if (withToken) return `${pick(VERBS)} ${pick(TOKENS)} ${pick(TAILS)}`.slice(0, 190).trim();
  let t = `${pick(VERBS)} ${pick(SUBJECTS)} ${pick(TAILS)}`;
  if (t.length > 125) t = t.slice(0, t.lastIndexOf(' ', 125));
  return t;
}

const SHORT_TITLES = ['Fix typo', 'Bump SDK', 'Rename enum', 'Remove dead flag', 'Tidy logs'];

/** About 2,500 characters of Markdown, with a heading, lists, code and a long URL. */
function longDetails(n: number, source?: string): string {
  const head = source
    ? `Jira ${source} · assignee Sam Lee · start Nov 2, 2026 · due Dec 4, 2026 · 3 pts\n\n`
    : '';
  const para =
    'The admission step rejects files whose decoded size is more than 4x the encoded size, ' +
    'strips scripts and external references, and records why in the import log. Players see ' +
    'a short reason; modders see the full one in the console. ';
  return (
    head +
    `## What this step proves (${n})\n\n` +
    para.repeat(3) +
    '\n\n### Steps\n\n' +
    [
      'Load the fixture set from `fixtures/svg/admission/` (41 files, 9 hostile).',
      'Run `pnpm test:admission --reporter=verbose --bail=false` and keep the log.',
      'Compare the rejection reasons with the table in the design doc.',
      'Check memory stays under 256 MB while the 12 MB worst case is decoded.',
    ]
      .map((s, i) => `${i + 1}. ${s}`)
      .join('\n') +
    '\n\n### Evidence\n\n' +
    '- Design doc: https://docs.stress.example/engineering/render/svg-admission/2026-11-rfc-0042-admission-limits-and-reasons.html\n' +
    '- Log path: `/var/log/stress/import/2026-11-05T09-14-33Z-admission-run-0007.jsonl`\n\n' +
    '```text\n' +
    'admission: rejected world-03/tiles/atlas-highres-v12-final-final-2.svg (decoded 48.2 MB > 4x 9.1 MB)\n' +
    '```\n\n' +
    para.repeat(4)
  );
}

const STATES: [Status, number][] = [
  ['inbox', 0.15],
  ['ready', 0.25],
  ['progress', 0.15],
  ['review', 0.1],
  ['done', 0.3],
  ['canceled', 0.05],
];

function pickStatus(r: () => number): Status {
  let x = r();
  for (const [s, w] of STATES) {
    if (x < w) return s;
    x -= w;
  }
  return 'done';
}

/** Epics: [id number, status, title, children (first, last) or none]. */
const EPICS: [number, Status, string, [number, number] | null][] = [
  [1, 'progress', 'Empty epic: the online co-op mode nobody has broken down yet', null],
  [2, 'ready', 'Photo mode', [11, 11]],
  [
    3,
    'progress',
    'Rendering pipeline overhaul for user-generated levels, including SVG admission, atlas packing and the cross-platform renderer',
    [12, 47],
  ],
  [4, 'progress', 'Accessibility pass on every menu (started, nothing picked up yet)', [48, 53]],
  [
    5,
    'progress',
    'Save-game migration to schema v12 with cloud sync, conflict resolution and a rollback path for corrupted slots',
    [54, 85],
  ],
  [6, 'inbox', 'Seasonal events', null],
  [7, 'ready', 'Audio mixer rework', [86, 105]],
  [
    8,
    'review',
    'Localisation: right-to-left layouts across inventory, crafting and quests',
    [106, 120],
  ],
  [9, 'progress', 'Matchmaking and lobby reliability', [121, 140]],
  [10, 'done', 'Controller remapping', [141, 150]],
];

/** Blocked chains: [blocked item, its blockers]. Every blocker stays open and not canceled. */
const CHAINS: [number, number[]][] = [
  [161, [160]],
  [162, [161]],
  [163, [162]],
  [164, [163]],
  [170, [165, 166, 167, 168, 169]],
  [19, [18]],
  [20, [19]],
];

/** Imported items: STR-201…STR-210 ↔ STRESS-101…STRESS-110, with sub-task steps. */
const IMPORTED_FIRST = 201;
const IMPORTED_LAST = 210;

export function stressData(): SampleData {
  const r = rng(35);
  const key = STRESS_PROJECT;
  const id = (n: number) => `${key}-${n}`;
  const items: Item[] = [];
  const detail: SampleData['detail'] = {};
  const labelNames = LABELS.map(([n]) => n);

  const epicOf = new Map<number, number>();
  for (const [e, , , range] of EPICS) {
    if (range) for (let n = range[0]; n <= range[1]; n++) epicOf.set(n, e);
  }
  const blockedBy = new Map(CHAINS.map(([n, bs]) => [n, bs]));
  const blockers = new Set(CHAINS.flatMap(([, bs]) => bs));
  const inChain = (n: number) => blockedBy.has(n) || blockers.has(n);

  for (const [n, status, title] of EPICS) {
    items.push({
      id: id(n),
      type: 'Epic',
      title,
      status,
      prio: 2,
      proj: key,
      last: `${n + 1}d`,
      labels:
        n === 3 ? labelNames.slice(0, 7) : n === 5 ? ['save-game-compatibility-and-migration'] : [],
      ...(status === 'done' ? { actual: ['2026-10-20', '2026-11-01'] as [string, string] } : {}),
    });
  }

  for (let n = 11; n <= STRESS_ITEMS; n++) {
    const epic = epicOf.get(n);
    const imported = n >= IMPORTED_FIRST && n <= IMPORTED_LAST;
    let status: Status = pickStatus(r);
    // STR-4 is In progress, but none of its children has started.
    if (epic === 4) status = r() < 0.5 ? 'inbox' : 'ready';
    // STR-10 is done, and so is everything in it.
    if (epic === 10) status = 'done';
    // Chains: the head is In progress, everything after it waits (Ready, so it shows as blocked).
    if (blockers.has(n) && !blockedBy.has(n)) status = 'progress';
    else if (inChain(n)) status = 'ready';
    // The palette example (STRESS-227 → STR-203) is In progress.
    if (n === 203) status = 'progress';

    const type = (['Story', 'Task', 'Bug'] as const)[Math.floor(r() * 3)]!;
    const roll = r();
    const title =
      n === 203
        ? 'Prove SVG admission rejects decompression bombs and strips external references in user-uploaded level art'
        : roll < 0.08
          ? SHORT_TITLES[n % SHORT_TITLES.length]!
          : longTitle(r, roll > 0.9);

    // Labels: every seventh card has 6 to 8, long ones included; the rest 0 to 3.
    let labels: string[];
    if (n % 7 === 0) {
      const count = 6 + (n % 3);
      labels = labelNames
        .slice(12 - count)
        .concat(labelNames)
        .slice(0, count);
    } else {
      const count = Math.floor(r() * 4);
      labels = Array.from(
        { length: count },
        (_, i) => labelNames[(n + i * 5) % labelNames.length]!,
      );
      labels = [...new Set(labels)];
    }

    const daysAgo = 1 + Math.floor(r() * 20);
    const item: Item = {
      id: id(n),
      type,
      title,
      status,
      prio: (1 + Math.floor(r() * 3)) as 1 | 2 | 3,
      proj: key,
      last: `${daysAgo}d`,
      labels,
      ...(epic ? { epic: id(epic) } : {}),
      ...(blockedBy.has(n) ? { blockedBy: blockedBy.get(n)!.map(id) } : {}),
      ...(imported ? { jira: `${STRESS_JIRA}-${n - 100}`, imported: true } : {}),
    };
    if (status === 'done') {
      // Done items carry actual dates, ending on their last activity's day.
      const end = new Date(Date.UTC(2026, 10, 6) - daysAgo * 86_400_000);
      const start = new Date(end.getTime() - (1 + (n % 4)) * 86_400_000);
      item.actual = [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
      item.closedBy = imported ? 'imported' : n % 2 ? 'owner' : 'agent';
      item.pts = 1 + (n % 5);
    }
    // A few planned dates, never on chained items (no date-risk problems).
    if (!inChain(n) && !epic && n % 15 === 0 && ['ready', 'progress', 'inbox'].includes(status)) {
      const start = new Date(Date.UTC(2026, 10, 4 + (n % 10)));
      const end = new Date(start.getTime() + (3 + (n % 6)) * 86_400_000);
      item.start = start.toISOString().slice(0, 10);
      item.end = end.toISOString().slice(0, 10);
      item.setBy = 'owner · Nov 3';
    }
    items.push(item);

    // Checklist steps.
    const work: Work[] = [];
    if (imported) {
      // Sub-tasks became steps (decision 33): source = the sub-task's key.
      const subtasks = 2 + (n % 3);
      for (let k = 0; k < subtasks; k++) {
        // Sub-task keys STRESS-300…339; STR-203's first one is STRESS-227.
        const source =
          n === 203 && k === 0
            ? `${STRESS_JIRA}-227`
            : `${STRESS_JIRA}-${300 + (n - IMPORTED_FIRST) * 4 + k}`;
        const text =
          n === 203 && k === 0
            ? 'Prove SVG admission rejects a 48 MB decompression bomb within the memory budget'
            : `${['Write', 'Check', 'Port', 'Review'][k % 4]} ${SUBJECTS[(n + k) % SUBJECTS.length]}`;
        work.push({
          s: status === 'done' ? 'done' : k === 0 && status !== 'inbox' ? 'done' : 'todo',
          t: text,
          who: 'owner',
          when: `${daysAgo}d`,
          source,
          details: longDetails(k, source),
        });
      }
    } else if (['progress', 'review', 'done'].includes(status)) {
      const steps = 3 + Math.floor(r() * 6);
      for (let k = 0; k < steps; k++) {
        const done = status !== 'progress' || k < steps / 2;
        work.push({
          s: done ? 'done' : k === Math.ceil(steps / 2) ? 'current' : 'todo',
          t:
            k % 4 === 3
              ? `Check ${TOKENS[k % TOKENS.length]} still loads`
              : `${VERBS[(n + k) % VERBS.length]} ${SUBJECTS[(n * 3 + k) % SUBJECTS.length]}`,
          ...(done ? { who: 'claude', when: `${daysAgo}d` } : {}),
          ...(k % 3 === 1 ? { details: longDetails(k) } : {}),
        });
      }
    }
    if (work.length > 0) detail[id(n)] = { work };
  }

  return {
    projects: {
      [key]: {
        key,
        name: 'Stress · Long titles, many labels, big epics',
        short: 'Stress',
        color: '#5f3dc4',
      },
    },
    labels: Object.fromEntries(
      LABELS.map(([name, brief]) => [
        name,
        { proj: key, brief, ...(brief ? { by: 'owner · Nov 2' } : {}) },
      ]),
    ),
    items,
    detail,
    packets: {},
    changes: [],
  };
}

/** The sample data plus the stress project. Keys don't collide: STR has its own labels. */
export function withStress(data: SampleData): SampleData {
  const s = stressData();
  for (const name of Object.keys(s.labels)) {
    if (data.labels[name]) throw new Error(`Stress label "${name}" collides with the sample data.`);
  }
  return {
    projects: { ...data.projects, ...s.projects },
    labels: { ...data.labels, ...s.labels },
    items: [...data.items, ...s.items],
    detail: { ...data.detail, ...s.detail },
    packets: { ...data.packets, ...s.packets },
    changes: [...data.changes, ...s.changes],
  };
}
