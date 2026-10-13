// ── Bildirimsel yazıcı ───────────────────────────────────────────
// Tasarım: plan/design/07-react-api.md#deklaratif-bileşenler
//
// <MapLayer>, <MapFeature>, <MapBasemap> store'a doğrudan değil buraya yazar. Aynı commit'teki
// tüm yazmalar bir mikro görevde TEK transaction olur:
//   - 100 bildirimsel unsur = 1 transaction = MapSync'e 1 bildirim
//   - React çocukların effect'ini ebeveynden önce çalıştırır; sıra önemli olmasın diye işlemler
//     geliş sırasıyla, tek seferde uygulanır (store yetim katmanı kabul eder, ebeveyn aynı
//     transaction'da gelir)
//   - StrictMode'daki ekle → sil → ekle aynı transaction'da son hâline iner

import type { MapStore, MapTx } from '@c2/map-core';

export type WriteOp = (tx: MapTx) => void;

export class DeclarativeWriter {
  private ops: WriteOp[] = [];
  private scheduled = false;

  constructor(
    private readonly store: MapStore,
    private readonly reportError: (error: unknown) => void = (error) =>
      queueMicrotask(() => {
        throw error;
      }),
  ) {}

  enqueue(op: WriteOp): void {
    this.ops.push(op);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  /** Bekleyen yazmaları şimdi uygular. */
  flush(): void {
    this.scheduled = false;
    const ops = this.ops;
    if (ops.length === 0) return;
    this.ops = [];
    this.store.transaction((tx) => {
      for (const op of ops) {
        // Bir işlemin hatası (ör. katman döngüsü) diğerlerini engellemez.
        try {
          op(tx);
        } catch (error) {
          this.reportError(error);
        }
      }
    });
  }
}
