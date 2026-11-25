/**
 * The GitHub source (owner decision 49). See README.md for the source contract.
 * Read-only, through the `gh` login already on this machine.
 */
import { createGh } from '../lib/gh.mjs';
import { collectWith } from '../lib/github.mjs';

export const name = 'github';
export const intervalMs = 60_000;

/** On in Settings, with at least one project's repository set. */
export const enabled = (settings) =>
  settings?.enabled === true && Array.isArray(settings.repos) && settings.repos.length > 0;

export const collect = (ctx) => collectWith(createGh(), ctx);
