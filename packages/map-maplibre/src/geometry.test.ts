import { distance, GEOMETRY_KIND, type LngLat } from '@c2/map-core';
import { describe, expect, it } from 'vitest';
import { diffPart } from './encode';
import { representativePoint, toGeoJSONGeometry } from './geometry';

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
    for (const p of ring) expect(distance([32.85, 39.9], p as unknown as LngLat)).toBeCloseTo(5000, 6);
  });

  it('kaynak koordinatları kopyalanır (store nesneleri MapLibre\'ye verilmez)', () => {
    const coord = [1, 2] as const;
    const geometry = toGeoJSONGeometry({ kind: GEOMETRY_KIND.POINT, coord }) as GeoJSON.Point;
    expect(geometry.coordinates).not.toBe(coord);
  });
});

describe('elips / koridor / representativePoint', () => {
  it('elips ve koridor → çekirdeğin jeodezik poligonu', () => {
    const ellipse = toGeoJSONGeometry({
      kind: GEOMETRY_KIND.ELLIPSE,
      center: [32.85, 39.9],
      semiMajorM: 4000,
      semiMinorM: 1000,
      rotationDeg: 0,
    }) as GeoJSON.Polygon;
    const ring = ellipse.coordinates[0]! as unknown as LngLat[];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(distance([32.85, 39.9], ring[0]!)).toBeCloseTo(4000, 6); // t = 0: büyük eksen ucu (kuzey)
    const corridor = toGeoJSONGeometry({ kind: GEOMETRY_KIND.CORRIDOR, coords: [[32, 39], [33, 39]], widthM: 2000 });
    expect(corridor.type).toBe('Polygon');
    expect((corridor as GeoJSON.Polygon).coordinates[0]).toHaveLength(5);
  });

  it('temsilci nokta: nokta → kendisi, daire / elips → merkez, poligon → kutu merkezi', () => {
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
