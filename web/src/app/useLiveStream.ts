/**
 * The live stream (contracts/events.md; UI_SPEC §7 "Data from agents
 * arrives"): one `EventSource` on `/api/stream`. Each `event: change`
 * invalidates exactly the query keys `keysForChange` (lib/api.ts) names;
 * there is no second invalidation map here. Lists refetch in place.
 *
 * The connection status is exposed for the reconnecting and unreachable
 * banners, which T086 (lib/live.ts) builds on top.
 */
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { keysForChange, type StreamChange } from '../lib/api';

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'error';

/** Apply one stream message: invalidate its keys. Returns the keys, for tests. */
export function applyChange(queryClient: Pick<QueryClient, 'invalidateQueries'>, data: string) {
  let change: StreamChange;
  try {
    change = JSON.parse(data) as StreamChange;
  } catch {
    return [];
  }
  if (!change || typeof change.type !== 'string' || !Array.isArray(change.objects)) return [];
  const keys = keysForChange(change);
  for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  return keys;
}

export interface StreamHandlers {
  /** Every change message, after invalidation (T085 notifications listen here). */
  onChange?: (change: StreamChange) => void;
}

/**
 * Keep one stream open while `enabled` (the owner session is unlocked).
 * `EventSource` reconnects on its own and resumes with `Last-Event-ID`.
 */
export function useLiveStream(
  queryClient: QueryClient,
  enabled: boolean,
  handlers: StreamHandlers = {},
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('idle');
  const { onChange } = handlers;
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/stream');
    const onOpen = () => setStatus('open');
    const onError = () => setStatus('error');
    const onMessage = (e: MessageEvent<string>) => {
      applyChange(queryClient, e.data);
      if (onChange) {
        try {
          onChange(JSON.parse(e.data) as StreamChange);
        } catch {
          // ignore malformed messages
        }
      }
    };
    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    source.addEventListener('change', onMessage as EventListener);
    return () => {
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      source.removeEventListener('change', onMessage as EventListener);
      source.close();
      setStatus('idle');
    };
  }, [queryClient, enabled, onChange]);
  return status;
}
