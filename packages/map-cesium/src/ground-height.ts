// ── Zemin yüksekliği önbelleği ────────────────────────────────────
// `Globe.getHeight` yüklü arazi karosunun üçgenlerinde ışın testi yapar: tek çağrı ~0,1–1 ms.
// Her karede onlarca çağrı (İHA konisi, iz köşeleri, kamera hedefi) ana thread'i boğar
// (ölçüldü: 6 İHA'da 3 sn'nin 2,8 sn'si). Çözüm: ~100 m'lik hücre başına sonuç, kısa ömürlü.
//
// Kısa ömür önemli: arazi kademeli incelir (önce kaba karo, sonra ayrıntılı). Bir hücrenin ilk
// cevabı kaba karodan gelebilir; süre dolunca yeniden sorulur ve iyileşen değer alınır.
// Arazi henüz yoksa (`undefined`) sonuç önbelleğe ALINMAZ.

import type { LngLat } from '@c2/map-core';

export type GroundHeightCacheOptions = {
  /** Hücre boyu (derece). Varsayılan 0,001° ≈ 110 m. */
  cellDeg?: number;
  /** Sonucun geçerlilik süresi (ms). Varsayılan 2000. */
  ttlMs?: number;
  /** En çok hücre. Varsayılan 4096 (aşılınca en eski silinir). */
  maxEntries?: number;
  now?: () => number;
};

export class GroundHeightCache {
  private readonly cells = new Map<string, { height: number; at: number }>();
  private readonly cellDeg: number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Ölçüm: gerçek sorgu sayısı. */
  misses = 0;

  constructor(
    private readonly sample: (lon: number, lat: number) => number | undefined,
    options: GroundHeightCacheOptions = {},
  ) {
    this.cellDeg = options.cellDeg ?? 0.001;
    this.ttlMs = options.ttlMs ?? 2000;
    this.maxEntries = options.maxEntries ?? 4096;
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }

  get(coord: LngLat): number | undefined {
    const ix = Math.round(coord[0] / this.cellDeg);
    const iy = Math.round(coord[1] / this.cellDeg);
    const key = `${ix},${iy}`;
    const t = this.now();
    const cached = this.cells.get(key);
    if (cached && t - cached.at < this.ttlMs) return cached.height;

    this.misses++;
    // Hücrenin merkezinden sor: aynı hücredeki her nokta aynı cevabı alır.
    const height = this.sample(ix * this.cellDeg, iy * this.cellDeg);
    if (height === undefined) return cached?.height; // arazi yok / henüz yüklenmedi
    this.cells.delete(key); // en sona taşı
    this.cells.set(key, { height, at: t });
    if (this.cells.size > this.maxEntries) this.cells.delete(this.cells.keys().next().value!);
    return height;
  }

  clear(): void {
    this.cells.clear();
  }
}
