// ── Çizim: ortak tipler ──────────────────────────────────────────
// Tasarım: plan/design/09-interaction-and-editing.md#çizim-mimarisi-öneri (karar #8: B)
//
// Araçlar çekirdekte, motordan bağımsız durum makineleridir. Adapter yalnız iki şey sağlar:
//   - işaretçi olayları (CLICK / DBLCLICK / POINTER_MOVE — zaten var)
//   - `setDrawMode` (çift tık zoom'u kapat, imleç) ve `setDrawPreview` (anlık önizleme)

import type { Geometry, LngLat } from "../model/geometry";

export const DRAW_TOOL = {
  POINT: "point",
  LINE: "line",
  POLYGON: "polygon",
  CIRCLE: "circle",
  RECTANGLE: "rectangle",
  CORRIDOR: "corridor",
  ELLIPSE: "ellipse",
} as const;
export type DrawToolKind = (typeof DRAW_TOOL)[keyof typeof DRAW_TOOL];

export type DrawToolOptions = {
  /** Koridor genişliği (m). Verilirse genişlik adımı atlanır; verilmezse fareyle belirlenir. */
  corridorWidthM?: number;
};

/** Adapter'ın çizdiği anlık önizleme (store'a girmez: imleç hızında, MapSync'in 10 Hz sınırı dışında). */
export type DrawPreview = {
  /** Çizilmekte olan şekil. */
  shape: Geometry | null;
  /** Köşe / kontrol noktaları. */
  vertices: readonly LngLat[];
  /** Yardımcı çizgiler (yarıçap, elips eksenleri). */
  guides: readonly (readonly LngLat[])[];
};

export const EMPTY_PREVIEW: DrawPreview = { shape: null, vertices: [], guides: [] };

/** Çizim sırasında canlı ölçüm (araç çubuğunda gösterilir). */
export type DrawMeasurement = {
  lengthM?: number;
  areaM2?: number;
  perimeterM?: number;
  radiusM?: number;
  widthM?: number;
  semiMajorM?: number;
  semiMinorM?: number;
  /** Derece, kuzeyden saat yönünde. */
  bearingDeg?: number;
};

export type ClickResult = "continue" | "done";
export type FinishResult = "done" | "continue" | "invalid";

/** Aracın ekran yakınlığı sorusu (çift tık tekrarını ayıklama, poligonu ilk köşede kapatma). */
export type ToolContext = {
  near(a: LngLat, b: LngLat, px: number): boolean;
};

export interface DrawTool {
  readonly kind: DrawToolKind;
  /** İşaretçi hareketi (önizleme güncellenir). */
  move(coord: LngLat): void;
  /** Tıklama: adım ekler; araç bittiyse `done`. */
  click(coord: LngLat): ClickResult;
  /** Enter / çift tık: bitir veya sonraki adıma geç (koridorda genişlik). */
  finish(): FinishResult;
  /** Son adımı geri al. */
  undo(): void;
  readonly canUndo: boolean;
  readonly canFinish: boolean;
  preview(): DrawPreview;
  measure(): DrawMeasurement;
  /** Kullanıcıya şu an ne yapacağını söyleyen kısa metin. */
  hint(): string;
  /** Geçerli sonuç (yoksa `null`). */
  result(): Geometry | null;
}
