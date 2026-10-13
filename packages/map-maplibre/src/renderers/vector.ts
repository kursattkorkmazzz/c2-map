// ── `vector` kind: çizgi, poligon, nokta (kontrol tedbirleri, çizimler) ──
// Tek unsur → tek parça. Poligonlar dolgu + çerçeve, çizgiler çerçeve, noktalar daire olarak çizilir.

import type { Feature } from '@c2/map-core';
import type { LayerSpecification } from 'maplibre-gl';
import { toGeoJSONGeometry } from '../geometry';
import {
  byState,
  HOVER_COLOR,
  isLineOrPolygon,
  isPoint,
  isPolygon,
  SELECTED_COLOR,
  SORT_KEY,
  withOpacity,
  type MaplibreKindRenderer,
} from './types';

export type VectorStyle = {
  fillColor?: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  pointColor?: string;
  pointRadius?: number;
};

export const VECTOR_DEFAULTS: Required<VectorStyle> = {
  fillColor: '#3d8bfd',
  fillOpacity: 0.2,
  strokeColor: '#3d8bfd',
  strokeWidth: 2,
  strokeOpacity: 1,
  pointColor: '#3d8bfd',
  pointRadius: 5,
};

export const vectorRenderer: MaplibreKindRenderer = {
  layers(ctx) {
    const source = ctx.sourceId;
    const filterKind = ['==', ['get', '_kind'], ctx.kind];
    return [
      {
        id: ctx.layerId('fill'),
        type: 'fill',
        source,
        filter: ['all', filterKind, isPolygon],
        layout: { 'fill-sort-key': SORT_KEY },
        paint: {
          'fill-color': ['get', '_fc'],
          'fill-opacity': withOpacity(['get', '_fo']),
        },
      },
      {
        id: ctx.layerId('line'),
        type: 'line',
        source,
        filter: ['all', filterKind, isLineOrPolygon],
        layout: { 'line-sort-key': SORT_KEY, 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': byState(SELECTED_COLOR, HOVER_COLOR, ['get', '_sc']),
          'line-width': ['+', ['get', '_sw'], byState(2, 1, 0)],
          'line-opacity': withOpacity(['get', '_so']),
        },
      },
      {
        id: ctx.layerId('point'),
        type: 'circle',
        source,
        filter: ['all', filterKind, isPoint],
        layout: { 'circle-sort-key': SORT_KEY },
        paint: {
          'circle-color': ['get', '_pc'],
          'circle-radius': ['get', '_pr'],
          'circle-opacity': withOpacity(1),
          'circle-stroke-color': byState(SELECTED_COLOR, HOVER_COLOR, '#000000'),
          'circle-stroke-width': byState(2, 2, 0),
        },
      },
    ] as unknown as LayerSpecification[]; // ifadeler (expression) MapLibre tiplerinde dar tanımlı
  },

  encode(rf, ctx) {
    const feature: Feature = ctx.kinds.withDefaults(rf.feature);
    const style = { ...VECTOR_DEFAULTS, ...(feature.style as VectorStyle | undefined) };
    return [
      {
        geometry: toGeoJSONGeometry(feature.geometry),
        properties: {
          _fc: style.fillColor,
          _fo: style.fillOpacity,
          _sc: style.strokeColor,
          _sw: style.strokeWidth,
          _so: style.strokeOpacity,
          _pc: style.pointColor,
          _pr: style.pointRadius,
        },
      },
    ];
  },
};
