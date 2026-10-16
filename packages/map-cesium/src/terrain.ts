// ── Ücretsiz arazi: Terrarium yükseklik karoları (Cesium ion YOK) ─
// Tasarım: plan/design/08-extensibility-symbology.md#cesium-arazi
//
// Cesium'un hazır arazisi (Cesium World Terrain) ion hesabı ister. Bunun yerine Mapzen/AWS
// "Terrain Tiles" (AWS Open Data, anahtarsız, CORS açık) kullanılır: PNG karo, her piksel bir
// yükseklik: h = (R·256 + G + B/256) − 32768 (m, deniz seviyesi). Karolar Web Mercator {z}/{x}/{y}.
//
// Cesium tarafında `CustomHeightmapTerrainProvider` + `WebMercatorTilingScheme`: karo başına bir
// PNG indirilir, `SAMPLES×SAMPLES` ızgaraya örneklenir. Kaynağın en yüksek seviyesinin (15)
// ötesinde ata karo tekrar indirilmez: önbellekten alt bölge örneklenir.
//
// Not: yükseklikler deniz seviyesine (EGM96), Cesium elipsoide göredir; Türkiye'de fark ≈ 30–37 m.
// Görsel olarak önemsiz; hassas iş için sağlayıcıya `offsetM` verilebilir.

import { CustomHeightmapTerrainProvider, WebMercatorTilingScheme, type TerrainProvider } from 'cesium';

export const TERRARIUM_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
export const TERRARIUM_CREDIT = 'Arazi: Mapzen Terrain Tiles (AWS Open Data) — SRTM, GMTED, ETOPO1 ve diğerleri';

export type TerrariumOptions = {
  /** Karo şablonu ({z}/{x}/{y}). Varsayılan AWS Terrarium. Kendi sunucunuz da olabilir. */
  url?: string;
  /** Kaynağın en yüksek seviyesi. Ötesinde ata karo örneklenir. Varsayılan 15. */
  maxLevel?: number;
  /** Cesium karosu başına örnek sayısı (kenar). Varsayılan 65 (Cesium standardı). */
  samples?: number;
  /** Tüm yüksekliklere eklenen sabit (ör. geoid farkı). Varsayılan 0. */
  offsetM?: number;
  /** Çözülmüş karo önbelleği (adet). Varsayılan 96. */
  cacheSize?: number;
  /** Karo indir + çöz (test için değiştirilebilir). Varsayılan: fetch + createImageBitmap. */
  loadTile?: (url: string) => Promise<DecodedTile>;
  credit?: string;
};

/** Çözülmüş karo: satır satır (kuzeyden güneye), metre. */
export type DecodedTile = { width: number; height: number; heights: Float32Array };

/** RGBA piksellerini Terrarium formülüyle yüksekliğe çevirir. */
export function decodeTerrarium(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): DecodedTile {
  const heights = new Float32Array(width * height);
  for (let i = 0, p = 0; i < heights.length; i++, p += 4) {
    heights[i] = rgba[p]! * 256 + rgba[p + 1]! + rgba[p + 2]! / 256 - 32768;
  }
  return { width, height, heights };
}

/**
 * Karonun [u0,u1]×[v0,v1] bölgesini (0..1, v aşağı) `samples×samples` ızgaraya bilineer örnekler.
 * Kenar örnekleri bölgenin tam kenarına düşer (Cesium heightmap kuralı).
 */
export function sampleHeights(
  tile: DecodedTile,
  samples: number,
  region: { u0: number; v0: number; u1: number; v1: number } = { u0: 0, v0: 0, u1: 1, v1: 1 },
  offsetM = 0,
): Float32Array {
  const out = new Float32Array(samples * samples);
  const { width, height, heights } = tile;
  const at = (x: number, y: number) => heights[y * width + x]!;
  for (let row = 0; row < samples; row++) {
    const v = region.v0 + ((region.v1 - region.v0) * row) / (samples - 1);
    // Piksel merkezleri (i + 0,5) / boy'da: sürekli koordinat → piksel indeksi
    const py = Math.min(Math.max(v * height - 0.5, 0), height - 1);
    const y0 = Math.floor(py);
    const y1 = Math.min(y0 + 1, height - 1);
    const fy = py - y0;
    for (let col = 0; col < samples; col++) {
      const u = region.u0 + ((region.u1 - region.u0) * col) / (samples - 1);
      const px = Math.min(Math.max(u * width - 0.5, 0), width - 1);
      const x0 = Math.floor(px);
      const x1 = Math.min(x0 + 1, width - 1);
      const fx = px - x0;
      const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
      const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
      out[row * samples + col] = top * (1 - fy) + bottom * fy + offsetM;
    }
  }
  return out;
}

/** Seviye `maxLevel`'ı aşıyorsa ata karo ve onun içindeki bölge. */
export function sourceTileFor(
  x: number,
  y: number,
  level: number,
  maxLevel: number,
): { x: number; y: number; z: number; region: { u0: number; v0: number; u1: number; v1: number } } {
  if (level <= maxLevel) return { x, y, z: level, region: { u0: 0, v0: 0, u1: 1, v1: 1 } };
  const depth = level - maxLevel;
  const scale = 2 ** depth;
  const ax = Math.floor(x / scale);
  const ay = Math.floor(y / scale);
  const ox = x - ax * scale;
  const oy = y - ay * scale;
  return { x: ax, y: ay, z: maxLevel, region: { u0: ox / scale, v0: oy / scale, u1: (ox + 1) / scale, v1: (oy + 1) / scale } };
}

async function fetchTerrariumTile(url: string): Promise<DecodedTile> {
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return decodeTerrarium(data, canvas.width, canvas.height);
}

/** Terrarium karolarından Cesium arazi sağlayıcısı (ion'suz, ücretsiz). */
export function terrariumTerrain(options: TerrariumOptions = {}): TerrainProvider {
  const template = options.url ?? TERRARIUM_URL;
  const maxLevel = options.maxLevel ?? 15;
  const samples = options.samples ?? 65;
  const offsetM = options.offsetM ?? 0;
  const cacheSize = options.cacheSize ?? 96;
  const load = options.loadTile ?? fetchTerrariumTile;

  // Aynı karoyu (özellikle aşırı yakınlaştırmada ata karoyu) bir kez indir: söz önbelleği, LRU.
  const cache = new Map<string, Promise<DecodedTile>>();
  const tile = (x: number, y: number, z: number): Promise<DecodedTile> => {
    const key = `${z}/${x}/${y}`;
    let pending = cache.get(key);
    if (pending) {
      cache.delete(key); // en sona taşı (en yeni)
    } else {
      const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      pending = load(url);
      pending.catch(() => cache.delete(key)); // hata önbellekte kalmasın
    }
    cache.set(key, pending);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
    return pending;
  };

  return new CustomHeightmapTerrainProvider({
    width: samples,
    height: samples,
    tilingScheme: new WebMercatorTilingScheme(),
    credit: options.credit ?? TERRARIUM_CREDIT,
    callback: async (x, y, level) => {
      const source = sourceTileFor(x, y, level, maxLevel);
      try {
        return sampleHeights(await tile(source.x, source.y, source.z), samples, source.region, offsetM);
      } catch {
        // `undefined` Cesium'da "sonra tekrar dene" demek (sonsuz deneme); düz zemin dön.
        return new Float32Array(samples * samples);
      }
    },
  });
}
