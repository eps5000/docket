#!/usr/bin/env node
/**
 * The UI sweep (B35): a repeatable, read-only pass over every main screen of
 * a running Docket, after an update or an import. It opens pages, switches
 * tabs, and opens and closes dialogs; it never submits anything. Every
 * request that isn't GET, HEAD or OPTIONS is blocked and reported.
 *
 *   pnpm sweep                                  # http://127.0.0.1:7420, 6 items
 *   pnpm sweep -- --base http://127.0.0.1:7435 --items 3 --json sweep.json
 *   node docker/smoke/ui-sweep.mjs --self-test  # shows each check can fail
 *
 * It visits Overview and a list behind one of its numbers; Work (board, list, map and timeline); Agents; Agent
 * files; Settings; Shared parts and Project decisions (the first item's
 * project); Help; N sample items from the Work list (default 6: the
 * longest title, the most labels, the biggest epic, an epic with no tickets,
 * an imported item, then a spread of the rest) on each of their tabs; the
 * command palette; and the step dialog on an item whose steps have details.
 * Each one at 1024 px in the dark theme and at 1440 px in the light theme.
 *
 * For each it reports:
 * - sideways page scroll;
 * - unclipped overflow: an element wider than its parent, when neither the
 *   parent nor an ancestor (up to the first one that contains it) scrolls or
 *   clips;
 * - flat progress fills (`.pbar i` less than 2 px tall);
 * - axe WCAG 2 A and AA violations (serious and critical fail; the rest are
 *   listed as warnings);
 * - console errors and uncaught page errors;
 * - load time (until the heading is on screen and the network is idle).
 *
 * Prints a short table and exits 1 when anything failed (2 when it couldn't
 * run). Options: --base <url> (or DOCKET_URL), --items <n>, --json <file>,
 * --headed. In protected mode set DOCKET_OWNER_KEY: the sweep unlocks its own
 * browser session, which is the only POST it sends.
 *
 * Playwright and axe come from the web package's dev dependencies, so run
 * `pnpm install` first (and `pnpm --filter @docket/web exec playwright
 * install chromium` once).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

/** WCAG 2 A and AA, as the e2e suite's axe helper scans (web/e2e/fixtures/axe.ts). */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export const VIEWPORTS = [
  { name: '1024 dark', width: 1024, height: 900, theme: 'dark' },
  { name: '1440 light', width: 1440, height: 900, theme: 'light' },
];

export const SCREENS = [
  ['Overview', '/'],
  // Decision 43: the list behind a number, on whatever the instance holds.
  ['Overview list', '/overview/in_flight'],
  ['Work board', '/work'],
  ['Work list', '/work?layout=list'],
  ['Work map', '/work?layout=map'],
  ['Work timeline', '/work?layout=timeline'],
  ['Agents', '/agents'],
  ['Agent files', '/agent-files'],
  ['Settings', '/settings'],
  // Decision 36 (B39): Settings → Projects → <project> → Shared parts. `{project}`
  // is the project of the first listed item, so the sweep works on any instance.
  ['Shared parts', '/settings/projects/{project}/shared-parts'],
  // Decision 38 (B44): the project's Decisions page.
  ['Project decisions', '/projects/{project}/decisions'],
  ['Help', '/help'],
];

const READY_MS = 20_000;
const IDLE_MS = 5_000;
const MAX_DETAILS = 5;

function parseArgs(argv) {
  const out = {
    base: process.env.DOCKET_URL ?? 'http://127.0.0.1:7420',
    items: 6,
    json: null,
    headed: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--') continue;
    else if (a === '--base') out.base = next();
    else if (a === '--items') out.items = Number(next());
    else if (a === '--json') out.json = next();
    else if (a === '--headed') out.headed = true;
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: ui-sweep.mjs [--base URL] [--items N] [--json FILE] [--headed] [--self-test]\n',
      );
      process.exit(0);
    } else throw new Error(`Unknown option ${a}`);
  }
  if (!Number.isInteger(out.items) || out.items < 0) throw new Error('--items must be 0 or more');
  out.base = out.base.replace(/\/$/, '');
  return out;
}

/**
 * The in-page layout checks: sideways page scroll, unclipped overflow, and
 * flat progress fills. Runs in the browser.
 */
function inPageLayout(maxDetails) {
  const doc = document.documentElement;
  const sideways = Math.max(0, doc.scrollWidth - doc.clientWidth);
  const clips = (el) =>
    ['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(el).overflowX);
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
    const data = [...el.attributes]
      .filter((a) => a.name.startsWith('data-') || a.name === 'href')
      .slice(0, 1)
      .map((a) => `[${a.name}="${a.value.slice(0, 40)}"]`)
      .join('');
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${tag}${id}${cls}${data}${text ? ` "${text}"` : ''}`;
  };
  const overflow = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const s = getComputedStyle(el);
    if (['absolute', 'fixed'].includes(s.position)) continue;
    if (s.display === 'none' || s.display === 'contents' || s.visibility === 'hidden') continue;
    // Measured mid-animation (the live-run pulse scales), its box isn't its layout.
    if (el.getAnimations().length > 0) continue;
    // Text spilling out of its own box: a squeezed flex item (even one 0px
    // wide) whose words run over its neighbours (Gameflow pilot, GF-312).
    const ownText = [...el.childNodes].some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0,
    );
    if (ownText && !s.display.startsWith('inline') && !clips(el)) {
      const spill = el.scrollWidth - el.clientWidth;
      if (spill > 2) {
        // Fine when a clipping ancestor hides it before an ancestor wide
        // enough to show it (a collapsed rail clips its labels on purpose).
        const er = el.getBoundingClientRect();
        const textRight = er.left + el.scrollWidth;
        let hidden = false;
        for (let a = el.parentElement; a && a !== doc; a = a.parentElement) {
          if (clips(a)) {
            hidden = true;
            break;
          }
          const ar = a.getBoundingClientRect();
          if (textRight <= ar.right + 1) break;
        }
        if (!hidden) {
          overflow.push(`${describe(el)}: its text spills ${Math.round(spill)}px out of its box`);
          continue;
        }
      }
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    let p = el.parentElement;
    while (p && getComputedStyle(p).display === 'contents') p = p.parentElement;
    if (!p || p === document.body || p === doc) continue; // the page itself: `sideways`
    const pr = p.getBoundingClientRect();
    const out = Math.max(r.right - pr.right, pr.left - r.left);
    if (out <= 1) continue;
    // Fine when the parent, or an ancestor before the first one that contains it, scrolls or clips.
    let ok = false;
    for (let a = p; a && a !== doc; a = a.parentElement) {
      if (clips(a)) {
        ok = true;
        break;
      }
      const ar = a.getBoundingClientRect();
      if (a !== p && r.right <= ar.right + 1 && r.left >= ar.left - 1) break;
    }
    if (!ok) overflow.push(`${describe(el)} is ${Math.round(out)}px outside ${describe(p)}`);
  }
  const flat = [...document.querySelectorAll('.pbar i')]
    .filter((i) => {
      const s = getComputedStyle(i);
      return s.display !== 'none' && i.getBoundingClientRect().height < 2;
    })
    .map((i) => describe(i.closest('.pbar')?.parentElement ?? i));
  // When the page scrolls sideways, name what reaches past the right edge: the innermost
  // elements whose box or text does, unless a scroll box that ends inside the page clips them
  // (absolutely positioned ones are always named: they can escape a scroll box).
  let reach = [];
  if (sideways > 0) {
    const vw = doc.clientWidth;
    const clippedInside = (el) => {
      for (let a = el.parentElement; a && a !== doc; a = a.parentElement) {
        if (clips(a) && a.getBoundingClientRect().right <= vw + 1) return true;
      }
      return false;
    };
    const found = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const right = Math.max(r.right, r.left + el.scrollWidth);
      if (right <= vw + 1) continue;
      const positioned = ['absolute', 'fixed'].includes(getComputedStyle(el).position);
      if (!positioned && clippedInside(el)) continue;
      found.push({ el, right });
    }
    reach = found
      .filter((f) => !found.some((o) => o !== f && f.el.contains(o.el)))
      .map((f) => `${describe(f.el)} reaches ${Math.round(f.right)}px`);
  }
  return {
    sideways,
    sidewaysBy: reach.slice(0, maxDetails),
    overflowCount: overflow.length,
    overflow: overflow.slice(0, maxDetails),
    flatCount: flat.length,
    flat: flat.slice(0, maxDetails),
  };
}

/** The layout checks alone (the e2e layout spec runs these at 1024 px). */
export async function layoutReport(page) {
  return page.evaluate(inPageLayout, MAX_DETAILS);
}

/** Run every check on the page as it is now. */
export async function checkPage(page, { console: consoleErrors = [], loadMs = null } = {}) {
  const layout = await layoutReport(page);
  const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const failing = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const warning = axe.violations.filter((v) => !failing.includes(v));
  const summarize = (v) =>
    `${v.id} (${v.impact}, ${v.nodes.length}): ${v.nodes
      .slice(0, 2)
      .map((n) => n.target.join(' '))
      .join(', ')}`;
  return {
    loadMs,
    sideways: layout.sideways,
    sidewaysBy: layout.sidewaysBy,
    overflowCount: layout.overflowCount,
    overflow: layout.overflow,
    flatCount: layout.flatCount,
    flat: layout.flat,
    axe: failing.map(summarize),
    axeWarnings: warning.map(summarize),
    console: [...consoleErrors],
  };
}

export function failed(r) {
  return (
    r.error !== undefined ||
    r.sideways > 0 ||
    r.overflowCount > 0 ||
    r.flatCount > 0 ||
    r.axe.length > 0 ||
    r.console.length > 0
  );
}

/** Wait for a screen: its h1 (or a dialog) on screen, then the network idle. */
async function settle(page, what = 'h1') {
  await page.locator(what).first().waitFor({ state: 'visible', timeout: READY_MS });
  await page.waitForLoadState('networkidle', { timeout: IDLE_MS }).catch(() => {});
  // Fades and slide-ins finish before axe reads colours (B25: a toast mid-fade fails contrast).
  // Only finite ones (the live-run pulse never ends), and never more than 2 s.
  await page
    .evaluate(() =>
      Promise.race([
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
            .map((a) => a.finished.catch(() => {})),
        ),
        new Promise((r) => setTimeout(r, 2_000)),
      ]),
    )
    .catch(() => {});
}

async function getJson(context, base, path) {
  const res = await context.request.get(`${base}${path}`);
  if (!res.ok()) throw new Error(`GET ${path}: ${res.status()} ${await res.text()}`);
  return res.json();
}

/** N items from the Work list, chosen to stress the layout first, then spread out. */
export function chooseItems(work, n) {
  const items = work.items.filter((i) => !i.archived);
  const epics = work.epics ?? [];
  const picks = [];
  const add = (id) => {
    if (id && !picks.includes(id) && picks.length < n) picks.push(id);
  };
  const by = (list, score) => [...list].sort((a, b) => score(b) - score(a))[0]?.id;
  add(by(items, (i) => i.title.length));
  add(by(items, (i) => i.labels.length));
  add(by(epics, (e) => e.children.total));
  add(epics.find((e) => e.children.total === 0)?.id);
  add(items.find((i) => i.jira_key)?.id);
  const rest = items.filter((i) => !picks.includes(i.id));
  const want = n - picks.length;
  for (let k = 0; k < want && rest.length > 0; k++) {
    add(rest[Math.floor((k * rest.length) / want)]?.id);
  }
  return picks;
}

async function findDetailedStep(context, base, candidates) {
  for (const id of candidates.slice(0, 40)) {
    const d = await getJson(context, base, `/api/items/${encodeURIComponent(id)}`);
    const step = d.item.checklist.work.find((w) => w.has_details);
    if (step) return { id, step: step.id };
  }
  return null;
}

async function sweep(opts) {
  const browser = await chromium.launch({ headless: !opts.headed });
  const results = [];
  const blocked = [];
  try {
    for (const vp of VIEWPORTS) {
      // axe needs a context from browser.newContext() (not a persistent one).
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: vp.theme,
        // Still screens: layout is measured without animations in flight.
        reducedMotion: 'reduce',
        baseURL: opts.base,
      });
      await context.addInitScript((theme) => {
        try {
          localStorage.setItem('docket.theme', theme);
          localStorage.setItem('docket.notifications', 'off');
        } catch {
          // Storage blocked: the theme follows colorScheme instead.
        }
      }, vp.theme);
      if (process.env.DOCKET_OWNER_KEY) {
        const res = await context.request.post(`${opts.base}/api/session/unlock`, {
          data: { key: process.env.DOCKET_OWNER_KEY },
        });
        if (!res.ok()) throw new Error(`Unlock failed: ${res.status()} ${await res.text()}`);
      }
      // Read-only: block every write the pages might send.
      await context.route('**/*', (route) => {
        const req = route.request();
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.continue();
        blocked.push(`${vp.name}: ${req.method()} ${new URL(req.url()).pathname}`);
        return route.abort('blockedbyclient');
      });

      const work = await getJson(context, opts.base, '/api/work?scope=all&layout=list');
      const items = chooseItems(work, opts.items);
      const page = await context.newPage();
      let errors = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text().slice(0, 200));
      });
      page.on('pageerror', (e) => errors.push(`page error: ${String(e.message).slice(0, 200)}`));

      const record = async (screen, fn) => {
        errors = [];
        const t0 = Date.now();
        try {
          await fn();
          const loadMs = Date.now() - t0;
          results.push({
            screen,
            view: vp.name,
            ...(await checkPage(page, { console: errors, loadMs })),
          });
        } catch (e) {
          results.push({
            screen,
            view: vp.name,
            error: String(e.message).split('\n')[0],
            loadMs: Date.now() - t0,
            sideways: 0,
            sidewaysBy: [],
            sidewaysBy: [],
            overflowCount: 0,
            overflow: [],
            flatCount: 0,
            flat: [],
            axe: [],
            axeWarnings: [],
            console: [...errors],
          });
        }
        const last = results[results.length - 1];
        process.stderr.write(
          `${failed(last) ? 'FAIL' : 'ok  '} ${vp.name} · ${screen} (${last.loadMs} ms)\n`,
        );
      };

      const project = (work.items.find((i) => !i.archived) ?? work.items[0])?.id.split('-')[0];
      for (const [name, rawPath] of SCREENS) {
        if (rawPath.includes('{project}') && !project) continue;
        const path = rawPath.replace('{project}', encodeURIComponent(project ?? ''));
        await record(name, async () => {
          await page.goto(path);
          await settle(page);
        });
      }

      for (const id of items) {
        await record(`${id} · first tab`, async () => {
          await page.goto(`/items/${encodeURIComponent(id)}`);
          await settle(page);
        });
        const tabs = page.locator('.itempage [role="tablist"] [role="tab"]');
        const count = await tabs.count();
        for (let k = 0; k < count; k++) {
          const tab = tabs.nth(k);
          if ((await tab.getAttribute('aria-selected')) === 'true') continue;
          // "Checklist3/3" → "Checklist": the tab's name without its count.
          const label =
            (await tab.innerText())
              .trim()
              .match(/^[\p{L} ]+/u)?.[0]
              ?.trim() ?? `tab ${k + 1}`;
          await record(`${id} · ${label}`, async () => {
            await tab.click();
            await settle(page);
          });
        }
      }

      await record('Palette', async () => {
        await page.goto('/');
        await settle(page);
        await page.keyboard.press('Control+k');
        const input = page.getByRole('combobox').first();
        await input.waitFor({ state: 'visible', timeout: READY_MS });
        await input.fill(items[0] ?? 'a');
        await page.waitForLoadState('networkidle', { timeout: IDLE_MS }).catch(() => {});
        await page.waitForTimeout(400); // the palette's 150 ms debounce, then results
      });
      await page.keyboard.press('Escape');

      // Review packets (Gameflow pilot: long agent-check evidence squeezed the
      // check text into a one-word column and overlapped it).
      // Only items with a packet: an item can be in Review before its packet exists.
      const withPacket = [];
      for (const r of work.items.filter((i) => i.status === 'review')) {
        if (withPacket.length >= 2) break;
        const res = await context.request.get(
          `${opts.base}/api/review/${encodeURIComponent(r.id)}`,
        );
        if (res.ok()) withPacket.push(r);
      }
      for (const r of withPacket) {
        await record(`${r.id} · review packet`, async () => {
          await page.goto(`/review/${encodeURIComponent(r.id)}`);
          await settle(page);
        });
      }

      const stepCandidates = [
        ...items,
        ...work.items.filter((i) => i.jira_key).map((i) => i.id),
        ...work.items
          .filter((i) => ['progress', 'review', 'done'].includes(i.status))
          .map((i) => i.id),
      ];
      const detailed = await findDetailedStep(context, opts.base, [...new Set(stepCandidates)]);
      if (detailed) {
        await record(`${detailed.id} · step dialog`, async () => {
          await page.goto(`/items/${encodeURIComponent(detailed.id)}?tab=checklist`);
          await settle(page);
          await page.locator(`[data-step-details="${detailed.step}"]`).click();
          await settle(page, '[role="dialog"]');
        });
        await page.keyboard.press('Escape');
        const open = await page.locator('[role="dialog"]').count();
        if (open > 0) {
          results.push({
            ...results[results.length - 1],
            screen: `${detailed.id} · step dialog closes`,
            error: 'Esc left the step dialog open',
          });
        }
      } else {
        results.push({
          screen: 'step dialog',
          view: vp.name,
          error: 'No item with step details found',
          loadMs: null,
          sideways: 0,
          sidewaysBy: [],
          overflowCount: 0,
          overflow: [],
          flatCount: 0,
          flat: [],
          axe: [],
          axeWarnings: [],
          console: [],
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return { base: opts.base, results, blocked };
}

function printReport({ base, results, blocked }) {
  const rows = [['Screen', 'View', 'Load ms', 'Scroll', 'Overflow', 'Flat', 'Axe', 'Console']];
  for (const r of results) {
    rows.push([
      r.screen,
      r.view,
      r.loadMs === null ? '-' : String(r.loadMs),
      r.sideways ? `${r.sideways}px` : 'ok',
      r.overflowCount ? String(r.overflowCount) : 'ok',
      r.flatCount ? String(r.flatCount) : 'ok',
      r.axe.length
        ? String(r.axe.length)
        : r.axeWarnings.length
          ? `ok (${r.axeWarnings.length}w)`
          : 'ok',
      r.console.length ? String(r.console.length) : 'ok',
    ]);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => row[c].length)));
  const line = (row) => `| ${row.map((cell, c) => cell.padEnd(widths[c])).join(' | ')} |`;
  const out = [`UI sweep of ${base}`, '', line(rows[0])];
  out.push(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const row of rows.slice(1)) out.push(line(row));
  const bad = results.filter(failed);
  out.push('');
  for (const r of bad) {
    out.push(`FAIL ${r.screen} (${r.view})`);
    if (r.error) out.push(`  error: ${r.error}`);
    if (r.sideways) out.push(`  the page scrolls sideways by ${r.sideways}px`);
    for (const w of r.sidewaysBy ?? []) out.push(`    ${w}`);
    for (const o of r.overflow) out.push(`  overflow: ${o}`);
    if (r.overflowCount > r.overflow.length)
      out.push(`  … and ${r.overflowCount - r.overflow.length} more`);
    for (const f of r.flat) out.push(`  flat fill: ${f}`);
    for (const a of r.axe) out.push(`  axe: ${a}`);
    for (const c of r.console) out.push(`  console: ${c}`);
  }
  const warnings = [...new Set(results.flatMap((r) => r.axeWarnings))];
  for (const w of warnings.slice(0, 10)) out.push(`warn axe: ${w}`);
  for (const b of blocked) out.push(`blocked write: ${b}`);
  const loads = results.map((r) => r.loadMs).filter((n) => typeof n === 'number');
  const slowest = results.reduce((a, r) => ((r.loadMs ?? 0) > (a?.loadMs ?? -1) ? r : a), null);
  out.push(
    `${results.length} checks, ${bad.length} failed. Load: median ${median(loads)} ms, slowest ${slowest?.loadMs ?? '-'} ms (${slowest?.screen ?? '-'}, ${slowest?.view ?? '-'}).`,
  );
  process.stdout.write(`${out.join('\n')}\n`);
}

function median(list) {
  if (list.length === 0) return '-';
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Each check flags a page built to fail it, so a clean sweep means something. */
async function selfTest() {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.setContent(`<!doctype html><html lang="en"><head><title>Self-test</title>
      <style>.tl .pbar{display:flex;height:7px;width:200px}.tl .pbar i{display:block}
      .card{width:200px;border:1px solid}.wide{width:400px}.clip{overflow:hidden}
      .page{width:1300px}</style></head>
      <body class="tl"><main><h1>Self-test</h1>
      <div class="card"><div class="wide">spills</div></div>
      <div class="card clip"><div class="wide">clipped, fine</div></div>
      <span class="pbar"><i style="width:40%;height:0"></i></span>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <div class="page">wide page</div>
      <script>console.error('self-test error')</script></main></body></html>`);
    const r = await checkPage(page, { console: errors });
    const expectations = [
      [
        'sideways scroll, naming the wide element',
        r.sideways > 0 && r.sidewaysBy.some((w) => w.startsWith('div.page')),
      ],
      // The spill and the wide page; not the clipped one.
      ['unclipped overflow', r.overflowCount === 2],
      ['flat progress fill', r.flatCount === 1],
      ['axe (image-alt)', r.axe.some((a) => a.startsWith('image-alt'))],
      ['console error', r.console.length === 1],
    ];
    let ok = true;
    for (const [name, pass] of expectations) {
      process.stdout.write(`${pass ? 'PASS' : 'FAIL'} the sweep catches ${name}\n`);
      ok &&= pass;
    }
    if (!ok) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return ok;
  } finally {
    await browser.close();
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  if (opts.selfTest) process.exit((await selfTest()) ? 0 : 1);
  try {
    const res = await fetch(`${opts.base}/healthz`);
    if (!res.ok) throw new Error(`/healthz answered ${res.status}`);
  } catch (e) {
    process.stderr.write(`Docket doesn't answer at ${opts.base}: ${e.message}\n`);
    process.exit(2);
  }
  const report = await sweep(opts);
  printReport(report);
  if (opts.json) mkdirSync(dirname(opts.json), { recursive: true });
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.results.some(failed) ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${e.stack ?? e}\n`);
    process.exit(2);
  });
}
