// ── deck.gl: bir render group'un birlik dizileri (saf, WebGL'siz) ──
// Tasarım: plan/design/04-sync-and-rendering.md#deckgl-yolu
//
// Birlik başına sabit indeks (id → indeks); silmede son eleman boşluğa taşınır (swap-remove) →
// diziler hep sıkı, deck.gl'e `subarray(0, n)` verilir. Konum Float64 (deck.gl yüksek hassasiyet),
// boyut Float32, renk/opaklık Uint8 RGBA. Akıcı harekette "nereden → nereye, ne zaman" tutulur.

export type DeckIcon = {
  /** Atlas anahtarı: aynı id'li ikon bir kez yüklenir. */
  id: string;
  /** Görüntü URL'si (data URL olabilir). */
  url: string;
  /** Görüntünün piksel boyutu (atlas yerleşimi için). */
  width: number;
  height: number;
};

const INITIAL_CAPACITY = 256;
const NOT_MOVING = -1;

export class DeckGroupData {
  /** Kayıtlı birlik sayısı (dizilerin dolu kısmı). */
  n = 0;
  readonly ids: string[] = [];
  readonly icons: (DeckIcon | undefined)[] = [];

  pos = new Float64Array(0); // ekranda gösterilen [lon, lat]
  fromPos = new Float64Array(0);
  toPos = new Float64Array(0);
  tStart = new Float64Array(0); // kaymanın başladığı an; NOT_MOVING: yerinde
  size = new Float32Array(0); // px yükseklik
  color = new Uint8Array(0); // RGBA (A = efektif opaklık)

  /** Değişiklik sayaçları: deck.gl `updateTriggers` ve yeni sarmalayıcı nesneler için. */
  posVersion = 0;
  styleVersion = 0;
  /** Birlik eklendi/çıktı → deck.gl data uzunluğu değişti (tam yeniden kurulum). */
  lengthVersion = 0;

  private readonly indexOf = new Map<string, number>();
  private capacity = 0;
  private moving = 0; // animasyonu bitmemiş birlik sayısı (yaklaşık; animate günceller)

  constructor() {
    this.grow(INITIAL_CAPACITY);
  }

  has(id: string): boolean {
    return this.indexOf.has(id);
  }

  index(id: string): number | undefined {
    return this.indexOf.get(id);
  }

  /**
   * Birliği ekler veya günceller. `smooth` ise ve birlik zaten varsa ekrandaki konumdan yeni konuma
   * kayar; değilse konum hemen yazılır.
   */
  upsert(
    id: string,
    update: { coord?: readonly [number, number]; icon?: DeckIcon; size?: number; opacity?: number },
    smooth: boolean,
    now: number,
  ): void {
    let i = this.indexOf.get(id);
    const isNew = i === undefined;
    if (i === undefined) i = this.append(id);

    if (update.coord) {
      const [lon, lat] = update.coord;
      if (smooth && !isNew) {
        this.fromPos[i * 2] = this.pos[i * 2]!;
        this.fromPos[i * 2 + 1] = this.pos[i * 2 + 1]!;
        this.tStart[i] = now;
        this.moving++;
      } else {
        this.pos[i * 2] = this.fromPos[i * 2] = lon;
        this.pos[i * 2 + 1] = this.fromPos[i * 2 + 1] = lat;
        this.tStart[i] = NOT_MOVING;
      }
      this.toPos[i * 2] = lon;
      this.toPos[i * 2 + 1] = lat;
      this.posVersion++;
    }
    if (update.icon !== undefined || update.size !== undefined || update.opacity !== undefined) {
      if (update.icon !== undefined) this.icons[i] = update.icon;
      if (update.size !== undefined) this.size[i] = update.size;
      if (update.opacity !== undefined) {
        const o = i * 4;
        this.color[o] = this.color[o + 1] = this.color[o + 2] = 255;
        this.color[o + 3] = Math.round(Math.max(0, Math.min(1, update.opacity)) * 255);
      }
      this.styleVersion++;
    }
  }

  /** Swap-remove: son eleman silinen yere taşınır. */
  remove(id: string): boolean {
    const i = this.indexOf.get(id);
    if (i === undefined) return false;
    const last = --this.n;
    if (i !== last) {
      const movedId = this.ids[last]!;
      this.ids[i] = movedId;
      this.icons[i] = this.icons[last];
      this.indexOf.set(movedId, i);
      for (const arr of [this.pos, this.fromPos, this.toPos]) {
        arr[i * 2] = arr[last * 2]!;
        arr[i * 2 + 1] = arr[last * 2 + 1]!;
      }
      this.tStart[i] = this.tStart[last]!;
      this.size[i] = this.size[last]!;
      this.color.copyWithin(i * 4, last * 4, last * 4 + 4);
    }
    this.indexOf.delete(id);
    this.ids.length = this.n;
    this.icons.length = this.n;
    this.lengthVersion++;
    return true;
  }

  /**
   * Ara konumları hesaplar (akıcı hareket). Hâlâ hareket eden birlik varsa `true`.
   * Hareket eden yoksa diziye dokunmaz (gereksiz GPU yüklemesi olmasın).
   */
  animate(now: number, durationMs: number): boolean {
    if (this.moving === 0) return false;
    const { pos, fromPos, toPos, tStart } = this;
    let stillMoving = 0;
    for (let i = 0; i < this.n; i++) {
      const start = tStart[i]!;
      if (start === NOT_MOVING) continue;
      const t = Math.min(1, (now - start) / durationMs);
      pos[i * 2] = fromPos[i * 2]! + (toPos[i * 2]! - fromPos[i * 2]!) * t;
      pos[i * 2 + 1] = fromPos[i * 2 + 1]! + (toPos[i * 2 + 1]! - fromPos[i * 2 + 1]!) * t;
      if (t >= 1) tStart[i] = NOT_MOVING;
      else stillMoving++;
    }
    this.moving = stillMoving;
    this.posVersion++;
    return stillMoving > 0;
  }

  /** Akıcı hareket kapatılınca: herkes hedef konumuna atlar. */
  snapToTargets(): void {
    this.pos.set(this.toPos.subarray(0, this.n * 2));
    this.fromPos.set(this.toPos.subarray(0, this.n * 2));
    this.tStart.fill(NOT_MOVING, 0, this.n);
    this.moving = 0;
    this.posVersion++;
  }

  coordOf(id: string): [number, number] | undefined {
    const i = this.indexOf.get(id);
    return i === undefined ? undefined : [this.pos[i * 2]!, this.pos[i * 2 + 1]!];
  }

  private append(id: string): number {
    if (this.n === this.capacity) this.grow(this.capacity * 2);
    const i = this.n++;
    this.indexOf.set(id, i);
    this.ids[i] = id;
    this.icons[i] = undefined;
    this.tStart[i] = NOT_MOVING;
    this.size[i] = 0;
    this.color[i * 4 + 3] = 255;
    this.lengthVersion++;
    return i;
  }

  private grow(capacity: number): void {
    const f64 = (src: Float64Array, len: number) => {
      const next = new Float64Array(len);
      next.set(src.subarray(0, Math.min(src.length, len)));
      return next;
    };
    this.pos = f64(this.pos, capacity * 2);
    this.fromPos = f64(this.fromPos, capacity * 2);
    this.toPos = f64(this.toPos, capacity * 2);
    this.tStart = f64(this.tStart, capacity);
    const size = new Float32Array(capacity);
    size.set(this.size.subarray(0, Math.min(this.size.length, capacity)));
    this.size = size;
    const color = new Uint8Array(capacity * 4);
    color.set(this.color.subarray(0, Math.min(this.color.length, capacity * 4)));
    this.color = color;
    this.capacity = capacity;
  }
}
