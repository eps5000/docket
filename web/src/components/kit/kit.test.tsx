// @vitest-environment jsdom
/**
 * Kit behaviour that matters (tasks.md T057): ARIA tabs keyboard, dialog
 * focus, Section persistence, the inline editor's Ctrl+Enter and Esc, toast
 * timing, and the state → appearance rules of UI_SPEC §5.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATES, RUN_STATE_LABELS, type ItemWait } from '@docket/shared';
import { STORAGE_KEYS } from '../../lib/persistence';
import {
  Button,
  Dialog,
  DialogCancel,
  EpicCard,
  DecisionAuthorityBadge,
  EditableText,
  ErrorState,
  InlineEditor,
  Priority,
  PROVENANCE,
  Provenance,
  RunLine,
  RunState,
  Section,
  parkedReason,
  Skeleton,
  TicketCard,
  ToastRegion,
  TOAST_MS,
  TOAST_UNDO_MS,
  ViewTabs,
  type ProvenanceKind,
  type ToastData,
} from './index';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

// ---- ViewTabs ----

function Tabs() {
  const [active, setActive] = useState<'details' | 'checklist' | 'deps' | 'activity'>('details');
  return (
    <ViewTabs
      label="Ticket views"
      active={active}
      onChange={setActive}
      tabs={[
        { key: 'details', label: 'Details' },
        {
          key: 'checklist',
          label: 'Checklist',
          count: '2/4',
          dot: { tone: 'warn', text: 'packet ready' },
        },
        {
          key: 'deps',
          label: 'Dependencies',
          count: 0,
          dot: { tone: 'bad', text: 'in a dependency cycle' },
        },
        { key: 'activity', label: 'Activity' },
      ]}
    >
      <p>Panel {active}</p>
    </ViewTabs>
  );
}

describe('ViewTabs (ARIA tabs)', () => {
  it('renders a tablist with one selected, focusable tab and a labelled panel', () => {
    render(<Tabs />);
    const list = screen.getByRole('tablist', { name: 'Ticket views' });
    const tabs = screen.getAllByRole('tab');
    expect(list).toBeTruthy();
    expect(tabs).toHaveLength(4);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]!.id);
  });

  it('moves with the arrow keys, wraps, and jumps with Home and End', async () => {
    const user = userEvent.setup();
    render(<Tabs />);
    const tab = (name: RegExp) => screen.getByRole('tab', { name });
    await user.click(tab(/^Details/));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tab(/^Checklist/));
    expect(tab(/^Checklist/).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Panel checklist')).toBeTruthy();
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(tab(/^Activity/));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tab(/^Details/));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(tab(/^Activity/));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(tab(/^Details/));
  });

  it('shows counts as muted text, hides zero counts, and gives dots sr-only text', () => {
    render(<Tabs />);
    const checklist = screen.getByRole('tab', { name: /^Checklist/ });
    expect(checklist.textContent).toContain('2/4');
    expect(checklist.textContent).toContain('(packet ready)');
    const deps = screen.getByRole('tab', { name: /^Dependencies/ });
    expect(deps.querySelector('.count')).toBeNull();
    expect(deps.querySelector('.tabdot.bad')).toBeTruthy();
    expect(deps.textContent).toContain('(in a dependency cycle)');
  });
});

// ---- Dialog ----

function DialogHarness({ destructive = false }: { destructive?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      {open && (
        <Dialog
          title="Release lead claim on RCP-15?"
          destructive={destructive}
          onClose={() => setOpen(false)}
          footer={
            <>
              <DialogCancel onClick={() => setOpen(false)} />
              <Button variant="danger">Release claim</Button>
            </>
          }
        >
          <label htmlFor="why">Why</label>
          <input id="why" />
        </Dialog>
      )}
    </>
  );
}

describe('Dialog', () => {
  it('is a labelled modal dialog that focuses its first field', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dlg = screen.getByRole('dialog', { name: 'Release lead claim on RCP-15?' });
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('Why'));
  });

  it('focuses Cancel first when destructive', async () => {
    const user = userEvent.setup();
    render(<DialogHarness destructive />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('traps Tab inside the dialog in both directions', async () => {
    const user = userEvent.setup();
    render(<DialogHarness destructive />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dlg = screen.getByRole('dialog');
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await user.tab({ shift: true });
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
  });

  it('closes on Esc and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<DialogHarness destructive />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

// ---- Section ----

describe('Section (collapsible, per-type persistence)', () => {
  it('toggles with aria-expanded, renders only the header when collapsed, and remembers per type', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <Section sectionKey="work" title="Work" summary="2/4 done · the agent's plan">
        <p>Steps</p>
      </Section>,
    );
    const toggle = screen.getByRole('button', { name: /Work/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Steps')).toBeTruthy();

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Steps')).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.collapsed)!)).toEqual({ work: true });
    unmount();

    // The next ticket's Work section starts collapsed; other types don't.
    render(
      <>
        <Section sectionKey="work" title="Work">
          <p>Other steps</p>
        </Section>
        <Section sectionKey="agentrev" title="Agent review">
          <p>Checks</p>
        </Section>
      </>,
    );
    expect(screen.queryByText('Other steps')).toBeNull();
    expect(screen.getByText('Checks')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /^Work/ }));
    expect(screen.getByText('Other steps')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.collapsed)!)).toEqual({});
  });

  it('starts collapsed with defaultCollapsed, and remembers that you opened it (B20)', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <Section
        sectionKey="agents-recent"
        title="Recent"
        summary="2 in the last 24 h"
        defaultCollapsed
      >
        <p>Recent runs</p>
      </Section>,
    );
    const toggle = screen.getByRole('button', { name: /Recent/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Recent runs')).toBeNull();
    // Nothing is stored while it matches its default.
    expect(localStorage.getItem(STORAGE_KEYS.collapsed)).toBeNull();

    await user.click(toggle);
    expect(screen.getByText('Recent runs')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.collapsed)!)).toEqual({
      'agents-recent': false,
    });
    unmount();

    render(
      <Section sectionKey="agents-recent" title="Recent" defaultCollapsed>
        <p>Still open</p>
      </Section>,
    );
    expect(screen.getByText('Still open')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Recent/ }));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.collapsed)!)).toEqual({});
  });

  it('toggles from the keyboard (Enter and Space)', async () => {
    const user = userEvent.setup();
    render(
      <Section sectionKey="docs" title="Documents">
        <p>Doc list</p>
      </Section>,
    );
    const toggle = screen.getByRole('button', { name: /Documents/ });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard(' ');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

// ---- Inline editor ----

describe('InlineEditor', () => {
  it('focuses the field, saves with Ctrl+Enter, and cancels clean with Esc', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => true);
    const onCancel = vi.fn();
    render(
      <InlineEditor
        field="outcome"
        initial="Old"
        multiline
        maxLength={20000}
        onSave={onSave}
        onCancel={onCancel}
      />,
    );
    const box = screen.getByLabelText('Edit outcome');
    expect(document.activeElement).toBe(box);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.type(box, ' and new');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSave).toHaveBeenCalledWith('Old and new');
  });

  it('asks to confirm before Esc discards a change', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <InlineEditor
        field="title"
        initial="Planner"
        maxLength={200}
        onSave={() => true}
        onCancel={onCancel}
      />,
    );
    await user.type(screen.getByLabelText('Edit title'), ' v2');
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Discard your changes to the title?');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a counter from 80% of the limit and blocks saving over it', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => true);
    render(
      <InlineEditor
        field="title"
        initial={'x'.repeat(7)}
        maxLength={10}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText(/\/ 10/)).toBeNull();
    await user.type(screen.getByLabelText('Edit title'), 'x');
    expect(screen.getByText('8 / 10')).toBeTruthy();
    await user.type(screen.getByLabelText('Edit title'), 'xxx');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('EditableText opens from "Edit title" and returns focus to it on close', async () => {
    const user = userEvent.setup();
    render(
      <EditableText field="title" value="Planner" maxLength={200} onSave={() => true}>
        <h1>Planner</h1>
      </EditableText>,
    );
    const edit = screen.getByRole('button', { name: 'Edit title' });
    await user.click(edit);
    expect(document.activeElement).toBe(screen.getByLabelText('Edit title'));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit title' }));
  });
});

// ---- Toast ----

describe('Toast', () => {
  function Region({ initial }: { initial: ToastData[] }) {
    const [toasts, setToasts] = useState(initial);
    return (
      <ToastRegion
        toasts={toasts}
        onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))}
      />
    );
  }

  it('lives in a role=status region and lasts 3.2 s, or 6 s with Undo', () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    render(
      <Region
        initial={[
          { id: 1, message: 'Saved.' },
          { id: 2, message: 'Archived RCP-11.', onUndo: undo },
        ]}
      />,
    );
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Saved.');
    act(() => vi.advanceTimersByTime(TOAST_MS + 1));
    expect(region.textContent).not.toContain('Saved.');
    expect(region.textContent).toContain('Archived RCP-11.');
    act(() => vi.advanceTimersByTime(TOAST_UNDO_MS - TOAST_MS));
    expect(region.textContent).not.toContain('Archived RCP-11.');
    expect(TOAST_MS).toBe(3200);
    expect(TOAST_UNDO_MS).toBe(6000);
  });

  it('calls onUndo and closes when Undo is pressed', () => {
    const undo = vi.fn();
    render(<Region initial={[{ id: 3, message: 'Archived.', onUndo: undo }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

// ---- State → appearance (UI_SPEC §5) ----

describe('state → appearance', () => {
  it('renders every run state with an icon, its shared label and its meaning in title', () => {
    for (const state of RUN_STATES) {
      const { container, unmount } = render(<RunState state={state} age="40s" />);
      const el = container.querySelector('.run')!;
      expect(el.getAttribute('title')).toBe(RUN_STATE_LABELS[state].meaning);
      expect(el.querySelector(`.ri-${state}`)).toBeTruthy();
      expect(el.textContent).toContain(RUN_STATE_LABELS[state].label);
      unmount();
    }
  });

  it('shows a parked run as "parked · waiting on RCP-12", never as finished', () => {
    const { container } = render(<RunState state="parked" detail="waiting on RCP-12" />);
    expect(container.textContent).toBe('parked · waiting on RCP-12');
    expect(container.querySelector('.ri-finished')).toBeNull();
  });

  it('keeps provenance distinct: only owner decisions are solid, and only approval is green', () => {
    const solid = (Object.keys(PROVENANCE) as ProvenanceKind[]).filter((k) =>
      PROVENANCE[k].cls.startsWith('pv-owner'),
    );
    expect(solid.sort()).toEqual(['owner_approve', 'owner_changes', 'owner_defer']);
    const classes = new Set(Object.values(PROVENANCE).map((p) => p.cls));
    expect(classes.size).toBe(Object.keys(PROVENANCE).length);
    const { container } = render(<Provenance kind="agent" label="PR merged" />);
    expect(container.textContent).toBe('Agent-reported: PR merged');
  });

  it('gives decision authority an outline badge, never a provenance fill', () => {
    const { container } = render(
      <>
        <DecisionAuthorityBadge authority="owner" />
        <DecisionAuthorityBadge authority="agent" agent="claude" />
      </>,
    );
    const badges = [...container.querySelectorAll('.auth')];
    expect(badges.map((b) => b.textContent)).toEqual(['Owner', 'Agent · claude']);
    expect(container.querySelector('[class*="pv-owner"]')).toBeNull();
  });

  it('labels priority for screen readers', () => {
    const { container } = render(<Priority p={1} />);
    expect(container.textContent).toBe('Priority P1');
    expect(container.querySelector('[title="Priority 1"]')).toBeTruthy();
  });
});

// ---- TicketCard ----

const baseItem = {
  id: 'RCP-14',
  project: 'RCP',
  type: 'Implementation' as const,
  title: 'Generate shopping list from week plan',
  status: 'progress' as const,
  priority: 1 as const,
  epic: 'RCP-1',
  epic_title: 'Meal planning MVP',
  labels: ['mobile'],
  blocked: false,
  blocked_by: [],
  unblocks: 2,
  lead: null,
  human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
  planned_start: null,
  planned_end: null,
  effort: null,
  archived: false,
  jira_key: null,
  version: 1,
  updated_at: '2026-11-06T10:59:00Z',
  packet_ready: false,
  for_you: false,
  last_activity_at: '2026-11-06T10:59:20Z',
};

const NBSP = String.fromCharCode(0xa0);

describe('RunLine and parkedReason (B20)', () => {
  it('renders state · reason · agent, then the age, with the meaning in title', () => {
    const { container } = render(
      <RunLine state="stale" reason="silent 47m" agent="codex · orca-w1" age="2m" />,
    );
    const line = container.querySelector('.runline')!;
    expect(line.classList.contains('rs-stale')).toBe(true);
    expect(line.getAttribute('title')).toBe(
      `stale · silent 47m · codex · orca-w1: ${RUN_STATE_LABELS.stale.meaning}`,
    );
    expect(line.querySelector('.rl')!.textContent).toBe(
      `stale${NBSP}· silent 47m${NBSP}· codex · orca-w1`,
    );
    expect(line.querySelector('.rl-age')!.textContent).toBe('2m');
  });

  it('omits empty segments', () => {
    const { container } = render(<RunLine state="live" />);
    expect(container.querySelector('.rl')!.textContent).toBe('live');
  });

  it('says what a parked run waits on', () => {
    expect(parkedReason({ items: ['RCP-12'] })).toBe('waiting on RCP-12');
    expect(parkedReason({ orchestrator: true })).toBe('waiting on the coordinator');
    expect(parkedReason({ person: true })).toBe('waiting on a person');
    expect(parkedReason({ items: ['RCP-12'], person: true })).toBe(
      'waiting on RCP-12 and a person',
    );
    expect(parkedReason({ until: '2026-11-20T10:00:00' })).toMatch(
      /^waiting until Nov 20 \d\d:\d\d$/,
    );
    expect(parkedReason({})).toBeUndefined();
  });
});

describe('TicketCard', () => {
  it('shows no run line when unclaimed', () => {
    const { container } = render(
      <MemoryRouter>
        <TicketCard item={baseItem} />
      </MemoryRouter>,
    );
    expect(container.querySelector('.run, .runline')).toBeNull();
    expect(container.querySelector('a.tcard')!.getAttribute('href')).toBe('/items/RCP-14');
  });

  it('shows the run state with lead and age when claimed', () => {
    const { container } = render(
      <MemoryRouter>
        <TicketCard
          item={{
            ...baseItem,
            lead: { client: 'claude', label: 'orca-w3', run_id: 'r-1', run_state: 'live' },
          }}
          now={new Date('2026-11-06T11:00:00Z')}
        />
      </MemoryRouter>,
    );
    expect(container.querySelector('.runline.rs-live')).toBeTruthy();
    expect(container.textContent).toContain('claude · orca-w3');
    expect(container.textContent).toContain('40s');
  });

  it('shows a parked lead as one line: state · what it waits on · agent (B20)', () => {
    const { container } = render(
      <MemoryRouter>
        <TicketCard
          item={{
            ...baseItem,
            lead: { client: 'claude', label: 'orca-w4', run_id: 'r-2', run_state: 'parked' },
            lead_parked: {
              waiting_on: { orchestrator: true },
              since: '2026-11-06T10:57:00Z',
              resume_ready: false,
            },
          }}
        />
      </MemoryRouter>,
    );
    const lines = container.querySelectorAll('.runline');
    expect(lines).toHaveLength(1);
    const text = lines[0]!.querySelector('.rl')!.textContent!;
    // The separators are glued to the segment before them: no line starts with "·".
    expect(text).toBe(
      ['parked', 'waiting on the coordinator', 'claude · orca-w4'].join(`${NBSP}· `),
    );
    // The full line is in the title, since the card cuts it off with an ellipsis.
    expect(lines[0]!.getAttribute('title')).toBe(
      `parked · waiting on the coordinator · claude · orca-w4: ${RUN_STATE_LABELS.parked.meaning}`,
    );
  });

  it('decision 57: Queued is calm and Blocked is red, each in words with why', () => {
    const wait = (over: Partial<ItemWait>): ItemWait => ({
      kind: 'queued',
      reason: null,
      after: 'RCP-14',
      more: 2,
      on: null,
      text: 'Starts after RCP-14 and 2 more',
      ...over,
    });
    const { container } = render(
      <MemoryRouter>
        <TicketCard
          item={{
            ...baseItem,
            id: 'RCP-21',
            status: 'ready',
            blocked: true,
            blocked_by: ['RCP-14'],
            wait: wait({}),
          }}
        />
        <TicketCard
          item={{
            ...baseItem,
            id: 'RCP-22',
            status: 'ready',
            blocked: true,
            blocked_by: ['RCP-9'],
            wait: wait({
              kind: 'blocked',
              reason: 'canceled',
              on: 'RCP-9',
              more: 0,
              after: 'RCP-9',
              text: 'RCP-9 was canceled, so it never clears',
            }),
          }}
        />
        <TicketCard
          item={{
            ...baseItem,
            id: 'RCP-23',
            status: 'ready',
            blocked: true,
            blocked_by: ['RCP-8'],
            wait: wait({
              kind: 'held',
              reason: 'paused',
              text: 'Held by your decision “Pause for the launch”',
            }),
          }}
        />
      </MemoryRouter>,
    );
    const [queued, blocked, held] = [...container.querySelectorAll('a.tcard')];
    expect(queued!.classList.contains('isqueued')).toBe(true);
    expect(queued!.classList.contains('isblocked')).toBe(false);
    expect(queued!.querySelector('.st-queued')!.textContent).toBe(
      '◷ Queued · Starts after RCP-14 and 2 more',
    );
    expect(queued!.querySelector('.st-blocked')).toBeNull();
    expect(blocked!.classList.contains('isblocked')).toBe(true);
    const chip = blocked!.querySelector('.st-blocked')!;
    expect(chip.textContent).toBe('⊘ Blocked · Canceled blocker · RCP-9');
    expect(chip.getAttribute('title')).toBe('RCP-9 was canceled, so it never clears');
    expect(held!.classList.contains('isblocked')).toBe(false);
    expect(held!.classList.contains('isqueued')).toBe(false);
    expect(held!.textContent).toContain('Held by your decision');
  });

  it('marks blocked and for-you edges and opens the packet for Review cards with one ready', () => {
    const { container } = render(
      <MemoryRouter>
        <TicketCard
          item={{ ...baseItem, id: 'RCP-12', status: 'review', packet_ready: true, for_you: true }}
        />
        <TicketCard
          item={{
            ...baseItem,
            id: 'RCP-16',
            status: 'ready',
            blocked: true,
            blocked_by: ['DOC-4'],
          }}
        />
      </MemoryRouter>,
    );
    const [review, blocked] = [...container.querySelectorAll('a.tcard')];
    expect(review!.classList.contains('owed')).toBe(true);
    expect(review!.getAttribute('href')).toBe('/review/RCP-12');
    expect(review!.getAttribute('title')).toBe('Open the handoff packet');
    expect(blocked!.classList.contains('isblocked')).toBe(true);
    expect(blocked!.textContent).toContain('Blocked by DOC-4');
  });

  it('puts Archive outside the card link on done cards', () => {
    const onArchive = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <TicketCard item={{ ...baseItem, status: 'done' }} onArchive={onArchive} />
      </MemoryRouter>,
    );
    const btn = screen.getByRole('button', { name: 'Archive' });
    expect(container.querySelector('a.tcard')!.contains(btn)).toBe(false);
    fireEvent.click(btn);
    expect(onArchive).toHaveBeenCalled();
  });
});

describe('EpicCard (B35: empty epics)', () => {
  const epic = (total: number, done = 0) => ({
    ...baseItem,
    id: 'STR-1',
    type: 'Epic' as const,
    epic: null,
    epic_title: null,
    children: {
      total,
      done,
      by_status: total ? { done, progress: total - done } : {},
      for_you: 0,
      queued: 0,
      blocked: 0,
    },
  });

  it('says "No tickets yet · Status" and draws no bar when the epic has no tickets', () => {
    const { container } = render(
      <MemoryRouter>
        <EpicCard epic={epic(0)} />
      </MemoryRouter>,
    );
    expect(container.querySelector('a.epiccard')!.textContent).toContain(
      'No tickets yet · In progress',
    );
    expect(container.textContent).not.toContain('0/0');
    expect(container.querySelector('.pbar')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('keeps the bar and "n/N done" when it has tickets', () => {
    render(
      <MemoryRouter>
        <EpicCard epic={epic(4, 1)} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('img', { name: '1 of 4 done' })).toBeTruthy();
    expect(screen.getByText('1/4 done · In progress', { exact: false })).toBeTruthy();
  });
});

// ---- Screen states ----

describe('screen states', () => {
  it('shows the skeleton only after 200 ms', () => {
    vi.useFakeTimers();
    render(<Skeleton />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => vi.advanceTimersByTime(199));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => vi.advanceTimersByTime(2));
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
  });

  it('renders a 501 as "Not built yet" with the code, the message and Retry', () => {
    const retry = vi.fn();
    render(
      <ErrorState
        error={{
          status: 501,
          code: 'unavailable',
          message: 'Not implemented yet: GET /api/needs-you',
        }}
        onRetry={retry}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-error-state')).toBe('not-built');
    expect(alert.textContent).toContain('Not built yet.');
    expect(alert.textContent).toContain('unavailable');
    expect(alert.textContent).toContain('Not implemented yet: GET /api/needs-you');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });
});
