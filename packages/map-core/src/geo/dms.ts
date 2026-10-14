// ── Derece biçimleri (DD / DM / DMS) ve serbest metinden koordinat ──
// Tasarım: plan/design/08-extensibility-symbology.md#koordinat-sistemleri
//
// İnsanlar koordinatı ENLEM önce yazar ("39.92, 32.85"); GeoJSON / bu kütüphane [lon, lat] tutar.
// Metin fonksiyonları bu yüzden enlem-boylam sırasıyla yazar/okur, LngLat döner.
// Yön harfleri İngilizce (N S E W) veya Türkçe (K G D B: Kuzey Güney Doğu Batı).

import type { LngLat } from "../model/geometry";
import { parseMgrs, toMgrs } from "./mgrs";
import { formatUtm, fromUtm, parseUtm, toUtm } from "./utm";

export const COORD_FORMAT = {
  /** 39.92000°N 32.85000°E */
  DD: "dd",
  /** 39°55.200'N 32°51.000'E */
  DM: "dm",
  /** 39°55'12.0"N 32°51'00.0"E */
  DMS: "dms",
  /** 36S VK 84296 20004 */
  MGRS: "mgrs",
  /** 36S 684296 4420004 */
  UTM: "utm",
} as const;
export type CoordFormat = (typeof COORD_FORMAT)[keyof typeof COORD_FORMAT];

export const HEMISPHERES = {
  EN: "en",
  TR: "tr",
} as const;
export type Hemispheres = (typeof HEMISPHERES)[keyof typeof HEMISPHERES];

const LETTERS: Record<Hemispheres, { n: string; s: string; e: string; w: string }> = {
  en: { n: "N", s: "S", e: "E", w: "W" },
  tr: { n: "K", s: "G", e: "D", w: "B" },
};

export type FormatCoordOptions = {
  format?: CoordFormat;
  /** Ondalık hane: DD 5, DM 3, DMS 1 (varsayılan); MGRS'te hassasiyet 0–5 (varsayılan 5). */
  decimals?: number;
  /** Yön harfleri (varsayılan `en`). */
  hemispheres?: Hemispheres;
};

/** Koordinatı insan için yazar (enlem önce). */
export function formatCoordinate(coord: LngLat, options: FormatCoordOptions = {}): string {
  const format = options.format ?? COORD_FORMAT.DMS;
  if (format === COORD_FORMAT.MGRS) return toMgrs(coord, { precision: options.decimals ?? 5 });
  if (format === COORD_FORMAT.UTM) return formatUtm(toUtm(coord));
  const [lon, lat] = coord;
  return `${formatAngle(lat, "lat", options)} ${formatAngle(lon, "lon", options)}`;
}

/** Tek açı: `formatAngle(39.92, 'lat', { format: 'dms' })` → `39°55'12.0"N`. */
export function formatAngle(value: number, axis: "lat" | "lon", options: FormatCoordOptions = {}): string {
  const format = options.format ?? COORD_FORMAT.DMS;
  const letters = LETTERS[options.hemispheres ?? HEMISPHERES.EN];
  const hemi = axis === "lat" ? (value < 0 ? letters.s : letters.n) : value < 0 ? letters.w : letters.e;
  const abs = Math.abs(value);

  if (format === COORD_FORMAT.DD) return `${abs.toFixed(options.decimals ?? 5)}°${hemi}`;

  if (format === COORD_FORMAT.DM) {
    const decimals = options.decimals ?? 3;
    // Yuvarlama taşmasını (59.9999' → 60.000') önce tamsayı birimde çöz.
    const unit = 10 ** decimals;
    const totalMin = Math.round(abs * 60 * unit);
    const deg = Math.floor(totalMin / (60 * unit));
    const min = (totalMin - deg * 60 * unit) / unit;
    return `${deg}°${pad(min.toFixed(decimals), decimals)}'${hemi}`;
  }

  const decimals = options.decimals ?? 1;
  const unit = 10 ** decimals;
  const totalSec = Math.round(abs * 3600 * unit);
  const deg = Math.floor(totalSec / (3600 * unit));
  const min = Math.floor((totalSec - deg * 3600 * unit) / (60 * unit));
  const sec = (totalSec - deg * 3600 * unit - min * 60 * unit) / unit;
  return `${deg}°${String(min).padStart(2, "0")}'${pad(sec.toFixed(decimals), decimals)}"${hemi}`;
}

/** "5.2" → "05.2" (dakika / saniyenin tam kısmı iki hane). */
function pad(text: string, decimals: number): string {
  return text.padStart(decimals > 0 ? 3 + decimals : 2, "0");
}

// ── Okuma ────────────────────────────────────────────────────────

const LAT_LETTERS = "NSKG";
const LON_LETTERS = "EWDB";
const NEGATIVE_LETTERS = "SWGB";
const HEMI = "[NSEWKGDB]";

/**
 * Serbest metinden koordinat ("koordinata git" kutusu). Sırayla dener:
 *   MGRS  "36S VK 84296 20004"         UTM  "36S 684296 4420004"
 *   DD    "39.92, 32.85" · "39,92 32,85" · "39.92N 32.85E" · "K39.92 D32.85"
 *   DM    "39°55.2'N 32°51'E"
 *   DMS   "39°55'12\"N 32°51'00\"E" · "39 55 12 N 32 51 0 E" · "395512K 0325100D" yok (desteklenmez)
 * Yön harfi yoksa ENLEM önce kabul edilir. Tanınmazsa `null`.
 */
export function parseCoordinate(text: string): LngLat | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const mgrs = parseMgrs(trimmed);
  if (mgrs) return mgrs.coord;
  const utm = parseUtm(trimmed);
  if (utm) {
    try {
      return fromUtm(utm);
    } catch {
      return null;
    }
  }

  const parts = splitPair(normalize(trimmed));
  if (!parts) return null;
  const a = parseAngle(parts[0]);
  const b = parseAngle(parts[1]);
  if (!a || !b) return null;

  // Eksen: harften; harf yoksa sıradan (enlem önce). İki harf aynı eksendeyse geçersiz.
  const axisA = a.axis ?? (b.axis ? (b.axis === "lat" ? "lon" : "lat") : "lat");
  const axisB = b.axis ?? (axisA === "lat" ? "lon" : "lat");
  if (axisA === axisB) return null;
  const lat = axisA === "lat" ? a.value : b.value;
  const lon = axisA === "lat" ? b.value : a.value;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

function normalize(text: string): string {
  return text
    .toUpperCase()
    .replace(/[″“”]|''/g, '"')
    .replace(/[′’`´]/g, "'")
    .replace(/[º˚]/g, "°")
    .replace(/\s+/g, " ")
    .trim();
}

/** Metni enlem / boylam yarılarına böler. */
function splitPair(text: string): [string, string] | null {
  // 1) Açık ayraç: ";" "/" "|" veya ", " (virgül + boşluk) ya da virgülün iki yanında birer sayı
  //    olup ondalık virgül kullanılmamışsa.
  for (const sep of [";", "/", "|"]) {
    const i = text.indexOf(sep);
    if (i >= 0) return [text.slice(0, i), text.slice(i + 1)];
  }

  // 2) Yön harfleri: sonek ("…N 32…E") → ilk harften sonra; önek ("N39… E32…") → ikinci harften önce.
  const letters = [...text.matchAll(new RegExp(HEMI, "g"))];
  if (letters.length === 2) {
    const first = letters[0]!.index!;
    const second = letters[1]!.index!;
    const prefixStyle = first === 0 || /^[-+]?$/.test(text.slice(0, first).trim());
    const cut = prefixStyle ? second : first + 1;
    return [text.slice(0, cut).replace(/,\s*$/, ""), text.slice(cut).replace(/^\s*,/, "")];
  }
  if (letters.length !== 0) return null;

  // 3) ", " veya tek virgül (sayılar noktalıysa) ayraçtır.
  const commaSpace = text.indexOf(", ");
  if (commaSpace >= 0) return [text.slice(0, commaSpace), text.slice(commaSpace + 2)];
  const commas = text.split(",").length - 1;
  if (commas === 1 && !/\d,\d+\s+\d/.test(text) && text.includes(".")) {
    const [x, y] = text.split(",");
    return [x!, y!];
  }

  // 4) Ayraç yok: sayıları ikiye böl ("39 55 12 32 51 0" → 3 + 3; "39,92 32,85" → 1 + 1).
  const tokens = text.split(" ").filter(Boolean);
  if (tokens.length % 2 !== 0 || tokens.length === 0 || tokens.length > 6) return null;
  const half = tokens.length / 2;
  return [tokens.slice(0, half).join(" "), tokens.slice(half).join(" ")];
}

function parseAngle(part: string): { value: number; axis?: "lat" | "lon" } | null {
  const letter = new RegExp(HEMI).exec(part)?.[0];
  const rest = part.replace(new RegExp(HEMI, "g"), "").trim();
  if (!/^[-+]?[\d\s.,°'":]+$/.test(rest)) return null;
  const negative = rest.startsWith("-") || (letter !== undefined && NEGATIVE_LETTERS.includes(letter));
  if (rest.startsWith("-") && letter !== undefined && NEGATIVE_LETTERS.includes(letter)) return null; // çift işaret

  const numbers = rest.match(/\d+(?:[.,]\d+)?/g)?.map((n) => Number(n.replace(",", ".")));
  if (!numbers || numbers.length === 0 || numbers.length > 3) return null;
  const [deg, min = 0, sec = 0] = numbers as [number, number?, number?];
  // Yalnız son bileşen ondalıklı olabilir; dakika / saniye < 60.
  if (numbers.length > 1 && (!Number.isInteger(deg) || min >= 60 || sec >= 60)) return null;
  if (numbers.length > 2 && !Number.isInteger(min)) return null;

  const value = (deg + min / 60 + sec / 3600) * (negative ? -1 : 1);
  const axis = letter === undefined ? undefined : LAT_LETTERS.includes(letter) ? "lat" : LON_LETTERS.includes(letter) ? "lon" : undefined;
  return { value, axis };
}
