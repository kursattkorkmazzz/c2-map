// ── Çizim önizlemesi (MapLibre) ──────────────────────────────────
// Tasarım: plan/design/09-interaction-and-editing.md#çizim-mimarisi-öneri
//
// Araçlar çekirdekte; adapter yalnız önizlemeyi çizer. Önizleme store'a girmez: imleç hızında
// `setData` ile tek küçük kaynağa yazılır (MapSync'in 10 Hz sınırına ve 50k birlik akışına takılmaz).
//
// Önizleme katmanları mount'ta yığının EN ÜSTÜNE kalıcı eklenir ve bir ÇAPA görevi görür:
// tüm operasyonel katmanlar (deck.gl taşıyıcıları dahil) bunun altına girer. Böylece çizim hep
// en üstte görünür; deck.gl "son" taşıyıcısı kendini en üste taşıyıp çizimi örtemez.

import type { DrawPreview } from '@c2/map-core';
import type { LayerSpecification } from 'maplibre-gl';
import { toGeoJSONGeometry } from './geometry';

export const DRAW_PREVIEW_SOURCE = 'c2-draw-preview';
/** Önizlemenin en alttaki katmanı: operasyonel katmanların üst sınırı (çapa). */
export const DRAW_ANCHOR_LAYER = 'c2-draw-fill';

const ROLE = { SHAPE: 'shape', GUIDE: 'guide', VERTEX: 'vertex', MIDPOINT: 'midpoint', ACTIVE: 'active' } as const;
const COLOR = '#ffcc00';
const role = (value: string) => ['==', ['get', 'role'], value];

export const DRAW_PREVIEW_LAYERS = [
  {
    id: DRAW_ANCHOR_LAYER,
    type: 'fill',
    source: DRAW_PREVIEW_SOURCE,
    filter: ['all', role(ROLE.SHAPE), ['==', ['geometry-type'], 'Polygon']],
    paint: { 'fill-color': COLOR, 'fill-opacity': 0.15 },
  },
  {
    id: 'c2-draw-line',
    type: 'line',
    source: DRAW_PREVIEW_SOURCE,
    filter: role(ROLE.SHAPE),
    paint: { 'line-color': COLOR, 'line-width': 2, 'line-dasharray': [3, 2] },
  },
  {
    id: 'c2-draw-guide',
    type: 'line',
    source: DRAW_PREVIEW_SOURCE,
    filter: role(ROLE.GUIDE),
    paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-dasharray': [2, 2], 'line-opacity': 0.8 },
  },
  {
    id: 'c2-draw-vertex',
    type: 'circle',
    source: DRAW_PREVIEW_SOURCE,
    filter: role(ROLE.VERTEX),
    paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': COLOR, 'circle-stroke-width': 2 },
  },
  {
    // Düzenleme: ara nokta (taşınınca köşe eklenir) — köşeden küçük, yarı saydam
    id: 'c2-draw-midpoint',
    type: 'circle',
    source: DRAW_PREVIEW_SOURCE,
    filter: role(ROLE.MIDPOINT),
    paint: { 'circle-radius': 3, 'circle-color': COLOR, 'circle-opacity': 0.6, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 },
  },
  {
    // Düzenleme: tutulan tutamaç
    id: 'c2-draw-active',
    type: 'circle',
    source: DRAW_PREVIEW_SOURCE,
    filter: role(ROLE.ACTIVE),
    paint: { 'circle-radius': 7, 'circle-color': COLOR, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
  },
] as unknown as LayerSpecification[];

export const EMPTY_COLLECTION: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function previewToGeoJSON(preview: DrawPreview | null): GeoJSON.FeatureCollection {
  if (!preview) return EMPTY_COLLECTION;
  const features: GeoJSON.Feature[] = [];
  if (preview.shape) features.push({ type: 'Feature', geometry: toGeoJSONGeometry(preview.shape), properties: { role: ROLE.SHAPE } });
  for (const guide of preview.guides) {
    if (guide.length < 2) continue;
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: guide.map((c) => [...c]) }, properties: { role: ROLE.GUIDE } });
  }
  const point = (c: readonly number[], r: string): GeoJSON.Feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [...c] }, properties: { role: r } });
  for (const v of preview.vertices) features.push(point(v, ROLE.VERTEX));
  for (const m of preview.midpoints ?? []) features.push(point(m, ROLE.MIDPOINT));
  if (preview.active) features.push(point(preview.active, ROLE.ACTIVE));
  return { type: 'FeatureCollection', features };
}
