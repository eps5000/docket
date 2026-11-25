// @vitest-environment jsdom
/**
 * The progress map (UI_SPEC §6.3.4; tasks.md T108): wave layout, the outside
 * and cycle columns, the header counts, zoom steps and Fit width (decision 63),
 * arrows, hover tracing and keyboard panning.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkEdge, Status } from '@docket/shared';
import {
  FIT_MIN,
  FIT_WIDTH_HELP,
  ProgressMap,
  cyclePath,
  cyclesIn,
  fitZoom,
  layoutMap,
  stepZoom,
  type MapItem,
  type MapZoom,
} from './index';

afterEach(cleanup);

function item(id: string, status: Status = 'ready', extra: Partial<MapItem> = {}): MapItem {
  return {
    id,
    project: id.split('-')[0]!,
    type: 'Implementation',
    title: `Title of ${id}`,
    status,
    priority: 2,
    epic: 'RCP-1',
    epic_title: 'Meal planning MVP',
    labels: [],
    blocked: false,
    blocked_by: [],
    unblocks: 0,
    lead: null,
    human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
    planned_start: null,
    planned_end: null,
    effort: null,
    archived: false,
    jira_key: null,
    version: 1,
    updated_at: '2026-11-06T10:00:00.000Z',
    ...extra,
  };
}

let n = 0;
const edge = (from: string, to: string, cleared = false): LinkEdge => ({
  link_id: `lnk_${++n}`,
  from,
  to,
  type: 'blocks',
  satisfied_when: 'done',
  cleared,
});

// RCP-11 (done) → RCP-12 → RCP-22; RCP-11 → RCP-14; DOC-4 (outside) → RCP-16; RCP-30 ⇄ RCP-31.
const items = [
  item('RCP-11', 'done'),
  item('RCP-12', 'review', { human_review: { declared: 0, ready: 1, approved: 0, deferred: 0 } }),
  item('RCP-14', 'progress', { human_review: { declared: 1, ready: 0, approved: 0, deferred: 0 } }),
  // Decision 57: the server says RCP-16 waits its turn; the others weren't classified (Blocked).
  item('RCP-16', 'ready', {
    blocked: true,
    blocked_by: ['DOC-4'],
    wait: {
      kind: 'queued',
      reason: null,
      after: 'DOC-4',
      more: 0,
      on: null,
      text: 'Starts after DOC-4',
    },
  }),
  item('RCP-22', 'ready', { blocked: true, blocked_by: ['RCP-12'] }),
  item('RCP-23', 'planning', { blocked: true, blocked_by: ['RCP-12'] }),
  item('RCP-30', 'ready', { blocked: true, blocked_by: ['RCP-31'] }),
  item('RCP-31', 'ready', { blocked: true, blocked_by: ['RCP-30'] }),
  item('RCP-40', 'ready'),
];
const outside = [item('DOC-4', 'progress', { epic: 'DOC-10' })];
const links = [
  edge('RCP-11', 'RCP-12', true),
  edge('RCP-11', 'RCP-14', true),
  edge('RCP-12', 'RCP-22'),
  edge('RCP-12', 'RCP-23'),
  edge('DOC-4', 'RCP-16'),
  edge('RCP-30', 'RCP-31'),
  edge('RCP-31', 'RCP-30'),
];

describe('layoutMap', () => {
  const l = layoutMap(items, outside, links);

  it('waves follow the longest blocks path; cycle members get their own column', () => {
    expect(l.waves.map((w) => w.map((i) => i.id))).toEqual([
      ['RCP-11', 'RCP-16', 'RCP-40'],
      ['RCP-12', 'RCP-14'],
      ['RCP-22', 'RCP-23'],
    ]);
    expect(l.cycle.map((i) => i.id)).toEqual(['RCP-30', 'RCP-31']);
    expect(l.outside.map((i) => i.id)).toEqual(['DOC-4']);
  });

  it('draws arrows to every placed card, from outside blockers too, but not inside a cycle', () => {
    expect(l.edges.map((e) => `${e.from}>${e.to}${e.cleared ? ' ok' : ''}`)).toEqual([
      'RCP-11>RCP-12 ok',
      'RCP-11>RCP-14 ok',
      'RCP-12>RCP-22',
      'RCP-12>RCP-23',
      'DOC-4>RCP-16',
    ]);
  });

  it('counts the header', () => {
    expect(l.counts).toMatchObject({
      total: 9,
      done: 1,
      readyQueued: 1,
      readyBlocked: 3,
      readyToStart: 1,
      workingOnWave: 1,
    });
  });

  it('a wave is "worked on" from the first that still has open items', () => {
    const doneFirst = layoutMap(
      [item('A-1', 'done'), item('A-2', 'ready')],
      [],
      [edge('A-1', 'A-2', true)],
    );
    expect(doneFirst.counts.workingOnWave).toBe(2);
  });

  it('a canceled item stays only while it blocks something here, and is never counted', () => {
    const lone = layoutMap([item('A-1', 'canceled'), item('A-2')], [], []);
    expect(lone.scope.map((i) => i.id)).toEqual(['A-2']);
    expect(lone.waves.flat().map((i) => i.id)).toEqual(['A-2']);
    const blocking = layoutMap(
      [item('A-1', 'canceled'), item('A-2', 'ready', { blocked: true })],
      [],
      [edge('A-1', 'A-2')],
    );
    expect(blocking.waves.map((w) => w.map((i) => i.id))).toEqual([['A-1'], ['A-2']]);
    expect(blocking.counts.total).toBe(1);
  });
});

describe('cycles, zoom and arrows', () => {
  it('finds cycles and a real path around them', () => {
    const cyc = [edge('A-1', 'A-3'), edge('A-3', 'A-2'), edge('A-2', 'A-1')];
    expect(cyclesIn(cyc)).toEqual([['A-1', 'A-2', 'A-3']]);
    expect(cyclePath(['A-1', 'A-2', 'A-3'], cyc)).toEqual(['A-1', 'A-3', 'A-2', 'A-1']);
  });

  it('zoom steps are 50, 67, 80, 100 and 125%', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1.25, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.8);
    expect(stepZoom(0.8, -1)).toBe(0.67);
    expect(stepZoom(0.67, -1)).toBe(0.5);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(0.72, 1)).toBe(0.8); // from a Fit width value between steps
    expect(stepZoom(0.72, -1)).toBe(0.67);
  });

  it('Fit width (decision 63) fits the width only, never above 100% or below 50%', () => {
    // Wide: 5 waves in 800 px.
    expect(fitZoom(1000, 800)).toBe(0.8);
    // Tall: the height plays no part; a map that fits the width stays at 100%.
    expect(fitZoom(700, 800)).toBe(1);
    // Narrow: capped at the normal 100%, never blown up.
    expect(fitZoom(300, 800)).toBe(1);
    // Very wide: the floor is the smallest step, and the map scrolls both ways.
    expect(FIT_MIN).toBe(0.5);
    expect(fitZoom(4000, 800)).toBe(FIT_MIN);
    expect(fitZoom(1600, 800)).toBe(0.5);
    // Rounded down, so the scaled map never overflows the width by a pixel.
    expect(fitZoom(1500, 1000)).toBe(0.666);
    expect(Math.ceil(1500 * fitZoom(1500, 1000))).toBeLessThanOrEqual(1000);
    // Nothing measured yet.
    expect(fitZoom(0, 800)).toBe(1);
    expect(fitZoom(1000, 0)).toBe(1);
  });
});

/**
 * A card by its item ID: a direct lookup, not a role query over the whole
 * map (see the zoom test). Cards are <button>s, which the second test checks
 * by role and accessible name.
 */
function cardOf(id: string): HTMLButtonElement {
  const card = document.querySelector<HTMLElement>(`[data-pid="${id}"]`);
  expect(card?.tagName).toBe('BUTTON');
  return card as HTMLButtonElement;
}

describe('<ProgressMap>', () => {
  const view = () =>
    render(
      <MemoryRouter>
        <div className="tl">
          <ProgressMap
            items={items}
            outside={outside}
            links={links}
            outsideTitle="Outside this epic"
            home={{ project: 'RCP' }}
          />
        </div>
      </MemoryRouter>,
    );

  it('renders without the outside prop, with no render loop (B18: a stable default)', () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
    const { container } = render(
      <MemoryRouter>
        <div className="tl">
          <ProgressMap items={items} links={links} outsideTitle="Outside this epic" />
        </div>
      </MemoryRouter>,
    );
    spy.mockRestore();
    expect(errors).toEqual([]);
    expect(container.querySelector('[data-col="outside"]')).toBeNull();
    expect(cardOf('RCP-14')).toBeTruthy();
  });

  it('renders the header, the columns in order and the key', () => {
    const { container } = view();
    expect(container.querySelector('.pm-big')!.textContent).toBe('1 / 9 done');
    expect(
      screen.getByRole('img', {
        name: '1 done, 1 review, 1 in progress, 1 ready, 1 queued, 3 blocked, 1 planning, 0 inbox',
      }),
    ).toBeTruthy();
    expect(screen.getByText('1 queued')).toBeTruthy();
    expect(screen.getByText('3 blocked')).toBeTruthy();
    expect(screen.queryByText(/ready but blocked/)).toBeNull();
    expect(screen.getByText('1 ready to start · working on wave 1 of 3')).toBeTruthy();
    const heads = [...container.querySelectorAll('.pm-colh')].map((h) => h.firstChild!.textContent);
    expect(heads).toEqual(['Outside this epic', 'Wave 1', 'Wave 2', 'Wave 3', 'Cycle']);
    expect(
      screen.getByText(/Arrow = blocks · dashed green = cleared · hover to trace/),
    ).toBeTruthy();
  });

  it('cards are buttons that say what they are, including blocked, after and review marks', () => {
    view();
    const blocked = screen.getByRole('button', {
      name: /^Implementation RCP-22 Title of RCP-22 Ready · blocked$/,
    });
    expect(blocked.className).toContain('blk');
    expect(within(blocked).getByText('· blocked')).toBeTruthy();
    // Decision 57: Queued is calm and says so in words, never red.
    const queued = screen.getByRole('button', {
      name: /^Implementation RCP-16 Title of RCP-16 Ready · queued$/,
    });
    expect(queued.className).toContain('que');
    expect(queued.className).not.toContain('blk');
    expect(within(queued).getByText('· queued').getAttribute('title')).toBe('Starts after DOC-4');
    expect(cardOf('RCP-23').textContent).toContain('· after RCP-12');
    expect(screen.getByRole('button', { name: /RCP-12 .*packet ready for you/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /RCP-14 .*Human review later/ })).toBeTruthy();
    const ext = cardOf('DOC-4');
    expect(ext.className).toContain('ext');
    expect(ext.textContent).toContain('DOC ↗');
    expect(cardOf('RCP-11').textContent).toContain('✓');
  });

  it('zoom controls step, reset and fit', () => {
    view();
    // Find the Zoom group once, then query its four buttons inside it. A
    // role-and-name query over the whole map computes the accessible name
    // and the computed style of every element, which made this test take
    // seconds on a loaded CI runner (B12's run timed out at 5 s).
    const zoom = within(screen.getByRole('group', { name: 'Zoom' }));
    const button = (name: string | RegExp) => zoom.getByRole('button', { name });
    const pct = () => button(/^Zoom \d+%/).textContent;
    expect(pct()).toBe('100%');
    fireEvent.click(button('Zoom in'));
    expect(pct()).toBe('125%');
    expect((button('Zoom in') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button(/^Zoom 125%/));
    expect(pct()).toBe('100%');
    for (let i = 0; i < 4; i++) fireEvent.click(button('Zoom out'));
    expect(pct()).toBe('50%');
    const fit = button('Fit width');
    expect(fit.textContent).toBe('Fit width');
    expect(fit.getAttribute('title')).toBe(FIT_WIDTH_HELP);
    expect(fit.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(fit);
    expect(fit.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(fit);
    expect(fit.getAttribute('aria-pressed')).toBe('false');
    expect(pct()).toBe('100%');
  });

  it('restores zoom and Fit width when a map view remounts', () => {
    function OpenMapTab() {
      const [visible, setVisible] = useState(true);
      const [mapZoom, setMapZoom] = useState<MapZoom>({ fit: false, z: 1 });
      return (
        <MemoryRouter>
          <button onClick={() => setVisible((value) => !value)}>Switch view</button>
          {visible && (
            <ProgressMap
              items={[item('RCP-11')]}
              links={[]}
              outsideTitle="Outside"
              mapZoom={mapZoom}
              onZoomChange={setMapZoom}
            />
          )}
        </MemoryRouter>
      );
    }

    render(<OpenMapTab />);
    let zoom = within(screen.getByRole('group', { name: 'Zoom' }));
    fireEvent.click(zoom.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch view' }));
    zoom = within(screen.getByRole('group', { name: 'Zoom' }));
    expect(zoom.getByRole('button', { name: /^Zoom 125%/ })).toBeTruthy();

    fireEvent.click(zoom.getByRole('button', { name: 'Fit width' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch view' }));
    zoom = within(screen.getByRole('group', { name: 'Zoom' }));
    expect(zoom.getByRole('button', { name: 'Fit width' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('hover and focus trace a card’s links and dim the rest', () => {
    view();
    const card = cardOf('RCP-12');
    fireEvent.mouseEnter(card);
    expect(card.className).toContain('hl');
    expect(cardOf('RCP-22').className).toContain('hl');
    expect(cardOf('RCP-40').className).toContain('dim');
    fireEvent.mouseLeave(card);
    expect(cardOf('RCP-40').className).not.toContain('dim');
    fireEvent.focus(cardOf('DOC-4'));
    expect(cardOf('RCP-16').className).toContain('hl');
  });

  it('routes every arrow and paints a traced card’s arrows last (B47)', () => {
    const { container } = view();
    expect(container.querySelector('.pm-map')!.className).toContain('routed');
    const paths = () => [...container.querySelectorAll<SVGPathElement>('path.pm-edge')];
    expect(paths().length).toBe(5);
    expect(container.querySelector('.pm-halo')).toBeNull();
    fireEvent.mouseEnter(cardOf('DOC-4'));
    const last = paths().at(-1)!;
    expect(last.getAttribute('data-from')).toBe('DOC-4');
    expect(last.getAttribute('class')).toContain('hl');
  });

  it('the bar and legend share the status tokens’ classes, and Queued and Blocked are their own segments', () => {
    const { container } = view();
    const bar = container.querySelector('.pbar')!;
    expect([...bar.children].map((i) => i.className)).toEqual([
      'sb-done',
      'sb-review',
      'sb-progress',
      'sb-ready',
      'sb-queued',
      'sb-blocked',
      'sb-planning',
    ]);
    expect(container.querySelector('.pm-legend .sb-blocked')).toBeTruthy();
    expect(container.querySelector('.pm-legend .sb-queued')).toBeTruthy();
    // Only Blocked reads as bad; Queued is calm.
    expect(container.querySelector('.pm-legend .pm-badtext')!.textContent).toBe('3 blocked');
  });

  it('the canvas is a focusable region that pans with the arrow keys', () => {
    view();
    const canvas = screen.getByRole('region', { name: /Progress map/ });
    expect(canvas.tabIndex).toBe(0);
    let moved: ScrollToOptions | null = null;
    canvas.scrollBy = ((opts: ScrollToOptions) => {
      moved = opts;
    }) as typeof canvas.scrollBy;
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    expect(moved).toEqual({ left: 60, top: 0 });
    fireEvent.keyDown(canvas, { key: 'ArrowDown' });
    expect(moved).toEqual({ left: 0, top: 60 });
  });
});

describe('Hide implied links (decision 60)', () => {
  // RCP-11 → RCP-12 → RCP-22, plus the shortcut RCP-11 → RCP-22 the chain already shows
  // (cleared like RCP-11's other links: RCP-11 is done).
  const shortcut = edge('RCP-11', 'RCP-22', true);
  const view = () =>
    render(
      <MemoryRouter>
        <div className="tl">
          <ProgressMap
            items={items}
            outside={outside}
            links={[...links, shortcut]}
            outsideTitle="Outside this epic"
          />
        </div>
      </MemoryRouter>,
    );
  const arrows = (c: HTMLElement) =>
    [...c.querySelectorAll('path.pm-edge')].map(
      (p) => `${p.getAttribute('data-from')}>${p.getAttribute('data-to')}`,
    );
  // By label, not role: whole-map role queries are slow in jsdom (B13).
  const toggle = () => screen.getByLabelText('Hide implied links') as HTMLInputElement;
  afterEach(() => localStorage.clear());

  it('is on by default: the implied arrow isn’t drawn, and "1 hidden" sits by the switch', () => {
    const { container } = view();
    const sw = toggle();
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.checked).toBe(true);
    expect(document.getElementById(sw.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Hides an arrow when a chain of other arrows already connects the same two tickets.',
    );
    expect(container.querySelector('.pm-implied')!.getAttribute('title')).toBe(
      'Hides an arrow when a chain of other arrows already connects the same two tickets.',
    );
    expect(arrows(container)).not.toContain('RCP-11>RCP-22');
    expect(arrows(container)).toContain('RCP-12>RCP-22');
    expect(screen.getByText('1 hidden')).toBeTruthy();
  });

  it('turned off, it draws every arrow, drops the count and remembers that in this browser', () => {
    const first = view();
    fireEvent.click(toggle());
    expect(arrows(first.container)).toContain('RCP-11>RCP-22');
    expect(screen.queryByText(/hidden$/)).toBeNull();
    expect(localStorage.getItem('docket.mapHideImplied')).toBe('off');
    first.unmount();

    const again = view();
    expect(toggle().checked).toBe(false);
    expect(arrows(again.container)).toContain('RCP-11>RCP-22');
    // Back on: the default is stored as nothing.
    fireEvent.click(toggle());
    expect(arrows(again.container)).not.toContain('RCP-11>RCP-22');
    expect(localStorage.getItem('docket.mapHideImplied')).toBeNull();
  });

  it('a hidden arrow isn’t traced on hover; the chain still is', () => {
    view();
    fireEvent.mouseEnter(cardOf('RCP-11'));
    expect(cardOf('RCP-12').className).toContain('hl');
    expect(cardOf('RCP-22').className).toContain('dim');
  });

  it('shows no count when nothing is implied, and no switch on a map without arrows', () => {
    const { unmount } = render(
      <MemoryRouter>
        <div className="tl">
          <ProgressMap items={items} outside={outside} links={links} outsideTitle="Outside" />
        </div>
      </MemoryRouter>,
    );
    expect(toggle()).toBeTruthy();
    expect(screen.queryByText(/hidden$/)).toBeNull();
    unmount();
    const bare = render(
      <MemoryRouter>
        <div className="tl">
          <ProgressMap items={items} links={[]} outsideTitle="Outside" />
        </div>
      </MemoryRouter>,
    );
    expect(bare.container.querySelector('[role="switch"]')).toBeNull();
  });
});

describe('Fit width (decision 63)', () => {
  // jsdom lays nothing out: every element reports `width` as its clientWidth, and the routed
  // map's unscaled width is read back from its style.
  let width = 0;
  let spy: { mockRestore: () => void } | null = null;
  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });
  const mapWidth = (c: HTMLElement) =>
    parseFloat(c.querySelector<HTMLElement>('.pm-map')!.style.width);

  // A tall map: five waves, with 12 tickets in wave 3.
  const tallItems = [
    item('T-1', 'done'),
    item('T-2', 'review'),
    ...Array.from({ length: 12 }, (_, i) => item(`T-${30 + i}`, 'ready', { blocked: true })),
    item('T-4', 'planning', { blocked: true }),
    item('T-5', 'inbox', { blocked: true }),
  ];
  const tallLinks = [
    edge('T-1', 'T-2', true),
    ...Array.from({ length: 12 }, (_, i) => edge('T-2', `T-${30 + i}`)),
    edge('T-30', 'T-4'),
    edge('T-4', 'T-5'),
  ];

  const render1 = (w: number, tall = false) => {
    width = w;
    spy ??= vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    const r = render(
      <MemoryRouter>
        <div className="tl">
          <ProgressMap
            items={tall ? tallItems : items}
            outside={tall ? undefined : outside}
            links={tall ? tallLinks : links}
            outsideTitle="Outside this epic"
          />
        </div>
      </MemoryRouter>,
    );
    const zoom = within(screen.getByRole('group', { name: 'Zoom' }));
    return {
      ...r,
      fit: zoom.getByRole('button', { name: 'Fit width' }),
      pct: () => zoom.getByRole('button', { name: /^Zoom \d+%/ }).textContent,
      canvas: r.container.querySelector<HTMLElement>('.pm-canvas')!,
      sizer: r.container.querySelector<HTMLElement>('.pm-sizer')!,
    };
  };
  /** The map's unscaled width, from a first render. */
  const widthOf = (tall = false) => {
    const first = render1(0, tall);
    const w = mapWidth(first.container);
    first.unmount();
    expect(w).toBeGreaterThan(0);
    return w;
  };

  it('scales a wide map so every wave fits the width, and no more', () => {
    const w = widthOf();
    // The view is 80% of the map, plus the canvas's 22 px padding each side.
    const view = Math.round(w * 0.8);
    const m = render1(view + 44);
    expect(m.pct()).toBe('100%');
    fireEvent.click(m.fit);
    expect(m.fit.getAttribute('aria-pressed')).toBe('true');
    expect(m.pct()).toBe('80%');
    expect(m.canvas.className).toContain('fit');
    expect(parseFloat(m.sizer.style.width)).toBeLessThanOrEqual(view);
    expect(parseFloat(m.sizer.style.width)).toBeGreaterThan(view - 3);
  });

  it('fits a tall map (12 tickets in one wave) by its width alone', () => {
    const w = widthOf(true);
    const m = render1(Math.round(w * 0.8) + 44, true);
    expect(m.container.querySelectorAll('[data-col="wave-3"] .pm-node')).toHaveLength(12);
    expect(m.container.querySelectorAll('.pm-colh')).toHaveLength(5);
    fireEvent.click(m.fit);
    expect(m.pct()).toBe('80%');
  });

  it('never blows a narrow map up past 100%', () => {
    const m = render1(5000);
    fireEvent.click(m.fit);
    expect(m.pct()).toBe('100%');
    expect(m.fit.getAttribute('aria-pressed')).toBe('true');
  });

  it('stops at 50% on a very wide map, which then scrolls both ways', () => {
    const m = render1(300);
    fireEvent.click(m.fit);
    expect(m.pct()).toBe('50%');
    expect(parseFloat(m.sizer.style.width)).toBeGreaterThan(300 - 44);
  });

  it('goes back to the top left; turning it off leaves the scroll alone', () => {
    const m = render1(5000);
    const pos = { top: 300, left: 120 };
    Object.defineProperty(m.canvas, 'scrollTop', {
      configurable: true,
      get: () => pos.top,
      set: (v: number) => {
        pos.top = v;
      },
    });
    Object.defineProperty(m.canvas, 'scrollLeft', {
      configurable: true,
      get: () => pos.left,
      set: (v: number) => {
        pos.left = v;
      },
    });
    fireEvent.click(m.fit);
    expect(pos).toEqual({ top: 0, left: 0 });
    pos.top = 200;
    fireEvent.click(m.fit);
    expect(m.fit.getAttribute('aria-pressed')).toBe('false');
    expect(pos.top).toBe(200);
  });

  it('the keyboard still scrolls down after Fit width', () => {
    const m = render1(5000);
    fireEvent.click(m.fit);
    let moved: ScrollToOptions | null = null;
    m.canvas.scrollBy = ((opts: ScrollToOptions) => {
      moved = opts;
    }) as typeof m.canvas.scrollBy;
    fireEvent.keyDown(m.canvas, { key: 'ArrowDown' });
    expect(moved).toEqual({ left: 0, top: 60 });
  });

  it('a mouse drags the map; touch is left to the browser’s own scrolling', () => {
    const m = render1(5000);
    const at = { clientX: 100, clientY: 100, button: 0, pointerId: 1 };
    fireEvent.pointerDown(m.canvas, { ...at, pointerType: 'touch' });
    fireEvent.pointerMove(m.canvas, { ...at, clientY: 40, pointerType: 'touch' });
    expect(m.canvas.className).not.toContain('dragging');
    fireEvent.pointerUp(m.canvas, { ...at, pointerType: 'touch' });

    fireEvent.pointerDown(m.canvas, { ...at, pointerType: 'mouse' });
    fireEvent.pointerMove(m.canvas, { ...at, clientY: 40, pointerType: 'mouse' });
    expect(m.canvas.className).toContain('dragging');
    fireEvent.pointerUp(m.canvas, { ...at, pointerType: 'mouse' });
    expect(m.canvas.className).not.toContain('dragging');
  });
});

describe('Bugs hold the release (decision 64)', () => {
  // RCP-17 and RCP-18 are bugs with no link; RCP-19 is a bug RCP-22 waits on (part of the chain).
  const bugItems = [
    ...items,
    item('RCP-17', 'ready', { type: 'Bug' }),
    item('RCP-18', 'done', { type: 'Bug' }),
    item('RCP-19', 'progress', { type: 'Bug' }),
    // Decision 67: the epic's Release, with no drawn link.
    item('RCP-35', 'ready', { type: 'Release', title: 'Release the synthetic planner' }),
  ];
  const bugLinks = [...links, edge('RCP-19', 'RCP-22')];
  const release = { id: 'RCP-35', left: 5, openBugs: 2 };

  it('layoutMap stacks unlinked bugs in their own list, keeps chain bugs in their wave, and counts them all', () => {
    const l = layoutMap(bugItems, outside, bugLinks, [], { bugs: true });
    expect(l.bugs.map((i) => i.id)).toEqual(['RCP-18', 'RCP-17']);
    expect([...l.chainBugs]).toEqual(['RCP-19']);
    expect(l.waves[0]!.map((i) => i.id)).toEqual(['RCP-11', 'RCP-19', 'RCP-16', 'RCP-40']);
    expect(l.release.map((i) => i.id)).toEqual(['RCP-35']);
    expect(l.counts.total).toBe(13);
    // No arrow touches the Bugs column.
    expect(l.edges.some((e) => e.from === 'RCP-17' || e.to === 'RCP-17')).toBe(false);
  });

  it('without `bugs` (Work → Map, label pages) bugs are ordinary cards in Wave 1', () => {
    const l = layoutMap(bugItems, outside, bugLinks);
    expect(l.bugs).toEqual([]);
    expect(l.chainBugs.size).toBe(0);
    expect(l.waves[0]!.map((i) => i.id)).toContain('RCP-17');
  });

  const view = (r: typeof release | null = release, extra: LinkEdge[] = []) =>
    render(
      <MemoryRouter>
        <div className="tl">
          <ProgressMap
            items={bugItems}
            outside={outside}
            links={[...bugLinks, ...extra]}
            outsideTitle="Outside this epic"
            release={r}
          />
        </div>
      </MemoryRouter>,
    );
  afterEach(() => localStorage.clear());

  it('draws a Bugs column left of everything, counting open bugs, with no arrows', () => {
    const { container } = view();
    const heads = [...container.querySelectorAll('.pm-colh')].map((h) => h.textContent);
    expect(heads[0]).toBe('Bugs1 bug open');
    expect(heads.slice(1, 3)).toEqual([
      'Outside this epicblocks work here',
      'Wave 1nothing blocks these',
    ]);
    const col = container.querySelector('[data-col="bugs"]')!;
    expect([...col.querySelectorAll('[data-pid]')].map((c) => c.getAttribute('data-pid'))).toEqual([
      'RCP-18',
      'RCP-17',
    ]);
    const ends = [...container.querySelectorAll('path.pm-edge')].flatMap((p) => [
      p.getAttribute('data-from'),
      p.getAttribute('data-to'),
    ]);
    expect(ends).not.toContain('RCP-17');
    expect(ends).not.toContain('RCP-18');
  });

  it('a bug in the chain stays in its wave with a bug marker', () => {
    const { container } = view();
    const wave1 = container.querySelector('[data-col="wave-1"]')!;
    const card = wave1.querySelector('[data-pid="RCP-19"]')!;
    expect(card.querySelector('[data-bug-mark]')!.textContent).toBe('bug');
    expect(container.querySelector('[data-pid="RCP-17"] [data-bug-mark]')).toBeNull();
  });

  it('the Release sits alone in the last column, says what it finishes after, and no arrow runs to it', () => {
    const { container } = view();
    const cols = [...container.querySelectorAll('.pm-col')];
    const last = cols[cols.length - 1]!;
    expect(last.getAttribute('data-col')).toBe('release');
    expect(last.querySelector('.pm-colh')!.textContent).toBe('Releaseafter 5 tickets');
    expect([...last.querySelectorAll('[data-pid]')].map((c) => c.getAttribute('data-pid'))).toEqual(
      ['RCP-35'],
    );
    const card = last.querySelector('[data-pid="RCP-35"]')!;
    expect(card.querySelector('[data-release-badge]')!.textContent).toBe(
      'Release · finishes after 3 tickets · Waiting on 2 bugs',
    );
    expect(card.className).toContain('held');
    expect(container.querySelector('path.pm-edge[data-to="RCP-35"]')).toBeNull();
  });

  it('with nothing left the badge says Release; without an open epic there is no Bugs column', () => {
    const quiet = view({ id: 'RCP-35', left: 0, openBugs: 0 });
    expect(quiet.container.querySelector('[data-release-badge]')!.textContent).toBe('Release');
    expect(quiet.container.querySelector('[data-col="release"] .pm-colh')!.textContent).toBe(
      'Releasenothing left before it',
    );
    quiet.unmount();
    const plain = view(null);
    expect(plain.container.querySelector('[data-col="bugs"]')).toBeNull();
    expect(plain.container.querySelector('[data-release-badge]')).toBeNull();
    // A Release still sits last on any map, with the general words.
    expect(plain.container.querySelector('[data-col="release"] .pm-colh')!.textContent).toBe(
      'Releaseafter everything else',
    );
    expect(plain.container.querySelector('[data-col="wave-1"] [data-pid="RCP-17"]')).toBeTruthy();
  });

  it('works with Hide implied links: unlinked bugs add nothing to hide, the shortcut still hides', () => {
    const { container } = view(release, [edge('RCP-11', 'RCP-22', true)]);
    expect(screen.getByText('1 hidden')).toBeTruthy();
    const drawn = [...container.querySelectorAll('path.pm-edge')].map(
      (p) => `${p.getAttribute('data-from')}>${p.getAttribute('data-to')}`,
    );
    expect(drawn).not.toContain('RCP-11>RCP-22');
    fireEvent.click(screen.getByLabelText('Hide implied links'));
    expect(screen.queryByText(/hidden$/)).toBeNull();
    expect(container.querySelector('[data-col="bugs"]')).toBeTruthy();
  });
});

describe('Bugs column with Fit width (decisions 63 and 64)', () => {
  let width = 0;
  let spy: { mockRestore: () => void } | null = null;
  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });
  const bugItems = [...items, item('RCP-17', 'ready', { type: 'Bug' })];
  const show = (
    w: number,
    release: { id: string | null; left: number; openBugs: number } | null,
  ) => {
    width = w;
    spy ??= vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    const r = render(
      <MemoryRouter>
        <div className="tl">
          <ProgressMap
            items={bugItems}
            outside={outside}
            links={links}
            outsideTitle="Outside this epic"
            release={release}
          />
        </div>
      </MemoryRouter>,
    );
    const zoom = within(screen.getByRole('group', { name: 'Zoom' }));
    return {
      ...r,
      fit: zoom.getByRole('button', { name: 'Fit width' }),
      pct: () => zoom.getByRole('button', { name: /^Zoom \d+%/ }).textContent,
      sizer: r.container.querySelector<HTMLElement>('.pm-sizer')!,
      mapWidth: () => parseFloat(r.container.querySelector<HTMLElement>('.pm-map')!.style.width),
    };
  };

  it('fits the width with the Bugs column in it', () => {
    const plain = show(0, null);
    const without = plain.mapWidth();
    plain.unmount();
    const first = show(0, { id: null, left: 0, openBugs: 1 });
    const withBugs = first.mapWidth();
    first.unmount();
    // One more column: the map is wider by a card and a gutter.
    expect(withBugs).toBeGreaterThan(without + 200);
    const view = Math.round(withBugs * 0.8);
    const m = show(view + 44, { id: null, left: 0, openBugs: 1 });
    fireEvent.click(m.fit);
    expect(m.pct()).toBe('80%');
    expect(parseFloat(m.sizer.style.width)).toBeLessThanOrEqual(view);
    expect(m.container.querySelector('[data-col="bugs"] [data-pid="RCP-17"]')).toBeTruthy();
  });
});
