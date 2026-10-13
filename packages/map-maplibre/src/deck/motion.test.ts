import { describe, expect, it } from 'vitest';
import { MotionGovernor } from './motion';

describe('MotionGovernor (AUTO)', () => {
  it('düşük kare hızı bekleme süresi boyunca sürerse kapanır', () => {
    const g = new MotionGovernor({ lowFps: 25, highFps: 50, holdMs: 3000 });
    expect(g.isActive).toBe(true);
    expect(g.sample(20, 0)).toBe(false);
    expect(g.sample(20, 2000)).toBe(false);
    expect(g.sample(20, 3000)).toBe(true);
    expect(g.isActive).toBe(false);
  });

  it('kısa düşüş sayılmaz (eşik içine dönünce sayaç sıfırlanır)', () => {
    const g = new MotionGovernor({ holdMs: 3000 });
    g.sample(20, 0);
    g.sample(40, 2000); // iki eşik arası: kararsız bölge, sayaç sıfır
    expect(g.sample(20, 3500)).toBe(false);
    expect(g.isActive).toBe(true);
  });

  it('histerezis: kapalıyken yalnız üst eşiğin üstü açar', () => {
    const g = new MotionGovernor({ lowFps: 25, highFps: 50, holdMs: 1000 });
    g.sample(10, 0);
    g.sample(10, 1000);
    expect(g.isActive).toBe(false);
    // 40 fps: düşük eşiğin üstünde ama açmaya yetmez
    g.sample(40, 2000);
    expect(g.sample(40, 10_000)).toBe(false);
    expect(g.isActive).toBe(false);
  });

  it('her yön değiştirmede bekleme ikiye katlanır (üst sınırlı)', () => {
    const g = new MotionGovernor({ holdMs: 1000, maxHoldMs: 3000 });
    g.sample(10, 0);
    expect(g.sample(10, 1000)).toBe(true); // kapandı; bekleme 2000
    g.sample(60, 1000);
    expect(g.sample(60, 2500)).toBe(false);
    expect(g.sample(60, 3000)).toBe(true); // açıldı; bekleme 3000 (sınır)
    g.sample(10, 3000);
    expect(g.sample(10, 5500)).toBe(false);
    expect(g.sample(10, 6000)).toBe(true);
  });
});
