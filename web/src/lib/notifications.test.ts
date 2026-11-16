// @vitest-environment jsdom
/**
 * Desktop notifications (T085; UI_SPEC §6.7a): only for-you events, once per
 * seq, once per item in a burst, only when on and allowed, only in the tab
 * that claimed the job; the tab title; the Settings status line.
 */
import type { NeedsYouResponse } from '@tasklite/shared';
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
const needsYou = (rows: NeedsYouResponse['for_you_now']): NeedsYouResponse => ({
  for_you_now: rows,
  problems: [],
  deferred: [],
  planning_queue: [],
  agent_counts: {},
});
const change = (seq: number, type: StreamChange['type'], id: string, for_you = true) =>
  ({ seq, type, objects: [{ kind: 'item', id }], for_you }) as StreamChange;

let shown: { title: string; body?: string; tag?: string; click: () => void }[];
let permission: NotificationPermission;

beforeEach(() => {
  localStorage.clear();
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
  it('reads (N) Task Lite, or Task Lite when nothing is for you', () => {
    expect(tabTitle(3)).toBe('(3) Task Lite');
    expect(tabTitle(0)).toBe('Task Lite');
    expect(tabTitle(undefined)).toBe('Task Lite');
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
