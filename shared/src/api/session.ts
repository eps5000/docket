/**
 * Owner session routes (BUILD_SPEC §3, §7; contracts/ui-api.md US10).
 * Implemented in B2; declared here so the client and the route contract
 * test share them. Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { input, jsonResponse, noInput } from './common.js';
import { json, route } from './route.js';

export const unlockBody = input({ key: z.string().min(1).max(200) });

export const sessionRoutes = {
  'session.unlock': route({
    method: 'POST',
    path: '/api/session/unlock',
    group: 'session',
    auth: 'none',
    params: noInput,
    query: noInput,
    body: unlockBody,
    response: json(jsonResponse({ unlocked: z.literal(true) })),
  }),
  'session.lock': route({
    method: 'POST',
    path: '/api/session/lock',
    group: 'session',
    params: noInput,
    query: noInput,
    body: noInput,
    response: json(jsonResponse({ locked: z.literal(true) })),
  }),
  /** Writes a new owner key and ends every session; never returns the key (decided in B2). */
  'session.rotateKey': route({
    method: 'POST',
    path: '/api/session/rotate-key',
    group: 'session',
    params: noInput,
    query: noInput,
    body: noInput,
    response: json(jsonResponse({ rotated: z.literal(true) })),
  }),
} as const;
