// Saniyelik ölçümler. Her saniye sonunda `snapshot` güncellenir.

export type StatsSnapshot = {
  fps: number; // tarayıcının kare döngüsü (sayfa ne kadar akıcı)
  mapRendersPerSec: number; // haritanın gerçekten yeniden çizildiği kare sayısı
  worstFrameMs: number; // son saniyedeki en uzun kare (takılma göstergesi)
  msgsPerSec: number;
  flushesPerSec: number;
  sentPerSec: number; // haritaya gönderilen unsur sayısı / sn
  mapWorkMsPerSec: number; // ana thread'de harita besleme işine harcanan toplam süre / sn
  maxFlushMs: number;
  longTasks: number; // >50 ms süren ana thread işleri (yalnız Chromium)
};

export class Stats {
  snapshot: StatsSnapshot = {
    fps: 0,
    mapRendersPerSec: 0,
    worstFrameMs: 0,
    msgsPerSec: 0,
    flushesPerSec: 0,
    sentPerSec: 0,
    mapWorkMsPerSec: 0,
    maxFlushMs: 0,
    longTasks: 0,
  };

  private windowStart = performance.now();
  private lastFrame = performance.now();
  private frames = 0;
  private mapRenders = 0;
  private worstFrame = 0;
  private msgs = 0;
  private flushes = 0;
  private sent = 0;
  private workMs = 0;
  private maxFlush = 0;
  private longTasks = 0;

  constructor() {
    try {
      new PerformanceObserver((list) => {
        this.longTasks += list.getEntries().length;
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      // longtask desteklenmiyor (Firefox/Safari)
    }
  }

  mapRendered(): void {
    this.mapRenders++;
  }

  messages(n: number): void {
    this.msgs += n;
  }

  /** Haritaya veri gönderme işinin süresini kaydet. */
  work(ms: number, sentFeatures: number, isFlush: boolean): void {
    this.workMs += ms;
    this.sent += sentFeatures;
    if (isFlush) {
      this.flushes++;
      if (ms > this.maxFlush) this.maxFlush = ms;
    }
  }

  /** Her rAF karesinde çağrılır. Saniye dolduysa true döner. */
  frame(now: number): boolean {
    this.frames++;
    const frameMs = now - this.lastFrame;
    this.lastFrame = now;
    if (frameMs > this.worstFrame) this.worstFrame = frameMs;

    const elapsed = now - this.windowStart;
    if (elapsed < 1000) return false;

    const k = 1000 / elapsed;
    this.snapshot = {
      fps: this.frames * k,
      mapRendersPerSec: this.mapRenders * k,
      worstFrameMs: this.worstFrame,
      msgsPerSec: this.msgs * k,
      flushesPerSec: this.flushes * k,
      sentPerSec: this.sent * k,
      mapWorkMsPerSec: this.workMs * k,
      maxFlushMs: this.maxFlush,
      longTasks: this.longTasks,
    };
    this.windowStart = now;
    this.frames = this.mapRenders = this.msgs = this.flushes = this.sent = this.workMs = this.maxFlush = this.worstFrame = 0;
    this.longTasks = 0;
    return true;
  }
}
