// ── Çekirdek geometrisi → GeoJSON ────────────────────────────────
// GeoJSON'da daire ve dikdörtgen yoktur: ikisi de poligona çevrilir. Daire jeodezik olarak
// (küre üzerinde gerçek metre yarıçapıyla) üretilir → zoom'dan bağımsız doğru boyut.

import { GEOMETRY_KIND, type Geometry, type LngLat } from '@c2/map-core';

const EARTH_RADIUS_M = 6_371_008.8;
const CIRCLE_SEGMENTS = 64;

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
    case GEOMETRY_KIND.RECTANGLE: {
      const [x0, y0] = geometry.min;
      const [x1, y1] = geometry.max;
      return { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] };
    }
    case GEOMETRY_KIND.CIRCLE:
      return { type: 'Polygon', coordinates: [circleRing(geometry.center, geometry.radiusM)] };
  }
}

/** Merkezden `radiusM` metre uzaklıktaki noktalar (küresel hedef nokta formülü), kapalı halka. */
export function circleRing(center: LngLat, radiusM: number, segments = CIRCLE_SEGMENTS): GeoJSON.Position[] {
  const toRad = Math.PI / 180;
  const lat1 = center[1] * toRad;
  const lon1 = center[0] * toRad;
  const d = radiusM / EARTH_RADIUS_M;
  const ring: GeoJSON.Position[] = [];
  for (let i = 0; i <= segments; i++) {
    const bearing = ((i % segments) / segments) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
    const lon2 =
      lon1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    ring.push([lon2 / toRad, lat2 / toRad]);
  }
  return ring;
}

/** Herhangi bir geometrinin temsilci noktası (marker için): nokta ise kendisi, değilse sınır kutusunun merkezi. */
export function representativePoint(geometry: Geometry): GeoJSON.Point {
  if (geometry.kind === GEOMETRY_KIND.POINT) return { type: 'Point', coordinates: position(geometry.coord) };
  if (geometry.kind === GEOMETRY_KIND.CIRCLE) return { type: 'Point', coordinates: position(geometry.center) };
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
