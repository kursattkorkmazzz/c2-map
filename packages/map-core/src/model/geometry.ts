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
  /** Genişliği olan hat (koridor, güzergâh): orta çizgi + toplam genişlik (m). */
  CORRIDOR: "corridor",
  ELLIPSE: "ellipse",
} as const;
export type GeometryKind = (typeof GEOMETRY_KIND)[keyof typeof GEOMETRY_KIND];

export type Geometry =
  | { kind: typeof GEOMETRY_KIND.POINT; coord: LngLat }
  | { kind: typeof GEOMETRY_KIND.LINE; coords: readonly LngLat[] }
  | { kind: typeof GEOMETRY_KIND.POLYGON; rings: readonly (readonly LngLat[])[] }
  | { kind: typeof GEOMETRY_KIND.CIRCLE; center: LngLat; radiusM: number }
  | { kind: typeof GEOMETRY_KIND.RECTANGLE; min: LngLat; max: LngLat }
  | { kind: typeof GEOMETRY_KIND.CORRIDOR; coords: readonly LngLat[]; widthM: number }
  | {
      kind: typeof GEOMETRY_KIND.ELLIPSE;
      center: LngLat;
      semiMajorM: number;
      semiMinorM: number;
      /** Büyük eksenin yönü: derece, kuzeyden saat yönünde. */
      rotationDeg: number;
    }
  | { kind: typeof GEOMETRY_KIND.MULTI_POINT; coords: readonly LngLat[] }
  | { kind: typeof GEOMETRY_KIND.MULTI_LINE; lines: readonly (readonly LngLat[])[] }
  | {
      kind: typeof GEOMETRY_KIND.MULTI_POLYGON;
      polygons: readonly (readonly (readonly LngLat[])[])[];
    };
