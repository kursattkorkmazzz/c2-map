// ── Jeodezik hesaplar (WGS84 elipsoidi) ──────────────────────────
// Tasarım: plan/design/08-extensibility-symbology.md#koordinat-sistemleri
//
// GeographicLib (Karney): mesafe ~nm, alan elipsoid üzerinde kesin. Küre formülleri (haversine)
// %0,3'e kadar hata verir; askeri ölçümde (menzil, alan) kabul edilmez.

import geographiclib from "geographiclib-geodesic";
import type { LngLat } from "../model/geometry";

const WGS84 = geographiclib.Geodesic.WGS84;

/** İki nokta arası en kısa yol (m). */
export function distance(a: LngLat, b: LngLat): number {
  return WGS84.Inverse(a[1], a[0], b[1], b[0]).s12!;
}

/** `a`'dan `b`'ye başlangıç yönü (derece, kuzeyden saat yönünde, [0, 360)). */
export function bearing(a: LngLat, b: LngLat): number {
  const azimuth = WGS84.Inverse(a[1], a[0], b[1], b[0]).azi1!;
  return (azimuth + 360) % 360;
}

/** `origin`'den `bearingDeg` yönünde `distanceM` metre gidilince varılan nokta. */
export function destination(origin: LngLat, bearingDeg: number, distanceM: number): LngLat {
  const r = WGS84.Direct(origin[1], origin[0], bearingDeg, distanceM);
  return [normalize180(r.lon2!), r.lat2!];
}

/** Çizgi uzunluğu (m). */
export function lineLength(coords: readonly LngLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distance(coords[i - 1]!, coords[i]!);
  return total;
}

/**
 * Poligon alanı (m²). İlk halka dış sınır, sonrakiler delik (alanları çıkarılır). Halkanın
 * kapalı (ilk = son) olması gerekmez; yön (saat yönü / tersi) önemsiz.
 */
export function polygonArea(rings: readonly (readonly LngLat[])[]): number {
  let area = 0;
  rings.forEach((ring, i) => {
    const a = ringArea(ring);
    area += i === 0 ? a : -a;
  });
  return Math.max(0, area);
}

/** Halkanın çevresi (m). */
export function ringPerimeter(ring: readonly LngLat[]): number {
  const open = withoutClosing(ring);
  if (open.length < 2) return 0;
  return lineLength([...open, open[0]!]);
}

/**
 * Daireyi poligon halkası olarak üretir (her köşe merkezden tam `radiusM` metre — jeodezik).
 * Kapalı halka döner (ilk = son).
 */
export function geodesicCircle(center: LngLat, radiusM: number, segments = 64): LngLat[] {
  const ring: LngLat[] = [];
  for (let i = 0; i < segments; i++) ring.push(destination(center, (360 * i) / segments, radiusM));
  ring.push(ring[0]!);
  return ring;
}

function ringArea(ring: readonly LngLat[]): number {
  const open = withoutClosing(ring);
  if (open.length < 3) return 0;
  const polygon = WGS84.Polygon(false);
  for (const [lon, lat] of open) polygon.AddPoint(lat, lon);
  return Math.abs(polygon.Compute(false, true).area!);
}

function withoutClosing(ring: readonly LngLat[]): readonly LngLat[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first && last && ring.length > 1 && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}

function normalize180(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// ── Gösterim ─────────────────────────────────────────────────────

/** 850 m · 12,4 km (`locale` varsayılan tr-TR). */
export function formatDistance(meters: number, locale = "tr-TR"): string {
  if (meters < 1000) return `${Math.round(meters).toLocaleString(locale)} m`;
  return `${(meters / 1000).toLocaleString(locale, { maximumFractionDigits: meters < 100_000 ? 2 : 1 })} km`;
}

/** 950 m² · 3,5 ha · 12,4 km² */
export function formatArea(squareMeters: number, locale = "tr-TR"): string {
  if (squareMeters < 10_000) return `${Math.round(squareMeters).toLocaleString(locale)} m²`;
  if (squareMeters < 1_000_000) return `${(squareMeters / 10_000).toLocaleString(locale, { maximumFractionDigits: 2 })} ha`;
  return `${(squareMeters / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 2 })} km²`;
}
