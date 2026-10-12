// ── Katman çözümleyici ───────────────────────────────────────────
// Bir katmanın "efektif" değerlerini hesaplar ve önbellekler:
//   görünürlük = kendisi && tüm ataları görünür && zoom ∈ [minZoom, maxZoom)
//   opaklık    = kendisi × ataları
//   grup       = en yakın `renderGroup: true` ata (kendisi dahil); yoksa kökün doğrudan çocuğu
//   sıra       = katman ağacının derinlik-öncelikli (pre-order) sırası
// Kökten ulaşılamayan katman (yetim zincir) çözülemez → altındaki unsurlar görünmez.

import type { Layer } from "../model/layer";
import type { MapStore } from "../store/map-store";
import type { RenderGroup } from "../adapter/types";

export type LayerInfo = {
  visible: boolean;
  opacity: number;
  groupId: string;
  order: number;
};

type LayerSource = Pick<MapStore, "getLayer" | "getChildLayerIds">;

export class LayerResolver {
  private readonly cache = new Map<string, LayerInfo | null>();
  private orders: Map<string, number> | null = null;
  private zoom: number | null = null;

  constructor(private readonly store: LayerSource) {}

  /** Tüm önbelleği geçersiz kılar (katman değişikliği veya zoom eşiği). */
  invalidate(): void {
    this.cache.clear();
    this.orders = null;
  }

  /**
   * Zoom'u günceller. Bir katmanın min/max eşiği geçildiyse önbelleği geçersiz kılar ve `true`
   * döner (çağıran unsurları yeniden değerlendirmeli). Eşik geçilmediyse hiçbir şey değişmez.
   */
  setZoom(zoom: number | null): boolean {
    const prev = this.zoom;
    this.zoom = zoom;
    if (prev === zoom) return false;

    let crossed = false;
    this.forEachReachable((layer) => {
      if (crossed) return;
      if (zoomVisible(layer, prev) !== zoomVisible(layer, zoom)) crossed = true;
    });
    if (crossed) this.invalidate();
    return crossed;
  }

  get(layerId: string): LayerInfo | null {
    const cached = this.cache.get(layerId);
    if (cached !== undefined) return cached;

    const info = this.compute(layerId);
    this.cache.set(layerId, info);
    return info;
  }

  /** Kökten ulaşılabilen tüm render group'lar (sıralı). */
  groups(): RenderGroup[] {
    const groups: RenderGroup[] = [];
    this.forEachReachable((layer) => {
      const info = this.get(layer.id);
      if (info && info.groupId === layer.id) groups.push({ id: layer.id, layerId: layer.id, order: info.order });
    });
    return groups;
  }

  /** Kökten derinlik-öncelikli gezinti (sıra hesabıyla aynı düzen). */
  forEachReachable(visit: (layer: Layer) => void): void {
    const walk = (parentId: string | null) => {
      for (const id of this.store.getChildLayerIds(parentId)) {
        const layer = this.store.getLayer(id);
        if (!layer) continue;
        visit(layer);
        walk(id);
      }
    };
    walk(null);
  }

  /** `layerId` ve tüm alt katmanlarının id'leri. */
  subtree(layerId: string): string[] {
    const ids: string[] = [];
    const walk = (id: string) => {
      ids.push(id);
      for (const childId of this.store.getChildLayerIds(id)) walk(childId);
    };
    walk(layerId);
    return ids;
  }

  private compute(layerId: string): LayerInfo | null {
    const layer = this.store.getLayer(layerId);
    const order = this.getOrders().get(layerId);
    if (!layer || order === undefined) return null; // yok veya kökten ulaşılamıyor

    const parent = layer.parentId === null ? null : this.get(layer.parentId);
    if (layer.parentId !== null && !parent) return null;

    const isGroupRoot = layer.renderGroup === true || layer.parentId === null;
    return {
      visible: layer.visible && zoomVisible(layer, this.zoom) && (parent?.visible ?? true),
      opacity: layer.opacity * (parent?.opacity ?? 1),
      groupId: isGroupRoot || !parent ? layer.id : parent.groupId,
      order,
    };
  }

  private getOrders(): Map<string, number> {
    if (!this.orders) {
      const orders = new Map<string, number>();
      this.forEachReachable((layer) => orders.set(layer.id, orders.size));
      this.orders = orders;
    }
    return this.orders;
  }
}

/** MapLibre ile aynı kural: minZoom dahil, maxZoom hariç. Zoom bilinmiyorsa sınır uygulanmaz. */
function zoomVisible(layer: Layer, zoom: number | null): boolean {
  if (zoom === null) return true;
  if (layer.minZoom !== undefined && zoom < layer.minZoom) return false;
  if (layer.maxZoom !== undefined && zoom >= layer.maxZoom) return false;
  return true;
}
