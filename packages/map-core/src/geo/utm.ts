// ── UTM (WGS84) ──────────────────────────────────────────────────
// Tasarım: plan/design/08-extensibility-symbology.md#koordinat-sistemleri
//
// Krüger serisi (6. derece; Karney 2011): zone içinde ~mm doğruluk. Kapsam -80°..84° enlem
// (MGRS ile aynı; kutuplar UPS ister — kapsam dışı). Norveç / Svalbard zone istisnaları dahil.
//
// Metin biçimi askeri alışkanlıkla ENLEM BANDI harfiyle yazılır: "36S 684296 4420004".
// Buradaki "S" güney yarımküre DEĞİL, S bandıdır (32°–40°K; Türkiye). Yarımküre banttan çıkar:
// C–M güney, N–X kuzey.

import type { LngLat } from "../model/geometry";

const A_AXIS = 6378137;
const FLATTENING = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING = 500_000;
const FALSE_NORTHING_SOUTH = 10_000_000;

/** Enlem bantları; X 72°–84° (12°). */
export const UTM_BANDS = "CDEFGHJKLMNPQRSTUVWX";
export const UTM_MIN_LAT = -80;
export const UTM_MAX_LAT = 84;

export type Utm = {
  /** 1–60 */
  zone: number;
  /** Enlem bandı (C–X). Yarımküre: `band >= 'N'` kuzey. */
  band: string;
  /** Doğu (m), yanlış doğu 500 000 dahil. */
  easting: number;
  /** Kuzey (m); güney yarımkürede yanlış kuzey 10 000 000 dahil. */
  northing: number;
};

// ── Seri katsayıları (bir kez) ───────────────────────────────────

const E = Math.sqrt(FLATTENING * (2 - FLATTENING));
const N = FLATTENING / (2 - FLATTENING);
const [n2, n3, n4, n5, n6] = [N ** 2, N ** 3, N ** 4, N ** 5, N ** 6];
const A = (A_AXIS / (1 + N)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);

const ALPHA = [
  N / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4 - (127 / 288) * n5 + (7891 / 37800) * n6,
  (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4 + (281 / 630) * n5 - (1983433 / 1935360) * n6,
  (61 / 240) * n3 - (103 / 140) * n4 + (15061 / 26880) * n5 + (167603 / 181440) * n6,
  (49561 / 161280) * n4 - (179 / 168) * n5 + (6601661 / 7257600) * n6,
  (34729 / 80640) * n5 - (3418889 / 1995840) * n6,
  (212378941 / 319334400) * n6,
];
const BETA = [
  N / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4 - (81 / 512) * n5 + (96199 / 604800) * n6,
  (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4 + (46 / 105) * n5 - (1118711 / 3870720) * n6,
  (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5 + (5569 / 90720) * n6,
  (4397 / 161280) * n4 - (11 / 504) * n5 - (830251 / 7257600) * n6,
  (4583 / 161280) * n5 - (108847 / 3991680) * n6,
  (20648693 / 638668800) * n6,
];

const RAD = Math.PI / 180;

// ── Zone / bant ──────────────────────────────────────────────────

/** Noktanın UTM zone'u (Norveç ve Svalbard istisnalarıyla). */
export function utmZone(lon: number, lat: number): number {
  let zone = Math.floor((normalizeLon(lon) + 180) / 6) + 1;
  if (zone > 60) zone = 60; // lon = 180
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32; // Norveç
  if (lat >= 72 && lat <= 84 && lon >= 0 && lon < 42) {
    // Svalbard: 31, 33, 35, 37
    if (lon < 9) return 31;
    if (lon < 21) return 33;
    if (lon < 33) return 35;
    return 37;
  }
  return zone;
}

/** Enlem bandı harfi (C–X). */
export function utmBand(lat: number): string {
  assertLat(lat);
  return UTM_BANDS[Math.min(Math.floor((lat + 80) / 8), UTM_BANDS.length - 1)]!;
}

export const isNorthernBand = (band: string): boolean => band.toUpperCase() >= "N";

// ── Dönüşümler ───────────────────────────────────────────────────

/** lon/lat → UTM. `zone` verilirse o zone'a zorlar (zone sınırında komşu zone'da çalışmak için). */
export function toUtm(coord: LngLat, zone?: number): Utm {
  const [lon, lat] = coord;
  assertLat(lat);
  const z = zone ?? utmZone(lon, lat);
  const lon0 = (z - 1) * 6 - 180 + 3;

  const phi = lat * RAD;
  const lambda = normalizeLon(lon - lon0) * RAD;

  const tau = Math.tan(phi);
  const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
  const tauP = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
  const xiP = Math.atan2(tauP, Math.cos(lambda));
  const etaP = Math.asinh(Math.sin(lambda) / Math.sqrt(tauP * tauP + Math.cos(lambda) ** 2));

  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 6; j++) {
    const a = ALPHA[j - 1]!;
    xi += a * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += a * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }

  return {
    zone: z,
    band: utmBand(lat),
    easting: K0 * A * eta + FALSE_EASTING,
    northing: K0 * A * xi + (lat < 0 ? FALSE_NORTHING_SOUTH : 0),
  };
}

/** UTM → lon/lat. Yarımküre `band`'dan çıkar. */
export function fromUtm(utm: Utm): LngLat {
  const { zone, band, easting, northing } = utm;
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) throw new RangeError(`Geçersiz UTM zone: ${zone}`);
  if (!UTM_BANDS.includes(band.toUpperCase())) throw new RangeError(`Geçersiz UTM bandı: ${band}`);
  const lon0 = (zone - 1) * 6 - 180 + 3;

  const eta = (easting - FALSE_EASTING) / (K0 * A);
  const xi = (northing - (isNorthernBand(band) ? 0 : FALSE_NORTHING_SOUTH)) / (K0 * A);

  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 6; j++) {
    const b = BETA[j - 1]!;
    xiP -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }

  const sinhEtaP = Math.sinh(etaP);
  const sinXiP = Math.sin(xiP);
  const cosXiP = Math.cos(xiP);
  const tauP = sinXiP / Math.sqrt(sinhEtaP * sinhEtaP + cosXiP * cosXiP);

  // τ'dan τ'ya Newton-Raphson (Karney 2011, eş. 19–21)
  let tau = tauP;
  for (let i = 0; i < 10; i++) {
    const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
    const tauI = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    const delta =
      ((tauP - tauI) / Math.sqrt(1 + tauI * tauI)) *
      ((1 + (1 - E * E) * tau * tau) / ((1 - E * E) * Math.sqrt(1 + tau * tau)));
    tau += delta;
    if (Math.abs(delta) < 1e-12) break;
  }

  const lat = Math.atan(tau) / RAD;
  const lon = normalizeLon(Math.atan2(sinhEtaP, cosXiP) / RAD + lon0);
  return [lon, lat];
}

// ── Metin ────────────────────────────────────────────────────────

/** "36S 684296 4420004" (metre, tam sayıya yuvarlanır). */
export function formatUtm(utm: Utm): string {
  return `${utm.zone}${utm.band} ${Math.round(utm.easting)} ${Math.round(utm.northing)}`;
}

/** "36S 684296 4420004" / "36 S 684296mE 4420004mN" → Utm. Tanınmazsa `null`. */
export function parseUtm(text: string): Utm | null {
  const m = /^\s*(\d{1,2})\s*([C-HJ-NP-X])\s+(\d+(?:[.,]\d+)?)\s*(?:m\s*E)?[\s,]+(\d+(?:[.,]\d+)?)\s*(?:m\s*N)?\s*$/i.exec(text);
  if (!m) return null;
  const zone = Number(m[1]);
  if (zone < 1 || zone > 60) return null;
  return {
    zone,
    band: m[2]!.toUpperCase(),
    easting: Number(m[3]!.replace(",", ".")),
    northing: Number(m[4]!.replace(",", ".")),
  };
}

// ── Yardımcılar ──────────────────────────────────────────────────

function assertLat(lat: number): void {
  if (!(lat >= UTM_MIN_LAT && lat <= UTM_MAX_LAT)) {
    throw new RangeError(`UTM/MGRS ${UTM_MIN_LAT}°..${UTM_MAX_LAT}° enlem aralığında tanımlı (verilen: ${lat}).`);
  }
}

/** Boylamı [-180, 180) aralığına getirir (180 → 180 korunur). */
export function normalizeLon(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
