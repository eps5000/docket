// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRenderLimit } from './progressive';

afterEach(() => vi.useRealTimers());

describe('useRenderLimit (B18: long lists render progressively)', () => {
  it('starts with the first batch, then grows to the whole list', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRenderLimit(1_000, 60, 400));
    expect(result.current).toBe(60);
    await act(async () => void vi.advanceTimersByTime(0));
    expect(result.current).toBe(460);
    await act(async () => void vi.advanceTimersByTime(0));
    await act(async () => void vi.advanceTimersByTime(0));
    expect(result.current).toBe(1_000);
  });

  it('a short list is whole from the first render', () => {
    const { result } = renderHook(() => useRenderLimit(12));
    expect(result.current).toBe(12);
  });
});
