// @vitest-environment jsdom
/**
 * The progress map (UI_SPEC §6.3.4; tasks.md T108): wave layout, the outside
 * and cycle columns, the header counts, zoom steps and Fit, arrows, hover
 * tracing and keyboard panning.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinkEdge, Status } from '@tasklite/shared';
import {
  FIT_MIN,
  ProgressMap,
  arrowPath,
  cyclePath,
  cyclesIn,
  fitZoom,
  layoutMap,
  stepZoom,
  type MapItem,
} from './index';

afterEach(cleanup);

function item(id: string, status: Status = 'ready', extra: Partial<MapItem> = {}): MapItem {
  return {
    id,
    project: id.split('-')[0]!,
    type: 'Story',
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
  item('RCP-16', 'ready', { blocked: true, blocked_by: ['DOC-4'] }),
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
      readyButBlocked: 4,
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

  it('zoom steps are 50, 67, 80, 100 and 125%, and Fit goes down to 40% but never above 100%', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1.25, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.8);
    expect(stepZoom(0.8, -1)).toBe(0.67);
    expect(stepZoom(0.67, -1)).toBe(0.5);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(0.45, 1)).toBe(0.5); // from a Fit value between steps
    expect(fitZoom({ width: 4000, height: 400 }, { width: 800, height: 500 })).toBe(FIT_MIN);
    expect(fitZoom({ width: 1000, height: 400 }, { width: 800, height: 500 })).toBe(0.8);
    expect(fitZoom({ width: 300, height: 200 }, { width: 800, height: 500 })).toBe(1);
  });

  it('an arrow is a cubic curve from the right edge to just before the left edge', () => {
    expect(arrowPath({ right: 200, midY: 40 }, { left: 276, midY: 100 })).toBe(
      'M200,40 C238,40 238,100 273,100',
    );
  });
});

/** A card by its item ID. */
const cardOf = (id: string) =>
  screen.getAllByRole('button').find((b) => b.dataset.pid === id) as HTMLButtonElement;

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

  it('renders the header, the columns in order and the key', () => {
    const { container } = view();
    expect(container.querySelector('.pm-big')!.textContent).toBe('1 / 9 done');
    expect(
      screen.getByRole('img', { name: /1 done, 1 review, 1 in progress, 5 ready/i }),
    ).toBeTruthy();
    expect(screen.getByText('4 ready but blocked')).toBeTruthy();
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
      name: /^Story RCP-22 Title of RCP-22 Ready · blocked$/,
    });
    expect(blocked.className).toContain('blk');
    expect(within(blocked).getByText('· blocked')).toBeTruthy();
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
    const pct = () => screen.getByRole('button', { name: /^Zoom \d+%/ }).textContent;
    expect(pct()).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(pct()).toBe('125%');
    expect((screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Zoom 125%/ }));
    expect(pct()).toBe('100%');
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(pct()).toBe('50%');
    const fit = screen.getByRole('button', { name: 'Fit' });
    fireEvent.click(fit);
    expect(fit.getAttribute('aria-pressed')).toBe('true');
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
