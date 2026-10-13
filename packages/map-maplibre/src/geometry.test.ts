import { GEOMETRY_KIND } from '@c2/map-core';
import { describe, expect, it } from 'vitest';
import { diffPart } from './encode';
import { circleRing, representativePoint, toGeoJSONGeometry } from './geometry';

/** İki nokta arası büyük daire uzaklığı (m). */
function haversine([lon1, lat1]: number[], [lon2, lat2]: number[]): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2! - lat1!) * toRad;
  const dLon = (lon2! - lon1!) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1! * toRad) * Math.cos(lat2! * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(a));
}

describe('toGeoJSONGeometry', () => {
  it('nokta, çizgi, çoklu poligon', () => {
    expect(toGeoJSONGeometry({ kind: GEOMETRY_KIND.POINT, coord: [1, 2] })).toEqual({ type: 'Point', coordinates: [1, 2] });
    expect(toGeoJSONGeometry({ kind: GEOMETRY_KIND.LINE, coords: [[0, 0], [1, 1]] })).toEqual({
      type: 'LineString',
      coordinates: [[0, 0], [1, 1]],
    });
    expect(
      toGeoJSONGeometry({ kind: GEOMETRY_KIND.MULTI_POLYGON, polygons: [[[[0, 0], [1, 0], [0, 1], [0, 0]]]] }),
    ).toEqual({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [0, 1], [0, 0]]]] });
  });

  it('dikdörtgen → kapalı poligon', () => {
    expect(toGeoJSONGeometry({ kind: GEOMETRY_KIND.RECTANGLE, min: [0, 0], max: [2, 1] })).toEqual({
      type: 'Polygon',
      coordinates: [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]],
    });
  });

  it('daire → jeodezik poligon: her köşe merkezden yarıçap kadar uzakta, halka kapalı', () => {
    const geometry = toGeoJSONGeometry({ kind: GEOMETRY_KIND.CIRCLE, center: [32.85, 39.9], radiusM: 5000 });
    expect(geometry.type).toBe('Polygon');
    const ring = (geometry as GeoJSON.Polygon).coordinates[0]!;
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const p of ring) expect(haversine([32.85, 39.9], p)).toBeCloseTo(5000, 0);
  });

  it('kaynak koordinatları kopyalanır (store nesneleri MapLibre\'ye verilmez)', () => {
    const coord = [1, 2] as const;
    const geometry = toGeoJSONGeometry({ kind: GEOMETRY_KIND.POINT, coord }) as GeoJSON.Point;
    expect(geometry.coordinates).not.toBe(coord);
  });
});

describe('circleRing / representativePoint', () => {
  it('segment sayısı + kapanış noktası', () => {
    expect(circleRing([0, 0], 100, 8)).toHaveLength(9);
  });

  it('temsilci nokta: nokta → kendisi, daire → merkez, poligon → kutu merkezi', () => {
    expect(representativePoint({ kind: GEOMETRY_KIND.POINT, coord: [5, 6] }).coordinates).toEqual([5, 6]);
    expect(representativePoint({ kind: GEOMETRY_KIND.CIRCLE, center: [1, 1], radiusM: 10 }).coordinates).toEqual([1, 1]);
    expect(
      representativePoint({ kind: GEOMETRY_KIND.POLYGON, rings: [[[0, 0], [4, 0], [4, 2], [0, 0]]] }).coordinates,
    ).toEqual([2, 1]);
  });
});

describe('diffPart', () => {
  const geometry: GeoJSON.Point = { type: 'Point', coordinates: [0, 0] };

  it('yalnız konum değişti → yalnız newGeometry', () => {
    const d = diffPart('a', { properties: { _op: 1 } }, { geometry, properties: { _op: 1 } }, true);
    expect(d).toEqual({ id: 'a', newGeometry: geometry });
  });

  it('yalnız değeri değişen özellikler + kaybolanlar', () => {
    const d = diffPart(
      'a',
      { properties: { _op: 1, _z: 5, _icon: 'x' } },
      { geometry, properties: { _op: 0.5, _z: 5 } },
      false,
    );
    expect(d).toEqual({ id: 'a', addOrUpdateProperties: [{ key: '_op', value: 0.5 }], removeProperties: ['_icon'] });
  });

  it('hiçbir şey değişmedi → null', () => {
    expect(diffPart('a', { properties: { _op: 1 } }, { geometry, properties: { _op: 1 } }, false)).toBeNull();
  });
});
