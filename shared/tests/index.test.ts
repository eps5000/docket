import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../src/index.js';

describe('shared package', () => {
  it('exports the product name used by the server and the UI', () => {
    expect(APP_NAME).toBe('Task Lite');
  });
});
