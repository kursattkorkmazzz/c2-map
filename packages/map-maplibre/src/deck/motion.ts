// ── Akıcı hareket modu ───────────────────────────────────────────
// Tasarım: plan/design/04-sync-and-rendering.md#akıcı-hareket
//
// OFF : birlikler mesaj geldikçe yeni konuma atlar (harita ~uygulama Hz'inde çizilir).
// ON  : iki mesaj arası her karede ara konum (görüntü bir mesaj aralığı geriden gelir).
// AUTO: sayfanın kare hızına göre açılır / kapanır.
//
// AUTO neden SAYFA kare hızına bakar (harita çizim hızına değil): hareket kapalıyken harita zaten
// saniyede ~10 kez çizilir; o ölçüye bakan bir karar hareketi bir daha hiç açmazdı. Sayfa kare hızı
// cihazın gerçek kapasitesini gösterir. Açılıp kapanma döngüsünü önlemek için histerezis (iki eşik)
// + minimum bekleme vardır ve her yön değiştirmede bekleme ikiye katlanır (üst sınırlı).

export const MOTION_MODE = {
  OFF: 'off',
  ON: 'on',
  AUTO: 'auto',
} as const;
export type MotionMode = (typeof MOTION_MODE)[keyof typeof MOTION_MODE];

export type MotionAutoOptions = {
  /** Bu kare hızının altında `holdMs` boyunca kalınırsa hareket kapanır. Varsayılan 25. */
  lowFps?: number;
  /** Bu kare hızının üstünde bekleme süresince kalınırsa hareket açılır. Varsayılan 50. */
  highFps?: number;
  /** İlk bekleme süresi (ms). Her yön değiştirmede ikiye katlanır. Varsayılan 3000. */
  holdMs?: number;
  /** Bekleme süresinin üst sınırı (ms). Varsayılan 60000. */
  maxHoldMs?: number;
};

/** AUTO kararı (saf): ölçülen kare hızını alır, hareketin açık olup olmayacağını söyler. */
export class MotionGovernor {
  private active = true;
  private since: number | null = null; // eşik dışına çıkılan an
  private hold: number;
  private readonly low: number;
  private readonly high: number;
  private readonly maxHold: number;

  constructor(options: MotionAutoOptions = {}) {
    this.low = options.lowFps ?? 25;
    this.high = options.highFps ?? 50;
    this.hold = options.holdMs ?? 3000;
    this.maxHold = options.maxHoldMs ?? 60_000;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Bir kare hızı ölçümü (ör. saniyede bir). Karar değiştiyse `true`. */
  sample(fps: number, now: number): boolean {
    const outside = this.active ? fps < this.low : fps > this.high;
    if (!outside) {
      this.since = null;
      return false;
    }
    if (this.since === null) this.since = now;
    if (now - this.since < this.hold) return false;

    this.active = !this.active;
    this.since = null;
    this.hold = Math.min(this.hold * 2, this.maxHold); // döngüye karşı geri çekilme
    return true;
  }
}
