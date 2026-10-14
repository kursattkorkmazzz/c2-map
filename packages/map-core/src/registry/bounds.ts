// ── Geometri sınır kutusu ────────────────────────────────────────
// Kind tanımı kendi `bounds`'unu vermezse kullanılan varsayılan hesap (fitBounds, kümeleme, görünürlük).

import type { Bounds } from "../model/camera";
import { GEOMETRY_KIND, type Geometry, type LngLat } from "../model/geometry";

const M_PER_DEG_LAT = 111_320;

/** Geometrinin [minLon, minLat] – [maxLon, maxLat] kutusu. Boş geometride `null`. */
export function geometryBounds(geometry: Geometry): Bounds | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const add = (c: LngLat) => {
    if (c[0] < minLon) minLon = c[0];
    if (c[0] > maxLon) maxLon = c[0];
    if (c[1] < minLat) minLat = c[1];
    if (c[1] > maxLat) maxLat = c[1];
  };
  const addAll = (coords: readonly LngLat[]) => coords.forEach(add);

  switch (geometry.kind) {
    case GEOMETRY_KIND.POINT:
      add(geometry.coord);
      break;
    case GEOMETRY_KIND.LINE:
    case GEOMETRY_KIND.MULTI_POINT:
      addAll(geometry.coords);
      break;
    case GEOMETRY_KIND.POLYGON:
      geometry.rings.forEach(addAll);
      break;
    case GEOMETRY_KIND.MULTI_LINE:
      geometry.lines.forEach(addAll);
      break;
    case GEOMETRY_KIND.MULTI_POLYGON:
      geometry.polygons.forEach((rings) => rings.forEach(addAll));
      break;
    case GEOMETRY_KIND.RECTANGLE:
      add(geometry.min);
      add(geometry.max);
      break;
    case GEOMETRY_KIND.CIRCLE:
      addAround(geometry.center, geometry.radiusM, add);
      break;
    case GEOMETRY_KIND.ELLIPSE:
      addAround(geometry.center, Math.max(geometry.semiMajorM, geometry.semiMinorM), add);
      break;
    case GEOMETRY_KIND.CORRIDOR:
      for (const c of geometry.coords) addAround(c, geometry.widthM / 2, add);
      break;
    default: {
      // Yeni bir geometri türü eklenince derleyici burada uyarsın.
      const unhandled: never = geometry;
      void unhandled;
    }
  }

  if (minLon === Infinity) return null;
  return { min: [minLon, minLat], max: [maxLon, maxLat] };
}

/** Noktanın çevresinde `radiusM` metrelik kare. Yaklaşık (küresel) metre → derece; kutu için yeterli. */
function addAround(center: LngLat, radiusM: number, add: (c: LngLat) => void): void {
  const [lon, lat] = center;
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLon = radiusM / (M_PER_DEG_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 1e-6));
  add([lon - dLon, lat - dLat]);
  add([lon + dLon, lat + dLat]);
}
