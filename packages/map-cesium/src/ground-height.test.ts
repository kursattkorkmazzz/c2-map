import { describe, expect, it, vi } from 'vitest';
import { GroundHeightCache } from './ground-height';

describe('GroundHeightCache', () => {
  it('aynı hücre tek sorgu; süre dolunca yeniden sorulur', () => {
    let now = 0;
    const sample = vi.fn(() => 812);
    const cache = new GroundHeightCache(sample, { cellDeg: 0.001, ttlMs: 2000, now: () => now });
    expect(cache.get([32.8501, 39.9001])).toBe(812);
    expect(cache.get([32.85012, 39.90008])).toBe(812); // aynı ~110 m hücre
    expect(sample).toHaveBeenCalledTimes(1);
    expect(cache.get([32.86, 39.9])).toBe(812); // başka hücre
    expect(sample).toHaveBeenCalledTimes(2);
    now = 2500;
    cache.get([32.8501, 39.9001]);
    expect(sample).toHaveBeenCalledTimes(3);
  });

  it('arazi yokken (undefined) önbelleğe alınmaz; varsa eski değer korunur', () => {
    let now = 0;
    let value: number | undefined;
    const cache = new GroundHeightCache(() => value, { now: () => now });
    expect(cache.get([1, 1])).toBeUndefined();
    value = 50;
    expect(cache.get([1, 1])).toBe(50); // ilk cevap önbellekte değildi
    now = 5000;
    value = undefined; // karo bellekten düştü
    expect(cache.get([1, 1])).toBe(50);
  });

  it('en çok hücre sınırı', () => {
    const cache = new GroundHeightCache(() => 1, { maxEntries: 2 });
    cache.get([0, 0]);
    cache.get([1, 1]);
    cache.get([2, 2]);
    cache.get([0, 0]); // en eski silindi → tekrar sorulur
    expect(cache.misses).toBe(4);
  });
});
