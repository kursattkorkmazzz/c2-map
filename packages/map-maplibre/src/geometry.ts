// ── Çekirdek geometrisi → GeoJSON ────────────────────────────────
// GeoJSON'da daire, elips, koridor ve dikdörtgen yoktur: hepsi poligona çevrilir. Çevirme
// çekirdeğin jeodezik şekil fonksiyonlarıyla (`shapeRings`) yapılır → gerçek metre, zoom'dan
// bağımsız doğru boyut; diğer motorlarla aynı sonuç.

import { GEOMETRY_KIND, shapeRings, type Geometry, type LngLat } from '@c2/map-core';

const position = (c: LngLat): GeoJSON.Position => [...c];
const positions = (cs: readonly LngLat[]): GeoJSON.Position[] => cs.map(position);

export function toGeoJSONGeometry(geometry: Geometry): GeoJSON.Geometry {
  switch (geometry.kind) {
    case GEOMETRY_KIND.POINT:
      return { type: 'Point', coordinates: position(geometry.coord) };
    case GEOMETRY_KIND.MULTI_POINT:
      return { type: 'MultiPoint', coordinates: positions(geometry.coords) };
    case GEOMETRY_KIND.LINE:
      return { type: 'LineString', coordinates: positions(geometry.coords) };
    case GEOMETRY_KIND.MULTI_LINE:
      return { type: 'MultiLineString', coordinates: geometry.lines.map(positions) };
    case GEOMETRY_KIND.POLYGON:
      return { type: 'Polygon', coordinates: geometry.rings.map(positions) };
    case GEOMETRY_KIND.MULTI_POLYGON:
      return { type: 'MultiPolygon', coordinates: geometry.polygons.map((rings) => rings.map(positions)) };
    case GEOMETRY_KIND.RECTANGLE:
    case GEOMETRY_KIND.CIRCLE:
    case GEOMETRY_KIND.ELLIPSE:
    case GEOMETRY_KIND.CORRIDOR:
      return { type: 'Polygon', coordinates: (shapeRings(geometry) ?? []).map(positions) };
  }
}

/** Herhangi bir geometrinin temsilci noktası (marker için): nokta ise kendisi, değilse sınır kutusunun merkezi. */
export function representativePoint(geometry: Geometry): GeoJSON.Point {
  if (geometry.kind === GEOMETRY_KIND.POINT) return { type: 'Point', coordinates: position(geometry.coord) };
  if (geometry.kind === GEOMETRY_KIND.CIRCLE || geometry.kind === GEOMETRY_KIND.ELLIPSE) {
    return { type: 'Point', coordinates: position(geometry.center) };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (value: unknown): void => {
    if (Array.isArray(value) && typeof value[0] === 'number') {
      minX = Math.min(minX, value[0]);
      maxX = Math.max(maxX, value[0]);
      minY = Math.min(minY, value[1] as number);
      maxY = Math.max(maxY, value[1] as number);
    } else if (Array.isArray(value)) value.forEach(visit);
  };
  visit((toGeoJSONGeometry(geometry) as { coordinates: unknown }).coordinates);
  return { type: 'Point', coordinates: [(minX + maxX) / 2, (minY + maxY) / 2] };
}
