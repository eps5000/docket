/**
 * B40 (decision 36; BUILD_SPEC §5.21 B40): the radar finds an in-flight
 * item's branch by name. A branch matches when it holds the item's key, or
 * its Jira key, as a whole token, in any case, with or without the hyphen.
 * The fixture-repo run (discovered, ambiguous and reported, with the
 * read-only proof) is in us18-shared-contracts.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { branchesNaming, keyPattern } from '../../src/domain/radar.js';

const BRANCHES = [
  'eps5000/gf-239-visual-shell',
  'feature/GAMEFLOW-280-x',
  'gf-281-a',
  'gf-281-b',
  'gf-2390-decoy',
  'spike/shell-rework',
  'main',
];

describe('keyPattern', () => {
  it('matches the key as a whole token, in any case, with or without the hyphen', () => {
    const p = keyPattern('GF-239')!;
    for (const name of [
      'gf-239',
      'GF-239',
      'gf239',
      'eps5000/gf-239-visual-shell',
      'wip/GF239_x',
    ]) {
      expect(p.test(name), name).toBe(true);
    }
    for (const name of ['gf-2390', 'xgf-239', 'gf-23', 'gf--239', 'agf239', 'gf-239a', 'g-239']) {
      expect(p.test(name), name).toBe(false);
    }
  });

  it('is null for a key of another shape', () => {
    expect(keyPattern('not a key')).toBeNull();
    expect(keyPattern('GF')).toBeNull();
    expect(keyPattern('239')).toBeNull();
  });
});

describe('branchesNaming', () => {
  it('finds one branch by key, one by Jira key, and both of an ambiguous pair', () => {
    expect(branchesNaming(['GF-239', null], BRANCHES)).toEqual(['eps5000/gf-239-visual-shell']);
    expect(branchesNaming(['GF-280', 'GAMEFLOW-280'], BRANCHES)).toEqual([
      'feature/GAMEFLOW-280-x',
    ]);
    expect(branchesNaming(['GF-281', null], BRANCHES)).toEqual(['gf-281-a', 'gf-281-b']);
    expect(branchesNaming(['GF-300', 'GAMEFLOW-300'], BRANCHES)).toEqual([]);
  });
});
