// ── Parametrik şekiller → poligon halkası ────────────────────────
// Daire, elips, koridor ve dikdörtgen modelde parametreleriyle (merkez + metre) tutulur; çizmek
// için her adapter poligona çevirir. Hesap jeodeziktir: metreler zoom'dan ve enlemden bağımsız
// gerçek mesafedir. Adapter'lar aynı fonksiyonları kullanır (MapLibre, Cesium …).

import { GEOMETRY_KIND, type Geometry, type LngLat } from "../model/geometry";
import { bearing, destination, geodesicCircle } from "./geodesic";

/**
 * Elips halkası (kapalı). Büyük eksen `rotationDeg` yönünde (kuzeyden saat yönü); her nokta
 * merkezden jeodezik yön + mesafe ile bulunur.
 */
export function ellipseRing(
  center: LngLat,
  semiMajorM: number,
  semiMinorM: number,
  rotationDeg: number,
  segments = 64,
): LngLat[] {
  const ring: LngLat[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (2 * Math.PI * i) / segments;
    const x = semiMajorM * Math.cos(t); // büyük eksen boyunca
    const y = semiMinorM * Math.sin(t); // küçük eksen boyunca (büyük eksenin 90° sağı)
    const dist = Math.hypot(x, y);
    const dir = rotationDeg + (Math.atan2(y, x) * 180) / Math.PI;
    ring.push(dist === 0 ? center : destination(center, dir, dist));
  }
  ring.push(ring[0]!);
  return ring;
}

/** Köşede dışa taşma sınırı (çok sivri dönüşte uç sonsuza gitmesin): yarı genişliğin katı. */
const MITER_LIMIT = 4;

/**
 * Koridor halkası (kapalı): orta çizginin iki yanına `widthM / 2` uzaklıkta paralel kenarlar,
 * uçlar düz. Köşelerde kenarlar açıortay boyunca uzatılır (miter), `MITER_LIMIT` ile sınırlı.
 */
export function corridorRing(coords: readonly LngLat[], widthM: number): LngLat[] {
  const points = dedupe(coords);
  if (points.length < 2 || !(widthM > 0)) return [];
  const half = widthM / 2;
  const left: LngLat[] = [];
  const right: LngLat[] = [];
  const last = points.length - 1;

  for (let i = 0; i <= last; i++) {
    const p = points[i]!;
    // Noktadaki gidiş yönü: gelen ve giden parçaların yönleri (jeodezik, o noktada ölçülür).
    const incoming = i > 0 ? (bearing(p, points[i - 1]!) + 180) % 360 : null;
    const outgoing = i < last ? bearing(p, points[i + 1]!) : null;
    let dir: number;
    let offset = half;
    if (incoming === null) dir = outgoing!;
    else if (outgoing === null) dir = incoming;
    else {
      const turn = angleDiff(outgoing, incoming); // (-180, 180]
      dir = incoming + turn / 2;
      offset = Math.min(half / Math.cos(((turn / 2) * Math.PI) / 180), half * MITER_LIMIT);
    }
    left.push(destination(p, dir - 90, offset));
    right.push(destination(p, dir + 90, offset));
  }
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]!);
  return ring;
}

/**
 * Parametrik geometrinin poligon halkaları (çizim için). Zaten poligon / çizgi / nokta olanlar
 * için `null` (adapter onları doğrudan çizer).
 */
export function shapeRings(geometry: Geometry, segments = 64): LngLat[][] | null {
  switch (geometry.kind) {
    case GEOMETRY_KIND.CIRCLE:
      return [geodesicCircle(geometry.center, geometry.radiusM, segments)];
    case GEOMETRY_KIND.ELLIPSE:
      return [ellipseRing(geometry.center, geometry.semiMajorM, geometry.semiMinorM, geometry.rotationDeg, segments)];
    case GEOMETRY_KIND.CORRIDOR: {
      const ring = corridorRing(geometry.coords, geometry.widthM);
      return ring.length ? [ring] : [];
    }
    case GEOMETRY_KIND.RECTANGLE: {
      const [x0, y0] = geometry.min;
      const [x1, y1] = geometry.max;
      return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
    }
    default:
      return null;
  }
}

/** b'den a'ya en kısa açı farkı, (-180, 180]. */
function angleDiff(a: number, b: number): number {
  let d = (((a - b) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

function dedupe(coords: readonly LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const c of coords) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) out.push(c);
  }
  return out;
}
