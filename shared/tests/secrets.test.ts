import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors.js';
import { assertNoSecrets, findSecret, scanForSecrets } from '../src/secrets.js';

// Test values are assembled at runtime so no literal credential-shaped string
// sits in the repository (and push protection never sees one).
const join = (...parts: string[]) => parts.join('');
const FAKE = {
  bearer: join('Bear', 'er ', 'eyJhbGciOiJIUzI1NiJ9', '.payload.sig'),
  authorization: join('Authoriz', 'ation: ', 'Basic ', 'dXNlcjpwYXNzd29yZA=='),
  pem: join('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEow\n-----END ', 'RSA PRIVATE KEY-----'),
  pemOpenssh: join('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaA=='),
  sk: join('s', 'k-', 'proj-', 'A1b2C3d4E5f6G7h8I9j0K1l2'),
  skAnt: join('s', 'k-', 'ant-', 'api03-', 'A1b2C3d4E5f6G7h8I9j0'),
  ghp: join('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  githubPat: join('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuv'),
  xox: join('xo', 'xb-', '1234567890-', '1234567890123-', 'AbCdEfGhIjKlMnOp'),
  akia: join('AK', 'IA', 'Z7Q2W4E6R8T0Y1U3'),
};

describe('findSecret', () => {
  it.each([
    ['a Bearer value', FAKE.bearer, 'Bearer token'],
    ['an Authorization header', FAKE.authorization, 'Authorization header'],
    ['a PEM private key', FAKE.pem, 'private key'],
    ['an OpenSSH private key', FAKE.pemOpenssh, 'private key'],
    ['an sk- key', FAKE.sk, 'API key'],
    ['an sk-ant- key', FAKE.skAnt, 'API key'],
    ['a ghp_ token', FAKE.ghp, 'GitHub token'],
    ['a github_pat_ token', FAKE.githubPat, 'GitHub token'],
    ['a Slack xox token', FAKE.xox, 'Slack token'],
    ['an AWS AKIA key', FAKE.akia, 'AWS access key'],
  ])('detects %s', (_name, value, kind) => {
    expect(findSecret(value)).toEqual({ kind });
    // Embedded in prose, too.
    expect(findSecret(`Use this: ${value} and retry.`)).toEqual({ kind });
  });

  it("detects the service's own tokens by value", () => {
    const agentToken = 'tl_9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc';
    const ownerKey = 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43UOV3HO6DZPJQWE3DBMRSA';
    const known = [agentToken, ownerKey];
    expect(findSecret(`token=${agentToken}`, { known })).toEqual({ kind: 'Docket token' });
    expect(findSecret(`key ${ownerKey}`, { known })).toEqual({ kind: 'Docket token' });
    // The base32 owner key is case-insensitive.
    expect(findSecret(ownerKey.toLowerCase(), { known })).toEqual({ kind: 'Docket token' });
  });

  it.each([
    'Implement unit merging (g/kg, ml/l, cups)',
    'Use scikit-learn for clustering; sk-learn is a common misspelling.',
    'The bearer of bad news',
    'Authorization is checked in the domain layer',
    'See RCP-14 and github_pat docs',
    'AKIA is the AWS access key prefix',
    'Rotate the -----BEGIN CERTIFICATE----- block',
    '',
  ])('accepts ordinary text: %j', (text) => {
    expect(findSecret(text)).toBeNull();
  });

  it('ignores empty known values', () => {
    expect(findSecret('anything at all', { known: ['', '   '] })).toBeNull();
  });
});

describe('scanForSecrets', () => {
  it('finds a secret anywhere in nested input and reports its path, never its value', () => {
    const input = {
      title: 'Fine',
      steps: [{ text: 'ok' }, { text: `token ${FAKE.ghp}` }],
      meta: { note: null, count: 3 },
    };
    const hit = scanForSecrets(input);
    expect(hit).toEqual({ path: 'steps[1].text', kind: 'GitHub token' });
    expect(JSON.stringify(hit)).not.toContain(FAKE.ghp);
  });

  it('returns null for clean input', () => {
    expect(scanForSecrets({ a: ['x', { b: 'y' }], c: 1, d: true, e: null })).toBeNull();
  });
});

describe('assertNoSecrets', () => {
  it('throws a validation ToolError whose message names the kind but not the value', () => {
    let error: unknown;
    try {
      assertNoSecrets({ description_md: `Header: ${FAKE.bearer}` });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ToolError);
    const toolError = error as ToolError;
    expect(toolError.code).toBe('validation');
    expect(toolError.message).toBe('Looks like a secret (Bearer token); remove it and retry.');
    expect(toolError.details).toEqual({ field: 'description_md' });
    const serialised = JSON.stringify(toolError.toJSON()) + String(toolError.stack);
    expect(serialised).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('passes clean input through', () => {
    expect(() => assertNoSecrets({ title: 'Generate shopping list' })).not.toThrow();
  });
});
