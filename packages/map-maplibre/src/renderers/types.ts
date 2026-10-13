// ── Kind renderer sözleşmesi (MapLibre) ──────────────────────────
// Tasarım: plan/design/05-adapter-and-events.md#renderer-türleri
//
// MapLibre veri güdümlüdür: unsur başına motor nesnesi YOK. Her kind iki şey sağlar:
//   1. `layers(ctx)`  → render group başına BİR KEZ eklenen style layer'lar (değerler ['get', '_x'] ile)
//   2. `encode(rf)`   → unsuru düz GeoJSON parçalarına çeviren SAF fonksiyon

import type { FeatureKindRegistry, RenderFeature } from '@c2/map-core';
import type { LayerSpecification } from 'maplibre-gl';
import type { EncodedPart } from '../encode';

export type MaplibreLayerContext = {
  readonly kind: string;
  readonly groupId: string;
  /** Bu render group'un GeoJSON kaynağı. */
  readonly sourceId: string;
  /** Katman id'si üretir: `c2-<grup>-<kind>-<ek>` (çakışmasız). */
  layerId(suffix: string): string;
};

export type MaplibreEncodeContext = {
  readonly kinds: FeatureKindRegistry;
  readonly pixelRatio: number;
};

/** Hit-test dışında bırakılacak katmanın `metadata` işareti (ör. seçim halkası, etiket). */
export const NON_INTERACTIVE = { 'c2:interactive': false } as const;

export interface MaplibreKindRenderer {
  layers(ctx: MaplibreLayerContext): LayerSpecification[];
  encode(rf: RenderFeature, ctx: MaplibreEncodeContext): EncodedPart[];
}

// ── Ortak ifadeler ───────────────────────────────────────────────

const state = (key: 'selected' | 'hovered') => ['boolean', ['feature-state', key], false];

/** Seçili / hover / normal için üç değerden birini seçen ifade. */
export const byState = (selected: unknown, hovered: unknown, normal: unknown): unknown => [
  'case',
  state('selected'),
  selected,
  state('hovered'),
  hovered,
  normal,
];

/** Taban opaklık × efektif katman opaklığı (`_op`). */
export const withOpacity = (base: unknown): unknown => ['*', base, ['get', '_op']];

export const SORT_KEY = ['get', '_z'];

export const isPolygon = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
export const isLineOrPolygon = [
  'in',
  ['geometry-type'],
  ['literal', ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']],
];
export const isPoint = ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]];

export const SELECTED_COLOR = '#ffffff';
export const HOVER_COLOR = '#9ad0ff';
