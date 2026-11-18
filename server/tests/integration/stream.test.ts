import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { insertItem, insertProject } from '../helpers.js';
import { createTestServer, parseSetCookies, readUntil, type TestServer } from './harness.js';

let s: TestServer;
let cookie: string;
let csrf: string;

beforeEach(async () => {
  s = createTestServer({ keepAliveMs: 60_000 });
  insertProject(s.runtime.db, 'RCP');
  insertItem(s.runtime.db, { id: 'RCP-1' });
  const res = await s.request('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  csrf = cookies.docket_csrf!.value;
  cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${csrf}`;
});
afterEach(async () => {
  await s.cleanup();
});

function emit(
  type: 'item.updated' | 'question.asked' | 'packet.submitted',
  actor: Actor = OWNER_ACTOR,
) {
  return s.runtime.write.run({ actor, operation: 'test', args: { type } }, (ctx) => {
    const inverse = ctx.update('items', 'RCP-1', { title: `After ${type}` });
    ctx.event({ type, summary: type, item_id: 'RCP-1', project_key: 'RCP', inverse: [inverse] });
    return null;
  });
}

const messages = (text: string) =>
  text
    .split('\n\n')
    .filter((block) => block.includes('event: change'))
    .map((block) => ({
      id: /^id: (.*)$/m.exec(block)?.[1],
      data: JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as Record<string, unknown>,
    }));

describe('/api/stream', () => {
  it('pushes committed changes as `event: change` with seq, objects and for_you', async () => {
    const res = await s.request('/api/stream', { headers: { cookie } });
    setTimeout(() => {
      emit('item.updated');
      emit('question.asked', { kind: 'agent', client: 'codex', label: null });
    }, 50);
    const text = await readUntil(res, (t) => messages(t).length >= 2);
    expect(messages(text)).toEqual([
      {
        id: '1',
        data: {
          seq: 1,
          type: 'item.updated',
          objects: [{ kind: 'item', id: 'RCP-1' }],
          for_you: false,
        },
      },
      {
        id: '2',
        data: {
          seq: 2,
          type: 'question.asked',
          objects: [{ kind: 'item', id: 'RCP-1' }],
          for_you: true,
        },
      },
    ]);
  });

  it('starts at the current end without Last-Event-ID', async () => {
    emit('item.updated');
    const res = await s.request('/api/stream', { headers: { cookie } });
    setTimeout(() => emit('packet.submitted'), 50);
    const text = await readUntil(res, (t) => messages(t).length >= 1);
    expect(messages(text).map((m) => m.id)).toEqual(['2']);
  });

  it('resumes after Last-Event-ID', async () => {
    emit('item.updated');
    emit('item.updated');
    emit('packet.submitted');
    const res = await s.request('/api/stream', { headers: { cookie, 'last-event-id': '1' } });
    const text = await readUntil(res, (t) => messages(t).length >= 2);
    expect(messages(text).map((m) => [m.id, m.data.for_you])).toEqual([
      ['2', false],
      ['3', true],
    ]);
  });

  it('shows undo events on the stream too', async () => {
    const change = emit('item.updated');
    const res = await s.request('/api/stream', { headers: { cookie } });
    setTimeout(() => {
      void s.request(`/api/mutations/${change.mutation_id}/undo`, {
        method: 'POST',
        headers: { cookie, 'x-docket-csrf': csrf },
      });
    }, 50);
    const text = await readUntil(res, (t) => messages(t).length >= 1);
    expect(messages(text)[0]!.data).toMatchObject({ seq: 2, type: 'item.updated' });
  });
});

describe('POST /api/mutations/:id/undo', () => {
  it('undoes an owner change and returns the new mutation ID', async () => {
    const change = emit('item.updated');
    const res = await s.request(`/api/mutations/${change.mutation_id}/undo`, {
      method: 'POST',
      headers: { cookie, 'x-docket-csrf': csrf },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mutation_id: string; undone: string };
    expect(body.undone).toBe(change.mutation_id);
    expect(body.mutation_id).toMatch(/^mut_/);
  });

  it('answers 409 conflict for a second undo', async () => {
    const change = emit('item.updated');
    const undo = () =>
      s.request(`/api/mutations/${change.mutation_id}/undo`, {
        method: 'POST',
        headers: { cookie, 'x-docket-csrf': csrf },
      });
    expect((await undo()).status).toBe(200);
    const again = await undo();
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('answers 403 forbidden for an agent change', async () => {
    const change = emit('item.updated', { kind: 'agent', client: 'claude', label: null });
    const res = await s.request(`/api/mutations/${change.mutation_id}/undo`, {
      method: 'POST',
      headers: { cookie, 'x-docket-csrf': csrf },
    });
    expect(res.status).toBe(403);
  });
});
