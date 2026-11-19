// @vitest-environment jsdom
/**
 * Desktop notifications (T085; UI_SPEC §6.7a): only for-you events, once per
 * seq, once per item in a burst, only when on and allowed, only in the tab
 * that claimed the job; the tab title; the Settings status line.
 */
import type { NeedsYouResponse } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamChange } from './api';
import {
  BURST_MS,
  Notifier,
  alreadyNotified,
  markNotified,
  notificationFor,
  readPref,
  statusLine,
  tabTitle,
  writePref,
} from './notifications';

const packetRow = {
  kind: 'packet' as const,
  item_id: 'RCP-12',
  title: 'Weekly planner drag-and-drop',
  project: 'RCP',
  packet_id: 'pkt_1',
  round: 2,
  to_verify: 2,
  estimate: '10 min',
  stale: false,
  built_from_commit: '9c0e7f2',
  submitted_at: '2026-11-06T10:42:00.000Z',
};
const questionRow = {
  kind: 'question' as const,
  item_id: 'DOC-4',
  title: 'API reference: nutrition endpoint',
  project: 'DOC',
  question_id: 'q_1',
  asked_by: 'codex · orca-w2',
  text: 'Should nutrition values be documented per serving or per 100 g? '.repeat(4),
  asked_at: '2026-11-06T10:51:00.000Z',
};
const session = {
  id: 'onb_1',
  project: 'GF',
  project_name: 'Gameflow',
  started_by: 'claude · orca-w3',
  run_id: null,
  state: 'ready_for_review' as const,
  summary: 'Created 12, enriched 30.',
  questions: [],
  changes: { created: 12, enriched: 30, documents: 4, decisions: 3, proposals: 1 },
  workflow_proposal_id: 'afp_1',
  started_at: '2026-11-06T10:00:00.000Z',
  finished_at: '2026-11-06T10:40:00.000Z',
  reviewed_at: null,
};
let reviews: (typeof session)[] = [];
const needsYou = (rows: NeedsYouResponse['for_you_now']): NeedsYouResponse => ({
  for_you_now: rows,
  problems: [],
  deferred: [],
  planning_queue: [],
  agent_counts: {},
  onboarding_reviews: reviews,
});
const change = (seq: number, type: StreamChange['type'], id: string, for_you = true) =>
  ({ seq, type, objects: [{ kind: 'item', id }], for_you }) as StreamChange;

let shown: { title: string; body?: string; tag?: string; click: () => void }[];
let permission: NotificationPermission;

beforeEach(() => {
  localStorage.clear();
  reviews = [];
  shown = [];
  permission = 'granted';
  class FakeNotification {
    static get permission() {
      return permission;
    }
    static requestPermission = () => Promise.resolve(permission);
    onclick: (() => void) | null = null;
    constructor(title: string, opts: NotificationOptions = {}) {
      shown.push({ title, body: opts.body, tag: opts.tag, click: () => this.onclick?.() });
    }
    close() {}
  }
  vi.stubGlobal('Notification', FakeNotification);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function notifier(rows: NeedsYouResponse['for_you_now'], now = () => 1_000_000) {
  const navigate = vi.fn();
  const n = new Notifier({ fetchNeedsYou: async () => needsYou(rows), navigate, now });
  n.start();
  return { n, navigate };
}

describe('tab title', () => {
  it('reads (N) Docket, or Docket when nothing is for you', () => {
    expect(tabTitle(3)).toBe('(3) Docket');
    expect(tabTitle(0)).toBe('Docket');
    expect(tabTitle(undefined)).toBe('Docket');
  });
});

describe('status line', () => {
  it('says On, Off, or Blocked by the browser', () => {
    expect(statusLine('on', 'granted', '127.0.0.1:7420')).toBe('On');
    expect(statusLine('off', 'granted', '127.0.0.1:7420')).toBe('Off');
    expect(statusLine(null, 'default', '127.0.0.1:7420')).toBe('Off');
    expect(statusLine('on', 'denied', '127.0.0.1:7420')).toBe(
      'Blocked by the browser. Allow notifications for 127.0.0.1:7420 in your browser settings.',
    );
  });
});

describe('what a notification says', () => {
  it('packet: "Handoff ready: ID Title", "n things to verify · about 10 min", opens the packet', () => {
    expect(notificationFor(packetRow)).toEqual({
      title: 'Handoff ready: RCP-12 Weekly planner drag-and-drop',
      body: '2 things to verify · about 10 min',
      path: '/review/RCP-12',
      tag: 'tl-packet-RCP-12',
    });
  });
  it('question: "codex asks on DOC-4", the question truncated to 120 characters, opens the item', () => {
    const text = notificationFor(questionRow);
    expect(text.title).toBe('codex asks on DOC-4');
    expect(text.body.length).toBeLessThanOrEqual(120);
    expect(text.body.endsWith('…')).toBe(true);
    expect(text.path).toBe('/items/DOC-4');
  });
});

describe('the notifier', () => {
  it('stays quiet until the owner turns notifications on', async () => {
    const { n } = notifier([packetRow]);
    expect(readPref()).toBeNull();
    expect(await n.handle(change(1, 'packet.submitted', 'RCP-12'))).toBeNull();
    expect(shown).toEqual([]);
  });

  it('notifies once per new packet or question, and a click routes to its target', async () => {
    writePref('on');
    const { n, navigate } = notifier([packetRow, questionRow]);
    await n.handle(change(10, 'packet.submitted', 'RCP-12'));
    await n.handle(change(11, 'question.asked', 'DOC-4'));
    await n.handle(change(10, 'packet.submitted', 'RCP-12')); // the same seq again
    expect(shown.map((s) => s.title)).toEqual([
      'Handoff ready: RCP-12 Weekly planner drag-and-drop',
      'codex asks on DOC-4',
    ]);
    expect(alreadyNotified(10)).toBe(true);
    shown[0]!.click();
    shown[1]!.click();
    expect(navigate.mock.calls).toEqual([['/review/RCP-12'], ['/items/DOC-4']]);
  });

  it('never notifies for anything that is not for you', async () => {
    writePref('on');
    const { n } = notifier([packetRow]);
    expect(await n.handle(change(20, 'item.updated', 'RCP-12', false))).toBeNull();
    expect(await n.handle(change(21, 'run.ended', 'RCP-12', false))).toBeNull();
    expect(shown).toEqual([]);
  });

  it('a finished onboarding notifies once, and opens Needs you (decision 31; T165)', async () => {
    writePref('on');
    reviews = [session];
    const { n, navigate } = notifier([packetRow]);
    const finished = (seq: number) =>
      ({
        seq,
        type: 'onboarding.finished',
        objects: [
          { kind: 'onboarding', id: 'onb_1' },
          { kind: 'project', id: 'GF' },
        ],
        for_you: true,
      }) as StreamChange;
    expect(await n.handle(finished(25))).toEqual({
      title: 'Onboarding ready: Gameflow',
      body: 'claude set it up · 12 created, 30 enriched · review it on Needs you',
      path: '/',
      tag: 'tl-onboarding-onb_1',
    });
    expect(shown.map((s) => s.title)).toEqual(['Onboarding ready: Gameflow']);
    shown[0]!.click();
    expect(navigate.mock.calls).toEqual([['/']]);
    // The same seq never again; a reviewed session never notifies.
    expect(await n.handle(finished(25))).toBeNull();
    reviews = [];
    expect(await n.handle(finished(26))).toBeNull();
    expect(shown).toHaveLength(1);
    // Other onboarding events aren't for you, so they never notify.
    expect(
      await n.handle({
        ...finished(27),
        type: 'onboarding.started',
        for_you: false,
      } as StreamChange),
    ).toBeNull();
  });

  it('a burst on one item notifies once', async () => {
    writePref('on');
    let now = 1_000_000;
    const { n } = notifier([packetRow], () => now);
    await n.handle(change(30, 'packet.submitted', 'RCP-12'));
    now += 1_000;
    await n.handle(change(31, 'packet.submitted', 'RCP-12'));
    expect(shown).toHaveLength(1);
    now += BURST_MS;
    await n.handle(change(32, 'packet.submitted', 'RCP-12'));
    expect(shown).toHaveLength(2);
  });

  it('skips an event already handled by the time it looked (answered, decided)', async () => {
    writePref('on');
    const { n } = notifier([]);
    expect(await n.handle(change(40, 'question.asked', 'DOC-4'))).toBeNull();
  });

  it('with permission denied, nothing notifies', async () => {
    writePref('on');
    permission = 'denied';
    const { n } = notifier([packetRow]);
    expect(await n.handle(change(50, 'packet.submitted', 'RCP-12'))).toBeNull();
  });

  it('only the tab that claimed the job notifies', async () => {
    writePref('on');
    const n = new Notifier({ fetchNeedsYou: async () => needsYou([packetRow]), navigate: vi.fn() });
    expect(await n.handle(change(60, 'packet.submitted', 'RCP-12'))).toBeNull();
    n.start();
    expect(await n.handle(change(61, 'packet.submitted', 'RCP-12'))).not.toBeNull();
    n.stop();
  });

  it('keeps the newest 200 seqs', () => {
    for (let i = 1; i <= 250; i++) markNotified(i);
    expect(alreadyNotified(1)).toBe(false);
    expect(alreadyNotified(250)).toBe(true);
  });
});
