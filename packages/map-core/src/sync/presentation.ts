// ── Sunum aşaması (kümeleme için genişleme noktası) ──────────────
// Tasarım: plan/design/04-sync-and-rendering.md#sunum-aşaması-kümeleme-için-genişleme-noktası
//
//   MapStore → MapSync → RenderBatch → [sunum aşamaları] → adapter.applyBatch()
//
// Varsayılan olarak aşama yoktur (batch aynen geçer). Kümeleme / LOD sonradan aşama olarak takılır.
// Kurallar: sentetik unsurların id'si `cluster:` önekli olur ve store'a YAZILMAZ; seçim ve
// feature-state gerçek id'ler üzerinden kalır.

import type { CameraView } from "../model/camera";
import type { MapStore } from "../store/map-store";
import type { RenderBatch } from "../adapter/types";

export type PresentationContext = {
  /** Okuma amaçlı (aşamalar store'a yazmaz). */
  readonly store: MapStore;
  /** Son bilinen kamera; henüz bilinmiyorsa `null`. */
  readonly view: CameraView | null;
};

export interface PresentationStage {
  id: string;
  /** Batch'i dönüştürür: unsurları gizleyebilir, yerlerine sentetik unsur (küme) koyabilir. */
  process(batch: RenderBatch, context: PresentationContext): RenderBatch;
  /** Kamera değişince ek bir batch gerekiyorsa döner (ör. zoom eşiği geçildi → kümeler yeniden). */
  onViewChange?(view: CameraView, context: PresentationContext): RenderBatch | null;
  /**
   * Aşama kaldırılırken (`MapSync.setStages`): ürettiği sentetik unsurları silen batch'i döner ve iç
   * durumunu sıfırlar. Gerçek unsurları geri getirmek gerekmez: MapSync aşama değişince görünen her
   * şeyi tüm bitlerle yeniden gönderir.
   */
  onRemove?(context: PresentationContext): RenderBatch | null;
}

/** Aşamaları sırayla uygular. */
export function runStages(
  stages: readonly PresentationStage[],
  batch: RenderBatch,
  context: PresentationContext,
): RenderBatch {
  return stages.reduce((current, stage) => stage.process(current, context), batch);
}
