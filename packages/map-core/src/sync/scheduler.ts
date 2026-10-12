// ── Flush zamanlayıcısı ──────────────────────────────────────────
// MapSync "değişiklik var" haberini alınca haritayı hemen güncellemez; bir sonraki kareye ve
// saniyede en fazla `maxApplyHz` kez olacak şekilde TEK flush planlar (spike: batch en büyük kazanç).

export interface Scheduler {
  /** Görevi planlar; iptal fonksiyonu döner. */
  schedule(task: () => void): () => void;
}

export type FrameSchedulerOptions = {
  /** Haritaya saniyede en fazla kaç kez uygulanacağı. Varsayılan 10. */
  maxApplyHz?: number;
  /** Saat kaynağı (test). */
  now?: () => number;
};

const defaultNow = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Tarayıcı zamanlayıcısı: son çalışmadan bu yana `1000 / maxApplyHz` ms geçmesini bekler,
 * sonra bir animasyon karesine (rAF) hizalar. rAF yoksa (Node, Worker) yalnız zamanlayıcı kullanılır.
 */
export function createFrameScheduler(options: FrameSchedulerOptions = {}): Scheduler {
  const minIntervalMs = 1000 / (options.maxApplyHz ?? 10);
  const now = options.now ?? defaultNow;
  const hasRaf = typeof requestAnimationFrame === "function";
  let lastRun = -Infinity;

  return {
    schedule(task) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let frame: number | undefined;
      let cancelled = false;

      const run = () => {
        if (cancelled) return;
        lastRun = now();
        task();
      };

      const wait = Math.max(0, lastRun + minIntervalMs - now());
      timer = setTimeout(() => {
        timer = undefined;
        if (hasRaf) frame = requestAnimationFrame(run);
        else run();
      }, wait);

      return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      };
    },
  };
}

export type ManualScheduler = Scheduler & {
  /** Bekleyen görev var mı? */
  readonly pending: boolean;
  /** Bekleyen görevi şimdi çalıştırır (testte "bir kare geçti"). */
  run(): void;
};

/** Test ve sunucu tarafı için: görev yalnız `run()` çağrılınca çalışır. */
export function createManualScheduler(): ManualScheduler {
  let task: (() => void) | null = null;
  return {
    schedule(next) {
      task = next;
      return () => {
        if (task === next) task = null;
      };
    },
    get pending() {
      return task !== null;
    },
    run() {
      const current = task;
      task = null;
      current?.();
    },
  };
}
