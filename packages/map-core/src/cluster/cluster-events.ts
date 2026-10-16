// ── Küme tıklaması → CLUSTER_CLICK ───────────────────────────────
// Adapter hit-test'te kümeyi bulur ve sıradan bir CLICK basar (featureId = `cluster:…`). Router
// sentetik id'yi katman zincirine kabartmaz; burada global CLICK dinlenip içerik eklenerek
// `CLUSTER_CLICK` olarak yeniden yayılır (data: `ClusterInfo` — üye id'leri, sınır kutusu).

import { isSyntheticId, MAP_EVENT, type EventRouter } from "../events/event-router";
import type { ClusterInfo } from "./cluster-stage";

export type ClusterSource = { getCluster(id: string): ClusterInfo | null };

/** Küme tıklamalarını `CLUSTER_CLICK` olayına çevirir; aboneliği bırakan fonksiyon döner. */
export function bindClusterEvents(router: EventRouter, source: ClusterSource): () => void {
  return router.on(MAP_EVENT.CLICK, (e) => {
    if (!e.featureId || !isSyntheticId(e.featureId)) return;
    const info = source.getCluster(e.featureId);
    if (!info) return;
    router.emit({
      type: MAP_EVENT.CLUSTER_CLICK,
      featureId: e.featureId,
      ...(e.coord ? { coord: e.coord } : {}),
      ...(e.screen ? { screen: e.screen } : {}),
      ...(e.modifiers ? { modifiers: e.modifiers } : {}),
      data: info,
      originalEvent: e.originalEvent,
    });
  });
}

/** Sunum aşaması küme içeriği verebiliyor mu (ör. `ClusterStage`)? */
export function isClusterSource(value: unknown): value is ClusterSource {
  return typeof (value as Partial<ClusterSource> | null)?.getCluster === "function";
}
