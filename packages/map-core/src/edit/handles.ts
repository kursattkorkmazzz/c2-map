// ── Düzenleme tutamaçları (saf) ──────────────────────────────────
// Tasarım: plan/design/09-interaction-and-editing.md#düzenleme-faz-252
//
// Geometri → tutulup taşınabilen noktalar; tutamacı yeni konuma taşımak → yeni geometri.
// Çizim araçlarıyla aynı model: motor bilmez, her adapter aynı tutamaçları gösterir.

import { GEOMETRY_KIND, type Geometry, type LngLat } from "../model/geometry";
import { bearing, destination, distance } from "../geo/geodesic";
import { distanceToPolyline } from "../draw/tools";

export const HANDLE_KIND = {
  /** Köşe (çizgi / poligon / koridor / dikdörtgen) veya nokta. */
  VERTEX: "vertex",
  /** İki köşe arası: taşınınca yeni köşe eklenir. */
  MIDPOINT: "midpoint",
  CENTER: "center",
  RADIUS: "radius",
  MAJOR: "major",
  MINOR: "minor",
  /** Koridor genişliği. */
  WIDTH: "width",
} as const;
export type HandleKind = (typeof HANDLE_KIND)[keyof typeof HANDLE_KIND];

export type Handle = {
  /** Geometri içinde kararlı kimlik (ör. `v:0:3` = 0. halka 3. köşe). */
  readonly id: string;
  readonly kind: HandleKind;
  readonly coord: LngLat;
};

/** Geometrinin tutamaçları. Düzenlenemeyen türler (çoklu geometriler) için boş. */
export function handlesOf(geometry: Geometry): Handle[] {
  switch (geometry.kind) {
    case GEOMETRY_KIND.POINT:
      return [{ id: "p", kind: HANDLE_KIND.VERTEX, coord: geometry.coord }];
    case GEOMETRY_KIND.LINE:
      return pathHandles(geometry.coords, 0, false);
    case GEOMETRY_KIND.POLYGON:
      return geometry.rings.flatMap((ring, r) => pathHandles(openRing(ring), r, true));
    case GEOMETRY_KIND.CORRIDOR: {
      const handles = pathHandles(geometry.coords, 0, false);
      const [a, b] = geometry.coords;
      if (a && b) {
        // Genişlik tutamacı: ilk parçanın ortasından sola, yarı genişlik kadar.
        const mid = midpoint(a, b);
        handles.push({ id: "w", kind: HANDLE_KIND.WIDTH, coord: destination(mid, bearing(a, b) - 90, geometry.widthM / 2) });
      }
      return handles;
    }
    case GEOMETRY_KIND.CIRCLE:
      return [
        { id: "c", kind: HANDLE_KIND.CENTER, coord: geometry.center },
        { id: "r", kind: HANDLE_KIND.RADIUS, coord: destination(geometry.center, 90, geometry.radiusM) },
      ];
    case GEOMETRY_KIND.RECTANGLE: {
      const [x0, y0] = geometry.min;
      const [x1, y1] = geometry.max;
      return [
        { id: "r:0", kind: HANDLE_KIND.VERTEX, coord: [x0, y0] },
        { id: "r:1", kind: HANDLE_KIND.VERTEX, coord: [x1, y0] },
        { id: "r:2", kind: HANDLE_KIND.VERTEX, coord: [x1, y1] },
        { id: "r:3", kind: HANDLE_KIND.VERTEX, coord: [x0, y1] },
      ];
    }
    case GEOMETRY_KIND.ELLIPSE:
      return [
        { id: "c", kind: HANDLE_KIND.CENTER, coord: geometry.center },
        { id: "a", kind: HANDLE_KIND.MAJOR, coord: destination(geometry.center, geometry.rotationDeg, geometry.semiMajorM) },
        { id: "b", kind: HANDLE_KIND.MINOR, coord: destination(geometry.center, geometry.rotationDeg + 90, geometry.semiMinorM) },
      ];
    default:
      return [];
  }
}

/** Tutamacı `coord`'a taşır. Geçersiz sonuç (ör. sıfır yarıçap) → `null` (değişiklik yok). */
export function moveHandle(geometry: Geometry, handleId: string, coord: LngLat): Geometry | null {
  switch (geometry.kind) {
    case GEOMETRY_KIND.POINT:
      return handleId === "p" ? { ...geometry, coord } : null;
    case GEOMETRY_KIND.LINE: {
      const coords = movePath(geometry.coords, handleId, 0, coord, false);
      return coords ? { ...geometry, coords } : null;
    }
    case GEOMETRY_KIND.CORRIDOR: {
      if (handleId === "w") {
        const widthM = 2 * distanceToPolyline(coord, geometry.coords);
        return widthM > 0 ? { ...geometry, widthM } : null;
      }
      const coords = movePath(geometry.coords, handleId, 0, coord, false);
      return coords ? { ...geometry, coords } : null;
    }
    case GEOMETRY_KIND.POLYGON: {
      const ringIndex = Number(handleId.split(":")[1]);
      const ring = geometry.rings[ringIndex];
      if (!ring) return null;
      const moved = movePath(openRing(ring), handleId, ringIndex, coord, true);
      if (!moved) return null;
      const rings = geometry.rings.map((r, i) => (i === ringIndex ? closeRing(moved) : r));
      return { ...geometry, rings };
    }
    case GEOMETRY_KIND.CIRCLE: {
      if (handleId === "c") return { ...geometry, center: coord };
      if (handleId !== "r") return null;
      const radiusM = distance(geometry.center, coord);
      return radiusM > 0 ? { ...geometry, radiusM } : null;
    }
    case GEOMETRY_KIND.RECTANGLE: {
      const index = Number(handleId.split(":")[1]);
      if (!(index >= 0 && index <= 3)) return null;
      // Karşı köşe sabit kalır.
      const corners = handlesOf(geometry).map((h) => h.coord);
      const opposite = corners[(index + 2) % 4]!;
      if (coord[0] === opposite[0] || coord[1] === opposite[1]) return null;
      return {
        ...geometry,
        min: [Math.min(coord[0], opposite[0]), Math.min(coord[1], opposite[1])],
        max: [Math.max(coord[0], opposite[0]), Math.max(coord[1], opposite[1])],
      };
    }
    case GEOMETRY_KIND.ELLIPSE: {
      if (handleId === "c") return { ...geometry, center: coord };
      const d = distance(geometry.center, coord);
      if (d === 0) return null;
      if (handleId === "a") return { ...geometry, semiMajorM: d, rotationDeg: bearing(geometry.center, coord) };
      if (handleId === "b") {
        // Küçük eksen: büyük eksene dik bileşen (yön değişmez).
        const angle = ((bearing(geometry.center, coord) - geometry.rotationDeg) * Math.PI) / 180;
        const semiMinorM = Math.abs(d * Math.sin(angle));
        return semiMinorM > 0 ? { ...geometry, semiMinorM } : null;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Köşeyi siler (çizgide ≥ 2, poligon halkasında ≥ 3 köşe kalmalı). Silinemezse `null`. */
export function removeHandle(geometry: Geometry, handleId: string): Geometry | null {
  const [type, ring, index] = handleId.split(":");
  if (type !== "v") return null;
  const i = Number(index);
  if (geometry.kind === GEOMETRY_KIND.LINE || geometry.kind === GEOMETRY_KIND.CORRIDOR) {
    if (geometry.coords.length <= 2) return null;
    return { ...geometry, coords: geometry.coords.filter((_, k) => k !== i) };
  }
  if (geometry.kind === GEOMETRY_KIND.POLYGON) {
    const r = Number(ring);
    const open = openRing(geometry.rings[r] ?? []);
    if (open.length <= 3) return null;
    const rings = geometry.rings.map((rr, k) => (k === r ? closeRing(open.filter((_, j) => j !== i)) : rr));
    return { ...geometry, rings };
  }
  return null;
}

// ── İç ───────────────────────────────────────────────────────────

function pathHandles(coords: readonly LngLat[], ring: number, closed: boolean): Handle[] {
  const handles: Handle[] = coords.map((coord, i) => ({ id: `v:${ring}:${i}`, kind: HANDLE_KIND.VERTEX, coord }));
  const segments = closed ? coords.length : coords.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = coords[i]!;
    const b = coords[(i + 1) % coords.length]!;
    handles.push({ id: `m:${ring}:${i}`, kind: HANDLE_KIND.MIDPOINT, coord: midpoint(a, b) });
  }
  return handles;
}

/** Köşe taşı (`v:r:i`) veya ara noktaya köşe ekle (`m:r:i` → i ile i+1 arasına). */
function movePath(coords: readonly LngLat[], handleId: string, ring: number, coord: LngLat, closed: boolean): LngLat[] | null {
  const [type, r, index] = handleId.split(":");
  if (Number(r) !== ring) return null;
  const i = Number(index);
  if (type === "v") {
    if (!(i >= 0 && i < coords.length)) return null;
    return coords.map((c, k) => (k === i ? coord : c));
  }
  if (type === "m") {
    const segments = closed ? coords.length : coords.length - 1;
    if (!(i >= 0 && i < segments)) return null;
    return [...coords.slice(0, i + 1), coord, ...coords.slice(i + 1)];
  }
  return null;
}

function midpoint(a: LngLat, b: LngLat): LngLat {
  return destination(a, bearing(a, b), distance(a, b) / 2);
}

function openRing(ring: readonly LngLat[]): readonly LngLat[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first && last && ring.length > 1 && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}

function closeRing(open: readonly LngLat[]): LngLat[] {
  return open.length ? [...open, open[0]!] : [];
}
