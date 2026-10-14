// ── MGRS (Military Grid Reference System) ───────────────────────
// Tasarım: plan/design/08-extensibility-symbology.md#koordinat-sistemleri
//
// "36S VK 84296 20004" = UTM zone + bant (grid zone) + 100 km kare harfleri + doğu/kuzey.
// MGRS bir NOKTA değil bir KAREDİR: rakamlar KESİLİR (yuvarlanmaz), referans karenin güneybatı
// köşesini gösterir. Hassasiyet 5 → 1 m, 4 → 10 m … 0 → 100 km.

import type { LngLat } from "../model/geometry";
import { fromUtm, toUtm, UTM_BANDS, utmBand, type Utm } from "./utm";

// 100 km kare sütun harfleri (zone % 3'e göre üç küme) ve satır harfleri (çift zone'da 5 kaydırılmış).
const COLUMN_SETS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];
const ROW_LETTERS = "ABCDEFGHJKLMNPQRSTUV";

export type MgrsOptions = {
  /** 0–5 (varsayılan 5 = 1 m). */
  precision?: number;
  /** Boşluklu biçim "36S VK 84296 20004" (varsayılan `true`). */
  spaced?: boolean;
};

export function toMgrs(coord: LngLat, options: MgrsOptions = {}): string {
  const precision = options.precision ?? 5;
  if (!Number.isInteger(precision) || precision < 0 || precision > 5) {
    throw new RangeError(`MGRS hassasiyeti 0–5 olmalı (verilen: ${precision}).`);
  }
  const utm = toUtm(coord);
  const { zone, band } = utm;

  const column = COLUMN_SETS[(zone - 1) % 3]![Math.floor(utm.easting / 100_000) - 1]!;
  const rowIndex = (Math.floor(utm.northing / 100_000) + (zone % 2 === 0 ? 5 : 0)) % 20;
  const row = ROW_LETTERS[rowIndex]!;

  const digits = (value: number) =>
    String(Math.floor((value % 100_000) / 10 ** (5 - precision))).padStart(precision, "0");
  const e = precision > 0 ? digits(utm.easting) : "";
  const n = precision > 0 ? digits(utm.northing) : "";

  return options.spaced === false
    ? `${zone}${band}${column}${row}${e}${n}`
    : [`${zone}${band}`, `${column}${row}`, e, n].filter(Boolean).join(" ");
}

export type MgrsPoint = {
  /** Karenin MERKEZİ (haritada gitmek / işaretlemek için). */
  coord: LngLat;
  /** Karenin güneybatı köşesi (MGRS'in tanımladığı nokta). */
  southWest: LngLat;
  /** Karenin kenarı (m): 1, 10 … 100 000. */
  sizeM: number;
  utm: Utm;
};

/** MGRS metni → nokta. Boşluk ve küçük harf serbest. Tanınmazsa `null`. */
export function parseMgrs(text: string): MgrsPoint | null {
  const m = /^\s*(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*(\d*)\s*(\d*)\s*$/i.exec(text);
  if (!m) return null;
  const zone = Number(m[1]);
  if (zone < 1 || zone > 60) return null;
  const band = m[2]!.toUpperCase();
  const columnLetter = m[3]!.toUpperCase();
  const rowLetter = m[4]!.toUpperCase();

  // Rakamlar tek blok ("8429620004") veya iki blok ("84296 20004") olabilir.
  const numerals = m[5]! + m[6]!;
  if (numerals.length % 2 !== 0 || numerals.length > 10) return null;
  if (m[6]! !== "" && m[5]!.length !== m[6]!.length) return null;
  const precision = numerals.length / 2;
  const scale = 10 ** (5 - precision);
  const e = precision ? Number(numerals.slice(0, precision)) * scale : 0;
  const n = precision ? Number(numerals.slice(precision)) * scale : 0;

  const columnIndex = COLUMN_SETS[(zone - 1) % 3]!.indexOf(columnLetter);
  if (columnIndex < 0) return null;
  let rowIndex = ROW_LETTERS.indexOf(rowLetter);
  if (rowIndex < 0) return null;
  if (zone % 2 === 0) rowIndex = (rowIndex - 5 + 20) % 20;

  const easting = (columnIndex + 1) * 100_000 + e;

  // Satır harfi kuzeyi 2000 km periyotla verir: bandın güney kenarının kuzeyinden başlayarak bul.
  const bandIndex = UTM_BANDS.indexOf(band);
  const bandSouthLat = -80 + bandIndex * 8;
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const bandNorthing = Math.floor(toUtm([lon0, bandSouthLat], zone).northing / 100_000) * 100_000;
  let northing = rowIndex * 100_000 + n;
  while (northing < bandNorthing) northing += 2_000_000;

  const utm: Utm = { zone, band, easting, northing };
  const southWest = fromUtm(utm);
  const coord = fromUtm({ ...utm, easting: easting + scale / 2, northing: northing + scale / 2 });
  // Bant tutarlılığı: kare banttan kopuksa (yanlış satır harfi) reddet. Bant kenarındaki
  // kareler komşu banda taşabildiği için ±1 bant hoş görülür.
  const lat = Math.max(-80, Math.min(84, coord[1]));
  if (Math.abs(UTM_BANDS.indexOf(utmBand(lat)) - bandIndex) > 1) return null;
  return { coord, southWest, sizeM: scale, utm };
}
