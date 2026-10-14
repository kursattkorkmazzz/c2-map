// ── Çizim araçları (saf durum makineleri) ────────────────────────
// Etkileşim tıklama tabanlıdır (sürükleme yok): harita kaydırmasıyla çakışmaz, adapter'dan
// "kaydırmayı kilitle" istemek gerekmez, dokunmatikte de aynı çalışır.
//
//   nokta      tıkla
//   çizgi      tıkla, tıkla … → çift tık / Enter
//   poligon    tıkla, tıkla … → ilk köşeye tıkla / çift tık / Enter
//   daire      merkez → yarıçap
//   dikdörtgen köşe → karşı köşe
//   elips      merkez → büyük eksen (uzunluk + yön) → küçük eksen
//   koridor    orta çizgi (çizgi gibi) → genişlik (fareyle; `corridorWidthM` verilmişse atlanır)

import { GEOMETRY_KIND, type Geometry, type LngLat } from "../model/geometry";
import { bearing, distance, lineLength, polygonArea, ringPerimeter } from "../geo/geodesic";
import {
  DRAW_TOOL,
  EMPTY_PREVIEW,
  type ClickResult,
  type DrawMeasurement,
  type DrawPreview,
  type DrawTool,
  type DrawToolKind,
  type DrawToolOptions,
  type FinishResult,
  type ToolContext,
} from "./types";

/** Çift tıkta gelen ikinci tıklamayı (aynı yerde) yok saymak için. */
const DUPLICATE_PX = 4;
/** Poligonu ilk köşeye tıklayarak kapatma yarıçapı. */
const CLOSE_PX = 10;

export function createDrawTool(kind: DrawToolKind, ctx: ToolContext, options: DrawToolOptions = {}): DrawTool {
  switch (kind) {
    case DRAW_TOOL.POINT:
      return new PointTool();
    case DRAW_TOOL.LINE:
    case DRAW_TOOL.POLYGON:
    case DRAW_TOOL.CORRIDOR:
      return new PathTool(kind, ctx, options);
    case DRAW_TOOL.CIRCLE:
      return new CircleTool();
    case DRAW_TOOL.RECTANGLE:
      return new RectangleTool();
    case DRAW_TOOL.ELLIPSE:
      return new EllipseTool();
  }
}

// ── Nokta ────────────────────────────────────────────────────────

class PointTool implements DrawTool {
  readonly kind = DRAW_TOOL.POINT;
  private cursor: LngLat | null = null;
  private placed: LngLat | null = null;
  readonly canUndo = false;
  get canFinish() {
    return this.placed !== null;
  }
  move(coord: LngLat) {
    this.cursor = coord;
  }
  click(coord: LngLat): ClickResult {
    this.placed = coord;
    return "done";
  }
  finish(): FinishResult {
    return this.placed ? "done" : "invalid";
  }
  undo() {}
  preview(): DrawPreview {
    const at = this.placed ?? this.cursor;
    return at ? { shape: null, vertices: [at], guides: [] } : EMPTY_PREVIEW;
  }
  measure(): DrawMeasurement {
    return {};
  }
  hint() {
    return "Noktayı koymak için tıklayın.";
  }
  result(): Geometry | null {
    return this.placed ? { kind: GEOMETRY_KIND.POINT, coord: this.placed } : null;
  }
}

// ── Çizgi / poligon / koridor ────────────────────────────────────

class PathTool implements DrawTool {
  private readonly vertices: LngLat[] = [];
  private cursor: LngLat | null = null;
  /** Koridorda orta çizgi bitti, genişlik bekleniyor. */
  private widthPhase = false;
  private widthM: number | null;

  constructor(
    readonly kind: typeof DRAW_TOOL.LINE | typeof DRAW_TOOL.POLYGON | typeof DRAW_TOOL.CORRIDOR,
    private readonly ctx: ToolContext,
    options: DrawToolOptions,
  ) {
    this.widthM = options.corridorWidthM ?? null;
  }

  private get minVertices() {
    return this.kind === DRAW_TOOL.POLYGON ? 3 : 2;
  }

  get canUndo() {
    return this.widthPhase || this.vertices.length > 0;
  }

  get canFinish() {
    return this.widthPhase ? (this.widthM ?? 0) > 0 : this.vertices.length >= this.minVertices;
  }

  move(coord: LngLat) {
    this.cursor = coord;
    if (this.widthPhase) this.widthM = 2 * distanceToPolyline(coord, this.vertices);
  }

  click(coord: LngLat): ClickResult {
    if (this.widthPhase) {
      this.widthM = 2 * distanceToPolyline(coord, this.vertices);
      return this.widthM > 0 ? "done" : "continue";
    }
    const last = this.vertices[this.vertices.length - 1];
    if (last && this.ctx.near(coord, last, DUPLICATE_PX)) return "continue"; // çift tıkın ikinci tıkı
    const first = this.vertices[0];
    if (this.kind === DRAW_TOOL.POLYGON && first && this.vertices.length >= 3 && this.ctx.near(coord, first, CLOSE_PX)) {
      return "done";
    }
    this.vertices.push(coord);
    return "continue";
  }

  finish(): FinishResult {
    if (this.widthPhase) return this.canFinish ? "done" : "invalid";
    if (this.vertices.length < this.minVertices) return "invalid";
    if (this.kind === DRAW_TOOL.CORRIDOR && this.widthM === null) {
      this.widthPhase = true;
      if (this.cursor) this.move(this.cursor);
      return "continue";
    }
    return "done";
  }

  undo() {
    if (this.widthPhase) {
      this.widthPhase = false;
      this.widthM = null;
      return;
    }
    this.vertices.pop();
  }

  /** Çizim sürerken imleç de son köşe sayılır (lastik bant). */
  private live(): LngLat[] {
    return this.cursor && !this.widthPhase ? [...this.vertices, this.cursor] : this.vertices;
  }

  preview(): DrawPreview {
    const live = this.live();
    const vertices = this.vertices;
    if (live.length === 0) return EMPTY_PREVIEW;
    if (live.length === 1) return { shape: null, vertices: live, guides: [] };

    if (this.kind === DRAW_TOOL.POLYGON) {
      const shape: Geometry =
        live.length >= 3
          ? { kind: GEOMETRY_KIND.POLYGON, rings: [[...live, live[0]!]] }
          : { kind: GEOMETRY_KIND.LINE, coords: live };
      return { shape, vertices, guides: [] };
    }
    if (this.kind === DRAW_TOOL.CORRIDOR && this.widthM !== null && this.widthM > 0) {
      return {
        shape: { kind: GEOMETRY_KIND.CORRIDOR, coords: live, widthM: this.widthM },
        vertices,
        guides: [live],
      };
    }
    return { shape: { kind: GEOMETRY_KIND.LINE, coords: live }, vertices, guides: [] };
  }

  measure(): DrawMeasurement {
    const live = this.live();
    if (this.kind === DRAW_TOOL.POLYGON) {
      return live.length >= 3 ? { areaM2: polygonArea([live]), perimeterM: ringPerimeter(live) } : { lengthM: lineLength(live) };
    }
    const m: DrawMeasurement = { lengthM: lineLength(live) };
    if (this.kind === DRAW_TOOL.CORRIDOR && this.widthM !== null) m.widthM = this.widthM;
    return m;
  }

  hint() {
    const n = this.vertices.length;
    if (this.widthPhase) return "Genişliği fareyle ayarlayıp tıklayın.";
    if (n === 0) return this.kind === DRAW_TOOL.CORRIDOR ? "Koridor orta çizgisinin ilk noktasına tıklayın." : "İlk noktaya tıklayın.";
    if (n < this.minVertices) return "Sonraki noktaya tıklayın.";
    if (this.kind === DRAW_TOOL.POLYGON) return "Nokta ekleyin; bitirmek için ilk noktaya tıklayın, çift tıklayın veya Enter.";
    if (this.kind === DRAW_TOOL.CORRIDOR && this.widthM === null) return "Nokta ekleyin; genişliğe geçmek için çift tıklayın veya Enter.";
    return "Nokta ekleyin; bitirmek için çift tıklayın veya Enter.";
  }

  result(): Geometry | null {
    if (this.vertices.length < this.minVertices) return null;
    if (this.kind === DRAW_TOOL.LINE) return { kind: GEOMETRY_KIND.LINE, coords: [...this.vertices] };
    if (this.kind === DRAW_TOOL.POLYGON) {
      return { kind: GEOMETRY_KIND.POLYGON, rings: [[...this.vertices, this.vertices[0]!]] };
    }
    if (!(this.widthM && this.widthM > 0)) return null;
    return { kind: GEOMETRY_KIND.CORRIDOR, coords: [...this.vertices], widthM: this.widthM };
  }
}

// ── Daire ────────────────────────────────────────────────────────

class CircleTool implements DrawTool {
  readonly kind = DRAW_TOOL.CIRCLE;
  private center: LngLat | null = null;
  private edge: LngLat | null = null;
  private cursor: LngLat | null = null;

  get canUndo() {
    return this.center !== null;
  }
  get canFinish() {
    return this.radius() > 0;
  }
  private radius(): number {
    const to = this.edge ?? this.cursor;
    return this.center && to ? distance(this.center, to) : 0;
  }
  move(coord: LngLat) {
    this.cursor = coord;
  }
  click(coord: LngLat): ClickResult {
    if (!this.center) {
      this.center = coord;
      return "continue";
    }
    if (distance(this.center, coord) === 0) return "continue";
    this.edge = coord;
    return "done";
  }
  finish(): FinishResult {
    if (!this.canFinish) return "invalid";
    this.edge ??= this.cursor;
    return "done";
  }
  undo() {
    this.center = null;
    this.edge = null;
  }
  preview(): DrawPreview {
    if (!this.center) return this.cursor ? { shape: null, vertices: [this.cursor], guides: [] } : EMPTY_PREVIEW;
    const to = this.edge ?? this.cursor;
    const radiusM = this.radius();
    return {
      shape: radiusM > 0 ? { kind: GEOMETRY_KIND.CIRCLE, center: this.center, radiusM } : null,
      vertices: [this.center],
      guides: to ? [[this.center, to]] : [],
    };
  }
  measure(): DrawMeasurement {
    const r = this.radius();
    if (!this.center) return {};
    const to = this.edge ?? this.cursor;
    return { radiusM: r, areaM2: Math.PI * r * r, ...(to && r > 0 ? { bearingDeg: bearing(this.center, to) } : {}) };
  }
  hint() {
    return this.center ? "Yarıçap için tıklayın." : "Dairenin merkezine tıklayın.";
  }
  result(): Geometry | null {
    const radiusM = this.radius();
    return this.center && this.edge && radiusM > 0 ? { kind: GEOMETRY_KIND.CIRCLE, center: this.center, radiusM } : null;
  }
}

// ── Dikdörtgen ───────────────────────────────────────────────────

class RectangleTool implements DrawTool {
  readonly kind = DRAW_TOOL.RECTANGLE;
  private corner: LngLat | null = null;
  private opposite: LngLat | null = null;
  private cursor: LngLat | null = null;

  get canUndo() {
    return this.corner !== null;
  }
  get canFinish() {
    return this.shape() !== null;
  }
  private shape(): Geometry | null {
    const to = this.opposite ?? this.cursor;
    if (!this.corner || !to) return null;
    const [x0, y0] = this.corner;
    const [x1, y1] = to;
    if (x0 === x1 || y0 === y1) return null;
    return {
      kind: GEOMETRY_KIND.RECTANGLE,
      min: [Math.min(x0, x1), Math.min(y0, y1)],
      max: [Math.max(x0, x1), Math.max(y0, y1)],
    };
  }
  move(coord: LngLat) {
    this.cursor = coord;
  }
  click(coord: LngLat): ClickResult {
    if (!this.corner) {
      this.corner = coord;
      return "continue";
    }
    if (coord[0] === this.corner[0] || coord[1] === this.corner[1]) return "continue";
    this.opposite = coord;
    return "done";
  }
  finish(): FinishResult {
    if (!this.canFinish) return "invalid";
    this.opposite ??= this.cursor;
    return "done";
  }
  undo() {
    this.corner = null;
    this.opposite = null;
  }
  preview(): DrawPreview {
    if (!this.corner) return this.cursor ? { shape: null, vertices: [this.cursor], guides: [] } : EMPTY_PREVIEW;
    return { shape: this.shape(), vertices: [this.corner], guides: [] };
  }
  measure(): DrawMeasurement {
    const shape = this.shape();
    if (!shape || shape.kind !== GEOMETRY_KIND.RECTANGLE) return {};
    const [x0, y0] = shape.min;
    const [x1, y1] = shape.max;
    const ring: LngLat[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    return { areaM2: polygonArea([ring]), perimeterM: ringPerimeter(ring) };
  }
  hint() {
    return this.corner ? "Karşı köşeye tıklayın." : "Dikdörtgenin bir köşesine tıklayın.";
  }
  result(): Geometry | null {
    return this.opposite ? this.shape() : null;
  }
}

// ── Elips ────────────────────────────────────────────────────────

class EllipseTool implements DrawTool {
  readonly kind = DRAW_TOOL.ELLIPSE;
  private center: LngLat | null = null;
  private majorEnd: LngLat | null = null;
  private minorEnd: LngLat | null = null;
  private cursor: LngLat | null = null;

  get canUndo() {
    return this.center !== null;
  }
  get canFinish() {
    return this.majorEnd !== null && this.axes().semiMinorM > 0;
  }

  /** Eksenler. Küçük eksen, imlecin büyük eksene dik uzaklığıdır; büyükten uzunsa ikisi yer değiştirir. */
  private axes(): { semiMajorM: number; semiMinorM: number; rotationDeg: number } {
    if (!this.center) return { semiMajorM: 0, semiMinorM: 0, rotationDeg: 0 };
    const majorTo = this.majorEnd ?? this.cursor;
    if (!majorTo) return { semiMajorM: 0, semiMinorM: 0, rotationDeg: 0 };
    const semiMajorM = distance(this.center, majorTo);
    const rotationDeg = semiMajorM > 0 ? bearing(this.center, majorTo) : 0;
    if (!this.majorEnd) return { semiMajorM, semiMinorM: 0, rotationDeg };
    const minorTo = this.minorEnd ?? this.cursor;
    if (!minorTo) return { semiMajorM, semiMinorM: 0, rotationDeg };
    const d = distance(this.center, minorTo);
    const angle = ((bearing(this.center, minorTo) - rotationDeg) * Math.PI) / 180;
    const semiMinorM = Math.abs(d * Math.sin(angle));
    if (semiMinorM > semiMajorM) {
      return { semiMajorM: semiMinorM, semiMinorM: semiMajorM, rotationDeg: (rotationDeg + 90) % 360 };
    }
    return { semiMajorM, semiMinorM, rotationDeg };
  }

  private shape(): Geometry | null {
    if (!this.center) return null;
    const a = this.axes();
    if (a.semiMajorM <= 0) return null;
    // Küçük eksen henüz yoksa ince bir elips yerine büyük ekseni çizgi olarak göster (rehber).
    if (a.semiMinorM <= 0) return null;
    return { kind: GEOMETRY_KIND.ELLIPSE, center: this.center, ...a };
  }

  move(coord: LngLat) {
    this.cursor = coord;
  }
  click(coord: LngLat): ClickResult {
    if (!this.center) {
      this.center = coord;
      return "continue";
    }
    if (!this.majorEnd) {
      if (distance(this.center, coord) === 0) return "continue";
      this.majorEnd = coord;
      return "continue";
    }
    this.minorEnd = coord;
    if (this.axes().semiMinorM <= 0) {
      this.minorEnd = null;
      return "continue";
    }
    return "done";
  }
  finish(): FinishResult {
    if (!this.canFinish) return "invalid";
    this.minorEnd ??= this.cursor;
    return "done";
  }
  undo() {
    if (this.majorEnd) this.majorEnd = null;
    else this.center = null;
    this.minorEnd = null;
  }
  preview(): DrawPreview {
    if (!this.center) return this.cursor ? { shape: null, vertices: [this.cursor], guides: [] } : EMPTY_PREVIEW;
    const majorTo = this.majorEnd ?? this.cursor;
    const guides: LngLat[][] = majorTo ? [[this.center, majorTo]] : [];
    const minorTo = this.majorEnd ? (this.minorEnd ?? this.cursor) : null;
    if (minorTo) guides.push([this.center, minorTo]);
    return { shape: this.shape(), vertices: this.majorEnd ? [this.center, this.majorEnd] : [this.center], guides };
  }
  measure(): DrawMeasurement {
    if (!this.center) return {};
    const { semiMajorM, semiMinorM, rotationDeg } = this.axes();
    return { semiMajorM, semiMinorM, bearingDeg: rotationDeg, areaM2: Math.PI * semiMajorM * semiMinorM };
  }
  hint() {
    if (!this.center) return "Elipsin merkezine tıklayın.";
    if (!this.majorEnd) return "Büyük eksenin ucuna tıklayın (uzunluk ve yön).";
    return "Küçük eksen genişliği için tıklayın.";
  }
  result(): Geometry | null {
    return this.minorEnd ? this.shape() : null;
  }
}

// ── Yardımcılar ──────────────────────────────────────────────────

/**
 * Noktanın çoklu çizgiye en kısa uzaklığı (m). Çizim etkileşimi için: her parçada noktanın
 * çevresinde yerel düzlem (eşdikdörtgen) yaklaşımı; parça birkaç km'yi aşsa da hata çizimde fark edilmez.
 */
export function distanceToPolyline(p: LngLat, line: readonly LngLat[]): number {
  if (line.length === 0) return 0;
  if (line.length === 1) return distance(p, line[0]!);
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110_574;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const ax = (a[0] - p[0]) * kx;
    const ay = (a[1] - p[1]) * ky;
    const bx = (b[0] - p[0]) * kx;
    const by = (b[1] - p[1]) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
