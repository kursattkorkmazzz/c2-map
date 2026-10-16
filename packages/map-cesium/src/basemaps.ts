// ── Altlıklar (basemap) → Cesium imagery katmanları ──────────────
// Tasarım: plan/design/02-core-model.md#altlıklar-basemap
//
// Her altlık = bir `ImageryLayer` (küreye / araziye giydirilen görüntü). Sıra `order`'a göre
// (küçük alta). Değişiklikler en ucuz yoldan:
//   opaklık → layer.alpha       görünürlük → layer.show (gizli katman karo istemez)
//   sıra    → raise / lower     kaynak     → katman baştan (karolar yeniden iner)
//
//   XYZ      → UrlTemplateImageryProvider      ({z}/{x}/{y} aynı yer tutucular)
//   WMTS     → REST şablonu ({z}) ise XYZ gibi; değilse WebMapTileServiceImageryProvider (Web Mercator)
//   WMS      → WebMapServiceImageryProvider    (saydam PNG)
//   TILEJSON → JSON indirilir → ilk karo şablonu XYZ gibi
//   IMAGE    → SingleTileImageryProvider       (köşelerin sınır kutusu; Cesium eğik dörtgen germez)
//   VECTOR_STYLE → desteklenmez (MapLibre stili)
//
// Auth: `BasemapProviderRegistry.transformRequest` şablon URL'ine bir kez uygulanır (URL + header);
// Cesium karo başına istek kancası vermez. İmzalı URL'si karo başına değişen sağlayıcı için
// `custom:*` kaynak + kendi ImageryProvider'ı gerekir (Faz 5 açık konu).

import {
  BASEMAP_SOURCE,
  type Basemap,
  type BasemapProviderRegistry,
  type BasemapSource,
  type BasemapSourceType,
} from '@c2/map-core';
import {
  Credit,
  ImageryLayer,
  Rectangle,
  Resource,
  SingleTileImageryProvider,
  UrlTemplateImageryProvider,
  WebMapServiceImageryProvider,
  WebMapTileServiceImageryProvider,
  WebMercatorTilingScheme,
  type ImageryLayerCollection,
  type ImageryProvider,
} from 'cesium';

export const SUPPORTED_BASEMAP_SOURCES: readonly BasemapSourceType[] = [
  BASEMAP_SOURCE.XYZ,
  BASEMAP_SOURCE.WMTS,
  BASEMAP_SOURCE.WMS,
  BASEMAP_SOURCE.TILEJSON,
  BASEMAP_SOURCE.IMAGE,
];

export type BasemapStats = {
  /** Kaynağı desteklenmeyen / çözülemeyen (çizilmeyen) altlıklar. */
  readonly skippedBasemaps: number;
};

type Transform = (url: string) => { url: string; headers?: Record<string, string> };

const resourceOf = (url: string, transform: Transform): Resource => {
  const t = transform(url);
  return new Resource({ url: t.url, ...(t.headers ? { headers: t.headers } : {}) });
};

/**
 * Standart altlık kaynağını Cesium imagery sağlayıcısına çevirir. Desteklenmeyen tipte `null`.
 * Bazı tipler (TILEJSON, IMAGE) ağdan bilgi ister: sonuç Promise olabilir.
 */
export function toImageryProvider(
  source: BasemapSource,
  options: { attribution?: string; transform?: Transform } = {},
): ImageryProvider | Promise<ImageryProvider> | null {
  const transform = options.transform ?? ((url) => ({ url }));
  const credit = options.attribution ? new Credit(options.attribution) : undefined;
  const common = credit ? { credit } : {};
  switch (source.type) {
    case BASEMAP_SOURCE.XYZ:
      return new UrlTemplateImageryProvider({
        url: resourceOf(source.urlTemplate, transform),
        tileWidth: source.tileSize ?? 256,
        tileHeight: source.tileSize ?? 256,
        ...(source.minZoom !== undefined ? { minimumLevel: source.minZoom } : {}),
        ...(source.maxZoom !== undefined ? { maximumLevel: source.maxZoom } : {}),
        ...common,
      });
    case BASEMAP_SOURCE.WMTS:
      if (source.url.includes('{z}')) {
        return new UrlTemplateImageryProvider({ url: resourceOf(source.url, transform), ...common });
      }
      return new WebMapTileServiceImageryProvider({
        url: resourceOf(source.url, transform),
        layer: source.layer,
        style: 'default',
        format: source.format ?? 'image/png',
        tileMatrixSetID: source.tileMatrixSet,
        tilingScheme: new WebMercatorTilingScheme(),
        ...common,
      });
    case BASEMAP_SOURCE.WMS:
      return new WebMapServiceImageryProvider({
        url: resourceOf(source.url, transform),
        layers: source.layers,
        parameters: { format: source.format ?? 'image/png', transparent: true, ...source.params },
        tilingScheme: new WebMercatorTilingScheme(),
        ...common,
      });
    case BASEMAP_SOURCE.TILEJSON:
      return (async () => {
        const json = (await resourceOf(source.url, transform).fetchJson()) as {
          tiles?: string[];
          minzoom?: number;
          maxzoom?: number;
          attribution?: string;
        };
        const template = json.tiles?.[0];
        if (!template) throw new Error(`TileJSON'da karo şablonu yok: ${source.url}`);
        return new UrlTemplateImageryProvider({
          url: resourceOf(template, transform),
          ...(json.minzoom !== undefined ? { minimumLevel: json.minzoom } : {}),
          ...(json.maxzoom !== undefined ? { maximumLevel: json.maxzoom } : {}),
          ...(credit ? common : json.attribution ? { credit: new Credit(json.attribution) } : {}),
        });
      })();
    case BASEMAP_SOURCE.IMAGE: {
      const lons = source.corners.map((c) => c[0]);
      const lats = source.corners.map((c) => c[1]);
      const rectangle = Rectangle.fromDegrees(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats));
      return SingleTileImageryProvider.fromUrl(resourceOf(source.url, transform), { rectangle, ...common });
    }
    default:
      return null; // VECTOR_STYLE veya çözülmemiş custom:*
  }
}

type Entry = { basemap: Basemap; layer: ImageryLayer };

/** Kaynak (URL, tip …) aynı mı? Aynıysa katman yerinde güncellenir. */
const sameSource = (a: Basemap, b: Basemap) => a.provider === b.provider && JSON.stringify(a.source) === JSON.stringify(b.source);

export class CesiumBasemapController {
  private readonly entries = new Map<string, Entry>();
  private skipped = 0;

  constructor(
    private readonly layers: ImageryLayerCollection,
    private readonly providers: BasemapProviderRegistry,
    private readonly onError: (basemap: Basemap, error: unknown) => void = (b, e) =>
      console.warn(`[map-cesium] altlık yüklenemedi: ${b.id}`, e),
  ) {}

  get stats(): BasemapStats {
    return { skippedBasemaps: this.skipped };
  }

  upsert(basemap: Basemap): void {
    const existing = this.entries.get(basemap.id);
    if (existing && sameSource(existing.basemap, basemap)) {
      existing.basemap = basemap;
      existing.layer.alpha = basemap.opacity;
      existing.layer.show = basemap.visible;
      this.restack();
      return;
    }
    if (existing) this.remove(basemap.id);

    const source = this.providers.resolveSource(basemap);
    const provider = source
      ? toImageryProvider(source, {
          attribution: basemap.attribution,
          transform: (url) => this.providers.transformRequest(basemap, url),
        })
      : null;
    if (!provider) {
      this.skipped++;
      return;
    }
    const layer =
      provider instanceof Promise ? ImageryLayer.fromProviderAsync(provider, {}) : new ImageryLayer(provider, {});
    layer.alpha = basemap.opacity;
    layer.show = basemap.visible;
    if (provider instanceof Promise) provider.catch((error) => this.onError(basemap, error));
    this.layers.add(layer);
    this.entries.set(basemap.id, { basemap, layer });
    this.restack();
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.layers.remove(entry.layer, true);
    this.entries.delete(id);
  }

  /** `order`'a göre dizer: küçük alta. Altlık sayısı azdır; her değişiklikte baştan dizmek ucuz. */
  private restack(): void {
    const ordered = [...this.entries.values()].sort((a, b) => a.basemap.order - b.basemap.order);
    for (const entry of ordered) this.layers.raiseToTop(entry.layer);
  }

  destroy(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }
}
