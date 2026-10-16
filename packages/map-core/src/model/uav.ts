// ── İHA (composite) unsurunun props'u ────────────────────────────
// Tasarım: plan/design/08-extensibility-symbology.md#composite-unsur-iha
//
// Motor bilmez: aynı unsur MapLibre + deck.gl'de (2,5B) ve Cesium'da (3B, arazi) çizilir.
// Konum unsurun nokta geometrisinden gelir; irtifa `altitudeM` (+ `altitudeRef`).

import type { SensorParams } from "../geo/sensor";
import type { Feature } from "./feature";
import type { LngLat } from "./geometry";

export const ALTITUDE_REF = {
  /** Yerden yükseklik (AGL). Arazisiz motorlarda (MapLibre) tek anlamlı referans. */
  GROUND: "ground",
  /** Deniz seviyesinden yükseklik (MSL) — gerçek telemetri genelde budur. Arazili motor zemini çıkarır. */
  SEA: "sea",
} as const;
export type AltitudeRef = (typeof ALTITUDE_REF)[keyof typeof ALTITUDE_REF];

/** `kind: 'uav'` unsurunun props'u. */
export type UavProps = {
  /** Burun yönü: derece, kuzeyden saat yönünde. */
  headingDeg: number;
  /** İrtifa (m); referansı `altitudeRef`. */
  altitudeM: number;
  /**
   * İrtifa referansı (varsayılan `ground`). Arazisiz motor (MapLibre) ikisini de yerden yükseklik
   * olarak çizer; Cesium `sea`'de zemin yüksekliğini çıkararak sensör izini hesaplar.
   */
  altitudeRef?: AltitudeRef;
  /** Kamera / gimbal. Yoksa koni çizilmez. */
  sensor?: SensorParams;
  /** Etiket (ör. çağrı adı). */
  callsign?: string;
};

/**
 * İki İHA mesajı arası ara hâl (akıcı hareket): konum (varsa z dahil), irtifa, burun yönü (en kısa
 * açıdan: 350° → 10° 0°'dan geçer), kamera pan / eğim / görüş açısı. Diğer alanlar hedef mesajdan.
 * Motor bilmez: deck.gl (`interpolate`) ve Cesium (kayma) aynı fonksiyonu kullanır.
 */
export function interpolateUav(from: Feature, to: Feature, t: number): Feature {
  const a = uavPropsOf(from);
  const b = uavPropsOf(to);
  const pa = from.geometry.kind === "point" ? from.geometry.coord : null;
  const pb = to.geometry.kind === "point" ? to.geometry.coord : null;
  if (!a || !b || !pa || !pb) return to;
  const lerp = (x: number, y: number) => x + (y - x) * t;
  const sensor =
    a.sensor && b.sensor
      ? {
          ...b.sensor,
          panDeg: lerpAngle(a.sensor.panDeg, b.sensor.panDeg, t),
          tiltDeg: lerp(a.sensor.tiltDeg, b.sensor.tiltDeg),
          hfovDeg: lerp(a.sensor.hfovDeg, b.sensor.hfovDeg),
          vfovDeg: lerp(a.sensor.vfovDeg, b.sensor.vfovDeg),
        }
      : b.sensor;
  const props: UavProps = {
    ...b,
    headingDeg: (lerpAngle(a.headingDeg, b.headingDeg, t) + 360) % 360,
    altitudeM: lerp(a.altitudeM, b.altitudeM),
    ...(sensor ? { sensor } : {}),
  };
  const coord: LngLat =
    pa[2] !== undefined && pb[2] !== undefined
      ? [lerp(pa[0], pb[0]), lerp(pa[1], pb[1]), lerp(pa[2], pb[2])]
      : [lerp(pa[0], pb[0]), lerp(pa[1], pb[1])];
  return { ...to, geometry: { kind: "point", coord }, props };
}

/** Unsurun İHA props'u (zorunlu alanlar yoksa `null`). */
export function uavPropsOf(feature: Feature): UavProps | null {
  const p = feature.props as Partial<UavProps> | undefined;
  if (!p || typeof p.headingDeg !== "number" || typeof p.altitudeM !== "number") return null;
  return p as UavProps;
}

/** Açılar arası en kısa yol (derece). */
function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}
