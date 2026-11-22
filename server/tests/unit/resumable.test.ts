/**
 * The `resumable` filter (BUILD_SPEC §13: `status:progress -has:lead`), with
 * the gate-review rule for epics: an Epic is resumable only if it has ever
 * had a lead run. Epic status is set by hand, so an epic stays In progress
 * while its children are worked; it must not show up as work to resume.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isResumable } from '../../src/domain/model.js';
import { endRunsAsOldRestart, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
beforeEach(() => {
  d = startDomain();
});
afterEach(() => d.cleanup());

const resumable = () =>
  d.services.search
    .searchItems(d.read(d.agent('claude')), {
      filter: 'resumable',
      include_archived: true,
      limit: 50,
    })
    .items.map((i) => i.id);

describe('resumable', () => {
  it('the seeded epics in progress (RCP-1, DOC-10), never claimed, are not resumable', () => {
    expect(d.row("SELECT type, status FROM items WHERE id = 'RCP-1'")).toEqual({
      type: 'Epic',
      status: 'progress',
    });
    expect(resumable()).not.toContain('RCP-1');
    expect(resumable()).not.toContain('DOC-10');
    expect(isResumable(d.server.runtime.db, 'RCP-1')).toBe(false);
  });

  it('an epic whose lead run ended interrupted is resumable', () => {
    d.write(d.agent('claude'), (w, s) => s.runs.claim(w, { id: 'RCP-1' }));
    expect(resumable()).not.toContain('RCP-1'); // led now
    endRunsAsOldRestart(d.server.runtime);
    expect(
      d.row("SELECT state, end_reason FROM runs WHERE item_id = 'RCP-1' AND is_lead = 1"),
    ).toEqual({
      state: 'interrupted',
      end_reason: 'service_restart',
    });
    expect(resumable()).toContain('RCP-1');
    expect(isResumable(d.server.runtime.db, 'RCP-1')).toBe(true);
  });

  it('Stories, Tasks and Bugs keep the literal rule: In progress with no lead', () => {
    // RCP-18: a Task whose lead run failed.
    expect(resumable()).toContain('RCP-18');
    // DOC-5: a Task moved to In progress without ever being claimed.
    d.write(d.agent('claude'), (w, s) => s.items.setStatus(w, { id: 'DOC-5', status: 'progress' }));
    expect(resumable()).toContain('DOC-5');
    // Led items are not resumable.
    expect(resumable()).not.toContain('RCP-14');
    expect(isResumable(d.server.runtime.db, 'RCP-14')).toBe(false);
  });
});
