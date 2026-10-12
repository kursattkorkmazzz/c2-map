// Koordinat: kanonik WGS84, GeoJSON sırası [lon, lat, alt?]

export type LngLat =
  | readonly [number, number]
  | readonly [number, number, number];

export const GEOMETRY_KIND = {
  POINT: "point",
  LINE: "line",
  POLYGON: "polygon",
  MULTI_POINT: "multi-point",
  MULTI_LINE: "multi-line",
  MULTI_POLYGON: "multi-polygon",
  CIRCLE: "circle",
  RECTANGLE: "rectangle",
} as const;
export type GeometryKind = (typeof GEOMETRY_KIND)[keyof typeof GEOMETRY_KIND];

export type Geometry =
  | { kind: typeof GEOMETRY_KIND.POINT; coord: LngLat }
  | { kind: typeof GEOMETRY_KIND.LINE; coords: LngLat[] }
  | { kind: typeof GEOMETRY_KIND.POLYGON; rings: LngLat[][] }
  | { kind: typeof GEOMETRY_KIND.CIRCLE; center: LngLat; radiusM: number }
  | { kind: typeof GEOMETRY_KIND.RECTANGLE; min: LngLat; max: LngLat }
  | { kind: typeof GEOMETRY_KIND.MULTI_POINT; coords: LngLat[] }
  | { kind: typeof GEOMETRY_KIND.MULTI_LINE; lines: LngLat[][] }
  | { kind: typeof GEOMETRY_KIND.MULTI_POLYGON; polygons: LngLat[][][] };
