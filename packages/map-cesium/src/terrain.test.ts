import { describe, expect, it, vi } from 'vitest';
import { decodeTerrarium, sampleHeights, sourceTileFor, terrariumTerrain, type DecodedTile } from './terrain';

const tileOf = (width: number, height: number, f: (x: number, y: number) => number): DecodedTile => {
  const heights = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) heights[y * width + x] = f(x, y);
  return { width, height, heights };
};

describe('Terrarium arazisi', () => {
  it('RGB → yükseklik: (R·256 + G + B/256) − 32768', () => {
    // 1000 m: 33768 = 131·256 + 232
    const tile = decodeTerrarium(new Uint8Array([131, 232, 0, 255, 128, 0, 128, 255]), 2, 1);
    expect(tile.heights[0]).toBe(1000);
    expect(tile.heights[1]).toBe(0.5); // B/256
  });

  it('örnekleme: kenar örnekleri bölge kenarında, araları bilineer', () => {
    const tile = tileOf(4, 4, (x) => x * 10); // doğu-batı eğimi
    const out = sampleHeights(tile, 3);
    // Satır: sol kenar (ilk piksel), orta (piksel 1,5 → 15), sağ kenar (son piksel)
    expect([...out.slice(0, 3)]).toEqual([0, 15, 30]);
    // Satırlar aynı (kuzey-güney değişim yok)
    expect([...out.slice(3, 6)]).toEqual([0, 15, 30]);
    expect([...sampleHeights(tile, 2, undefined, 100)]).toEqual([100, 130, 100, 130]); // sabit fark
  });

  it('kaynağın üst seviyesi aşılınca ata karo + alt bölge', () => {
    expect(sourceTileFor(5, 7, 10, 15)).toEqual({ x: 5, y: 7, z: 10, region: { u0: 0, v0: 0, u1: 1, v1: 1 } });
    // Seviye 17 = 15'in 2 altı: 4×4 bölünme; (13, 6) → ata (3, 1), bölge sütun 1, satır 2
    expect(sourceTileFor(13, 6, 17, 15)).toEqual({ x: 3, y: 1, z: 15, region: { u0: 0.25, v0: 0.5, u1: 0.5, v1: 0.75 } });
  });

  it('sağlayıcı: aşırı yakınlaştırmada ata karo bir kez indirilir; hata düz zemin döner', async () => {
    const loadTile = vi.fn(async (url: string) => {
      if (url.includes('/9/')) throw new Error('404');
      return tileOf(8, 8, () => 1200);
    });
    const provider = terrariumTerrain({ url: 'https://t/{z}/{x}/{y}.png', maxLevel: 15, samples: 5, loadTile });
    const a = await provider.requestTileGeometry(26, 12, 17);
    const b = await provider.requestTileGeometry(27, 13, 17); // aynı ata (6, 3, 15)
    expect(loadTile).toHaveBeenCalledTimes(1);
    expect(loadTile).toHaveBeenCalledWith('https://t/15/6/3.png');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const flat = await provider.requestTileGeometry(1, 1, 9); // indirme hatası
    expect(flat).toBeDefined(); // undefined = "sonra tekrar dene" olurdu (sonsuz deneme)
  });
});
