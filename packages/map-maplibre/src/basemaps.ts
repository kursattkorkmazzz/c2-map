// ── Altlıklar (basemap) ──────────────────────────────────────────
// Tasarım: plan/design/02-core-model.md#altlıklar-basemap
//
// Her altlık = bir kaynak + bir raster katmanı, hepsi `c2-basemap-top` çapasının ALTINDA,
// `order`'a göre (küçük alta). Değişiklikler en ucuz yoldan uygulanır:
//   opaklık    → setPaintProperty           görünürlük → setLayoutProperty (gizli katman tile istemez)
//   sıra       → moveLayer                  kaynak     → kaynak + katman baştan (tile'lar yeniden iner)
// `custom:*` kaynaklar BasemapProviderRegistry ile standart tipe çevrilir.

import {
  BASEMAP_SOURCE,
  type Basemap,
  type BasemapProviderRegistry,
  type BasemapSource,
  type BasemapSourceType,
} from '@c2/map-core';
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import type { MapLike } from './map-like';

/** Bu adapter'ın çizebildiği altlık kaynak tipleri (VECTOR_STYLE: Faz 4). */
export const SUPPORTED_BASEMAP_SOURCES: readonly BasemapSourceType[] = [
  BASEMAP_SOURCE.XYZ,
  BASEMAP_SOURCE.WMTS,
  BASEMAP_SOURCE.WMS,
  BASEMAP_SOURCE.TILEJSON,
  BASEMAP_SOURCE.IMAGE,
];

const DEFAULT_TILE_SIZE = 256;

/**
 * Standart altlık kaynağını MapLibre kaynağına çevirir. Desteklenmeyen tipte `null`.
 *
 * WMTS: URL'de `{z}` varsa REST şablonu olarak aynen kullanılır; yoksa KVP GetTile şablonu kurulur.
 *   KVP'de TILEMATRIX = zoom varsayılır (GoogleMapsCompatible / WebMercatorQuad matris kümeleri).
 * WMS: 256 px'lik EPSG:3857 karoları (`{bbox-epsg-3857}`), saydam arka plan.
 */
export function toSourceSpec(source: BasemapSource, attribution?: string): SourceSpecification | null {
  const attr = attribution ? { attribution } : {};
  switch (source.type) {
    case BASEMAP_SOURCE.XYZ:
      return {
        type: 'raster',
        tiles: [source.urlTemplate],
        tileSize: source.tileSize ?? DEFAULT_TILE_SIZE,
        ...(source.minZoom !== undefined ? { minzoom: source.minZoom } : {}),
        ...(source.maxZoom !== undefined ? { maxzoom: source.maxZoom } : {}),
        ...attr,
      };
    case BASEMAP_SOURCE.WMTS:
      return { type: 'raster', tiles: [wmtsTemplate(source)], tileSize: DEFAULT_TILE_SIZE, ...attr };
    case BASEMAP_SOURCE.WMS:
      return { type: 'raster', tiles: [wmsTemplate(source)], tileSize: DEFAULT_TILE_SIZE, ...attr };
    case BASEMAP_SOURCE.TILEJSON:
      return { type: 'raster', url: source.url, tileSize: DEFAULT_TILE_SIZE, ...attr };
    case BASEMAP_SOURCE.IMAGE:
      // Köşe sırası: sol üst, sağ üst, sağ alt, sol alt (model ile aynı)
      return {
        type: 'image',
        url: source.url,
        coordinates: source.corners.map((c) => [c[0], c[1]]) as [
          [number, number],
          [number, number],
          [number, number],
          [number, number],
        ],
      };
    default:
      return null; // VECTOR_STYLE (Faz 4) veya çözülmemiş custom:*
  }
}

type WmtsSource = Extract<BasemapSource, { type: typeof BASEMAP_SOURCE.WMTS }>;
type WmsSource = Extract<BasemapSource, { type: typeof BASEMAP_SOURCE.WMS }>;

function wmtsTemplate(source: WmtsSource): string {
  if (source.url.includes('{z}')) return source.url; // REST şablonu
  const params = new URLSearchParams({
    SERVICE: 'WMTS',
    REQUEST: 'GetTile',
    VERSION: '1.0.0',
    LAYER: source.layer,
    STYLE: 'default',
    TILEMATRIXSET: source.tileMatrixSet,
    FORMAT: source.format ?? 'image/png',
  });
  // Yer tutucular URL-encode edilmemeli → elle eklenir.
  return `${withQuery(source.url)}${params}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
}

function wmsTemplate(source: WmsSource): string {
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.3.0',
    LAYERS: source.layers,
    STYLES: '',
    FORMAT: source.format ?? 'image/png',
    TRANSPARENT: 'true',
    CRS: 'EPSG:3857',
    WIDTH: String(DEFAULT_TILE_SIZE),
    HEIGHT: String(DEFAULT_TILE_SIZE),
    ...source.params,
  });
  return `${withQuery(source.url)}${params}&BBOX={bbox-epsg-3857}`;
}

const withQuery = (url: string) => (url.includes('?') ? (url.endsWith('?') || url.endsWith('&') ? url : `${url}&`) : `${url}?`);

/** Bir URL şablonunun sabit öneki (ilk yer tutucuya / sorguya kadar): isteği altlığa eşlemek için. */
export function urlPrefix(template: string): string {
  const cut = template.search(/[{?]/);
  return cut < 0 ? template : template.slice(0, cut);
}

export type BasemapStats = {
  /** Çizilemeyen altlık güncellemeleri (desteklenmeyen tip, çözülemeyen custom:*). */
  readonly skippedBasemaps: number;
};

type BasemapEntry = {
  basemap: Basemap;
  sourceId: string;
  layerId: string;
  /** İstek eşleme için URL önekleri (auth / imzalı URL). */
  prefixes: string[];
};

export class BasemapController {
  private readonly entries = new Map<string, BasemapEntry>();
  private skipped = 0;

  constructor(
    private readonly map: MapLike,
    private readonly providers: BasemapProviderRegistry,
    /** Altlık katmanları bunun altına eklenir. */
    private readonly anchorLayerId: string,
  ) {}

  get stats(): BasemapStats {
    return { skippedBasemaps: this.skipped };
  }

  upsert(basemap: Basemap): void {
    const prev = this.entries.get(basemap.id);
    if (prev && prev.basemap.source === basemap.source && prev.basemap.attribution === basemap.attribution) {
      this.updateInPlace(prev, basemap);
      return;
    }
    // Yeni altlık veya kaynağı değişti → kaynak + katman baştan.
    if (prev) this.removeEntry(prev);
    this.create(basemap);
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry) this.removeEntry(entry);
  }

  /** MapLibre `transformRequest`: URL hangi altlığa aitse onun sağlayıcısından geçirilir. */
  transformRequest(url: string): { url: string; headers?: Record<string, string> } | undefined {
    let best: BasemapEntry | undefined;
    let bestLength = 0;
    for (const entry of this.entries.values()) {
      for (const prefix of entry.prefixes) {
        if (prefix.length > bestLength && url.startsWith(prefix)) {
          best = entry;
          bestLength = prefix.length;
        }
      }
    }
    if (!best || best.basemap.provider === undefined) return undefined;
    return this.providers.transformRequest(best.basemap, url);
  }

  private create(basemap: Basemap): void {
    const resolved = this.providers.resolveSource(basemap);
    const spec = resolved && toSourceSpec(resolved, basemap.attribution);
    if (!resolved || !spec) {
      this.skipped++;
      return;
    }
    const sourceId = `c2-bm-src-${basemap.id}`;
    const layerId = `c2-bm-${basemap.id}`;
    this.map.addSource(sourceId, spec);
    this.map.addLayer(this.layerSpec(layerId, sourceId, basemap), this.beforeIdFor(basemap));
    this.entries.set(basemap.id, { basemap, sourceId, layerId, prefixes: prefixesOf(spec) });
  }

  private updateInPlace(entry: BasemapEntry, next: Basemap): void {
    const prev = entry.basemap;
    entry.basemap = next;
    if (prev.opacity !== next.opacity) this.map.setPaintProperty(entry.layerId, 'raster-opacity', next.opacity);
    if (prev.visible !== next.visible) {
      this.map.setLayoutProperty(entry.layerId, 'visibility', next.visible ? 'visible' : 'none');
    }
    if (prev.order !== next.order) this.map.moveLayer(entry.layerId, this.beforeIdFor(next));
  }

  private removeEntry(entry: BasemapEntry): void {
    this.map.removeLayer(entry.layerId);
    this.map.removeSource(entry.sourceId);
    this.entries.delete(entry.basemap.id);
  }

  private layerSpec(id: string, source: string, basemap: Basemap): LayerSpecification {
    return {
      id,
      type: 'raster',
      source,
      layout: { visibility: basemap.visible ? 'visible' : 'none' },
      paint: { 'raster-opacity': basemap.opacity, 'raster-fade-duration': 0 },
    };
  }

  /** `order`'ı daha büyük ilk altlığın katmanı; yoksa çapa (operasyonel katmanların hemen altı). */
  private beforeIdFor(basemap: Basemap): string {
    let best: BasemapEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.basemap.id === basemap.id || entry.basemap.order <= basemap.order) continue;
      if (!best || entry.basemap.order < best.basemap.order) best = entry;
    }
    return best?.layerId ?? this.anchorLayerId;
  }
}

function prefixesOf(spec: SourceSpecification): string[] {
  if ('tiles' in spec && spec.tiles) return spec.tiles.map(urlPrefix);
  if ('url' in spec && typeof spec.url === 'string') return [urlPrefix(spec.url)];
  return [];
}
