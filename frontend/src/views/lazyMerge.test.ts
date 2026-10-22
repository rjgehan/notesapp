import { describe, expect, it, vi } from 'vitest';
import { lazyMerge, withMerge } from './lazyMerge';

describe('lazyMerge (a view merge outside the main chunk)', () => {
  it('answers null and starts loading until the merge is there, then merges', async () => {
    const real = vi.fn((base: string, mine: string, theirs: string) => `${base}|${mine}|${theirs}`);
    const load = vi.fn(() => Promise.resolve(real));
    const m = lazyMerge(load);
    expect(m.merge('b', 'm', 't')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    await m.ready();
    expect(m.merge('b', 'm', 't')).toBe('b|m|t');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads with the view: withMerge preloads it alongside the chunk', async () => {
    const load = vi.fn(() => Promise.resolve(() => 'merged'));
    const m = lazyMerge(load);
    const view = withMerge(m, () => Promise.resolve('chunk'));
    expect(await view()).toBe('chunk');
    await m.ready();
    expect(load).toHaveBeenCalledTimes(1);
    expect(m.merge('', '', '')).toBe('merged');
  });

  it('tries again after a failed load (the conflict banner shows meanwhile)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(() => 'merged');
    const m = lazyMerge(load);
    await m.ready();
    expect(m.merge('', '', '')).toBeNull();
    await m.ready();
    expect(m.merge('', '', '')).toBe('merged');
  });
});
