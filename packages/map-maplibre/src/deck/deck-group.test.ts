import { describe, expect, it } from 'vitest';
import { DeckGroupData, type DeckIcon } from './deck-group';

const icon = (id: string): DeckIcon => ({ id, url: `data:${id}`, width: 32, height: 24 });

describe('DeckGroupData', () => {
  it('ekleme: indeks sırayla verilir, diziler yazılır, uzunluk sürümü artar', () => {
    const g = new DeckGroupData();
    g.upsert('a', { coord: [32, 39], icon: icon('x'), size: 24, opacity: 0.5 }, false, 0);
    g.upsert('b', { coord: [33, 40] }, false, 0);
    expect(g.n).toBe(2);
    expect(g.index('a')).toBe(0);
    expect(g.index('b')).toBe(1);
    expect([...g.pos.subarray(0, 4)]).toEqual([32, 39, 33, 40]);
    expect(g.size[0]).toBe(24);
    expect([...g.color.subarray(0, 4)]).toEqual([255, 255, 255, 128]);
    expect(g.color[7]).toBe(255); // opaklık verilmeyen: tam opak
    expect(g.lengthVersion).toBe(2);
  });

  it('güncelleme yalnız ilgili sürümü artırır; uzunluk değişmez', () => {
    const g = new DeckGroupData();
    g.upsert('a', { coord: [0, 0], icon: icon('x'), size: 1 }, false, 0);
    const { posVersion, styleVersion, lengthVersion } = g;
    g.upsert('a', { coord: [1, 1] }, false, 0);
    expect(g.posVersion).toBe(posVersion + 1);
    expect(g.styleVersion).toBe(styleVersion);
    g.upsert('a', { opacity: 0.2 }, false, 0);
    expect(g.styleVersion).toBe(styleVersion + 1);
    expect(g.lengthVersion).toBe(lengthVersion);
  });

  it('swap-remove: son eleman boşluğa taşınır, diziler sıkı kalır', () => {
    const g = new DeckGroupData();
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      g.upsert(id, { coord: [i, i], icon: icon(id), size: i + 10, opacity: 1 }, false, 0);
    }
    expect(g.remove('a')).toBe(true);
    expect(g.n).toBe(2);
    expect(g.ids).toEqual(['c', 'b']);
    expect(g.icons.map((x) => x?.id)).toEqual(['c', 'b']);
    expect(g.index('c')).toBe(0);
    expect(g.has('a')).toBe(false);
    expect(g.coordOf('c')).toEqual([2, 2]);
    expect(g.size[0]).toBe(12);
    expect(g.remove('a')).toBe(false);
    // Sondakini silmek taşıma gerektirmez
    g.remove('b');
    expect(g.ids).toEqual(['c']);
  });

  it('kapasite dolunca büyür, mevcut veriler korunur', () => {
    const g = new DeckGroupData();
    for (let i = 0; i < 600; i++) g.upsert(`u${i}`, { coord: [i, -i], size: i }, false, 0);
    expect(g.n).toBe(600);
    expect(g.coordOf('u0')).toEqual([0, -0]);
    expect(g.coordOf('u599')).toEqual([599, -599]);
    expect(g.size[300]).toBe(300);
  });

  it('akıcı hareket: ekrandaki konumdan hedefe süre boyunca kayar, sonra durur', () => {
    const g = new DeckGroupData();
    g.upsert('a', { coord: [0, 0] }, true, 0); // yeni birlik: kaymaz, hemen yerinde
    expect(g.animate(10, 1000)).toBe(false);
    g.upsert('a', { coord: [10, 20] }, true, 1000);
    expect(g.coordOf('a')).toEqual([0, 0]); // henüz kaymadı

    expect(g.animate(1500, 1000)).toBe(true);
    expect(g.coordOf('a')).toEqual([5, 10]);

    // Yolun ortasında yeni hedef: o anki ekran konumundan başlar (zıplama yok)
    g.upsert('a', { coord: [5, 0] }, true, 1500);
    expect(g.animate(2000, 1000)).toBe(true);
    expect(g.coordOf('a')).toEqual([5, 5]);

    expect(g.animate(2500, 1000)).toBe(false);
    expect(g.coordOf('a')).toEqual([5, 0]);
    const v = g.posVersion;
    expect(g.animate(3000, 1000)).toBe(false);
    expect(g.posVersion).toBe(v); // hareket yoksa diziye dokunulmaz
  });

  it('snapToTargets: herkes hedefine atlar', () => {
    const g = new DeckGroupData();
    g.upsert('a', { coord: [0, 0] }, false, 0);
    g.upsert('a', { coord: [4, 4] }, true, 0);
    g.snapToTargets();
    expect(g.coordOf('a')).toEqual([4, 4]);
    expect(g.animate(100, 1000)).toBe(false);
  });
});
