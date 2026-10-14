// ── Sensör izi (kamera konisi → zemin) ───────────────────────────
// Tasarım: plan/design/08-extensibility-symbology.md#composite-unsur-iha
//
// Hava aracındaki kameranın (gimbal) baktığı alanın zemindeki izdüşümü. Motor bilmez: MapLibre /
// deck.gl de Cesium de aynı köşeleri çizer.
//
//   yön (azimut) = burun yönü + pan          eğim = ufkun altına bakış (90 = tam aşağı)
//   görüş açısı  = yatay × dikey FOV          zemin = düz (irtifa = yerden yükseklik)
//
// Yerel doğu-kuzey-yukarı (ENU) uzayında bakış ekseni ve görüş dörtgeninin dört köşe ışını
// kurulur, her ışın zemin düzlemiyle kesiştirilir. Ufka yakın / üstüne bakan ışın zemini çok
// uzakta (veya hiç) keser: `maxRangeM` ile kesilir.

import type { LngLat } from "../model/geometry";
import { destination } from "./geodesic";

export type SensorParams = {
  /** Buruna göre yatay dönüş (derece; + saat yönü / sağ). 0 = tam ileri. */
  panDeg: number;
  /** Ufkun altına bakış (derece). 0 = ufuk, 90 = tam aşağı. */
  tiltDeg: number;
  /** Yatay görüş açısı (derece). */
  hfovDeg: number;
  /** Dikey görüş açısı (derece). */
  vfovDeg: number;
  /** Zeminde en uzak yatay mesafe (m); ufka yakın ışınlar burada kesilir. Varsayılan 20 km. */
  maxRangeM?: number;
};

export type SensorFootprint = {
  /** Koninin tepesi: [lon, lat, irtifa]. */
  apex: readonly [number, number, number];
  /** Zemindeki dört köşe: uzak-sol, uzak-sağ, yakın-sağ, yakın-sol (halka sırası). */
  corners: readonly [LngLat, LngLat, LngLat, LngLat];
  /** Bakış ekseninin zemindeki noktası. */
  center: LngLat;
  /** Bakış ekseninin yönü (derece, kuzeyden saat yönü). */
  azimuthDeg: number;
  /** En az bir ışın ufkun üstüne bakıyor / menzilde kesildi (iz gerçek görüş alanından küçük). */
  clipped: boolean;
};

const RAD = Math.PI / 180;
const DEFAULT_RANGE_M = 20_000;

type Vec3 = [number, number, number];

export function sensorFootprint(
  position: LngLat,
  altitudeM: number,
  headingDeg: number,
  sensor: SensorParams,
): SensorFootprint {
  const maxRange = sensor.maxRangeM ?? DEFAULT_RANGE_M;
  const azimuthDeg = (((headingDeg + sensor.panDeg) % 360) + 360) % 360;
  const az = azimuthDeg * RAD;
  const tilt = sensor.tiltDeg * RAD;
  const h = Math.max(altitudeM, 0.1);

  // Kamera eksenleri (E, N, U)
  const forward: Vec3 = [Math.sin(az) * Math.cos(tilt), Math.cos(az) * Math.cos(tilt), -Math.sin(tilt)];
  const right: Vec3 = [Math.cos(az), -Math.sin(az), 0];
  const up = cross(right, forward);
  const tx = Math.tan((sensor.hfovDeg / 2) * RAD);
  const ty = Math.tan((sensor.vfovDeg / 2) * RAD);

  let clipped = false;
  const ground = (ray: Vec3): LngLat => {
    let east: number;
    let north: number;
    if (ray[2] < -1e-9) {
      const t = h / -ray[2];
      east = t * ray[0];
      north = t * ray[1];
    } else {
      // Ufka paralel / yukarı: zemini kesmez → bakış yönünde menzil sınırında
      clipped = true;
      const len = Math.hypot(ray[0], ray[1]) || 1;
      east = (ray[0] / len) * maxRange;
      north = (ray[1] / len) * maxRange;
    }
    let dist = Math.hypot(east, north);
    if (dist > maxRange) {
      clipped = true;
      east *= maxRange / dist;
      north *= maxRange / dist;
      dist = maxRange;
    }
    if (dist < 1e-6) return [position[0], position[1]];
    return destination(position, Math.atan2(east, north) / RAD, dist);
  };
  const corner = (sx: number, sy: number): LngLat =>
    ground([
      forward[0] + sx * tx * right[0] + sy * ty * up[0],
      forward[1] + sx * tx * right[1] + sy * ty * up[1],
      forward[2] + sx * tx * right[2] + sy * ty * up[2],
    ]);

  const corners: [LngLat, LngLat, LngLat, LngLat] = [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)];
  const center = ground(forward);
  return { apex: [position[0], position[1], altitudeM], corners, center, azimuthDeg, clipped };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
