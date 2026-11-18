/**
 * Secret detection for every write (MCP_SPEC §3.4, constitution Principle VI).
 * Text that looks like a credential is rejected with `validation`, and the
 * error never repeats the value, so nothing secret is stored or logged.
 * The domain layer runs this, so MCP and the UI API share it.
 */
import { ToolError } from './errors.js';

export interface SecretMatch {
  /** What it looks like, for the error message. Never the value. */
  kind: string;
}

export interface SecretOptions {
  /** The service's own secrets (agent token, owner key), matched by value. */
  known?: readonly string[];
}

const PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: 'private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  // `Authorization: <scheme> <value>`, as in a pasted header.
  { kind: 'Authorization header', re: /\bauthorization\s*:\s*(?!bearer\b)[a-z]+\s+\S{8,}/i },
  { kind: 'Bearer token', re: /\bbearer\s+[a-z0-9\-._~+/]{12,}=*/i },
  { kind: 'API key', re: /\bsk-[a-z0-9][a-z0-9_-]{15,}/i },
  { kind: 'GitHub token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { kind: 'Slack token', re: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
];

/** Shortest known secret we match by value; shorter strings would cause false positives. */
const MIN_KNOWN_LENGTH = 16;

/** The first secret-looking thing in `text`, or null. */
export function findSecret(text: string, opts: SecretOptions = {}): SecretMatch | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const value of opts.known ?? []) {
    const known = value.trim();
    if (known.length >= MIN_KNOWN_LENGTH && lower.includes(known.toLowerCase())) {
      return { kind: 'Docket token' };
    }
  }
  for (const { kind, re } of PATTERNS) {
    if (re.test(text)) return { kind };
  }
  return null;
}

/** Walk any input (objects, arrays, strings) and report the first secret with its field path. */
export function scanForSecrets(
  value: unknown,
  opts: SecretOptions = {},
  path = '',
): { path: string; kind: string } | null {
  if (typeof value === 'string') {
    const hit = findSecret(value, opts);
    return hit ? { path, kind: hit.kind } : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scanForSecrets(value[i], opts, `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const hit = scanForSecrets(child, opts, path ? `${path}.${key}` : key);
      if (hit) return hit;
    }
  }
  return null;
}

/** Throw `validation` if anything in `value` looks like a secret. */
export function assertNoSecrets(value: unknown, opts: SecretOptions = {}): void {
  const hit = scanForSecrets(value, opts);
  if (hit) {
    throw new ToolError('validation', `Looks like a secret (${hit.kind}); remove it and retry.`, {
      details: { field: hit.path },
    });
  }
}
