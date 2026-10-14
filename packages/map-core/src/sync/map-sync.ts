// ── MapSync ──────────────────────────────────────────────────────
// Tasarım: plan/design/04-sync-and-rendering.md#mapsyncin-görevleri
//
// Store ile adapter arasındaki köprü; motor bilmez. Store "değişiklik var" deyince bir sonraki
// kareye TEK flush planlar; flush'ta günlüğü alır, efektif görünürlük/opaklık/sıra/grup hesaplar,
// adapter'ın şu an gösterdiğiyle karşılaştırıp yalnız farkı (RenderBatch) gönderir.
//
// Adapter'ın ekranında ne olduğu `rendered` haritasında tutulur: görünmez hale gelen unsur için
// REMOVE, yeniden görünen için tüm bitlerle upsert üretilir.

import type { CameraView } from "../model/camera";
import type { Basemap } from "../model/basemap";
import { CHANGE_OP, FEATURE_CHANGE_VISUAL, LAYER_CHANGE, type ChangeSet } from "../store/change";
import type { MapStore } from "../store/map-store";
import {
  isEmptyBatch,
  RENDER_CHANGE,
  RENDER_CHANGE_ALL,
  type FeatureStatePatch,
  type FeatureVisualState,
  type MapAdapter,
  type RenderBatch,
  type RenderFeature,
  type RenderGroup,
} from "../adapter/types";
import { LayerResolver } from "./layer-resolver";
import { runStages, type PresentationContext, type PresentationStage } from "./presentation";
import { createFrameScheduler, type Scheduler } from "./scheduler";

/** zIndex = katman sırası × Z_LAYER_STRIDE + feature.z. `feature.z` bu aralıkta kalmalı. */
export const Z_LAYER_STRIDE = 10_000;

/** Bu bitlerden biri değişen katmanın alt ağacındaki unsurlar yeniden değerlendirilir. */
const LAYER_RENDER_BITS =
  LAYER_CHANGE.VISIBLE | LAYER_CHANGE.OPACITY | LAYER_CHANGE.ZOOM | LAYER_CHANGE.RENDER_GROUP | LAYER_CHANGE.PARENT;

export type MapSyncOptions = {
  store: MapStore;
  adapter: Pick<MapAdapter, "applyBatch">;
  /** Varsayılan: `createFrameScheduler()` (rAF + en fazla 10 Hz). */
  scheduler?: Scheduler;
  /** Sunum aşamaları (varsayılan: yok). */
  stages?: readonly PresentationStage[];
};

type RenderedEntry = { groupId: string; opacity: number; zIndex: number };

export class MapSync {
  private readonly store: MapStore;
  private readonly adapter: Pick<MapAdapter, "applyBatch">;
  private readonly scheduler: Scheduler;
  private readonly resolver: LayerResolver;
  private stages: readonly PresentationStage[];

  /** Adapter'ın şu an gösterdiği unsurlar ve efektif değerleri. */
  private readonly rendered = new Map<string, RenderedEntry>();
  private renderedGroups = new Map<string, RenderGroup>();
  private view: CameraView | null = null;

  private running = false;
  private unsubscribe: (() => void) | null = null;
  private cancelScheduled: (() => void) | null = null;
  /** Sonraki flush'ta her şeyi yeniden değerlendir (zoom eşiği geçildi). */
  private fullPending = false;
  /** Sonraki flush'ta görünen her unsuru tüm bitlerle yeniden gönder (sunum aşaması değişti). */
  private resendAll = false;

  constructor(options: MapSyncOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.scheduler = options.scheduler ?? createFrameScheduler();
    this.resolver = new LayerResolver(options.store);
    this.stages = options.stages ?? [];
  }

  /** İlk tam senkronu yapar ve store değişikliklerini dinlemeye başlar. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.store.drainChanges(); // biriken günlük önemsiz: tam senkron her şeyi kapsar
    this.fullPending = true;
    this.flush();
    this.unsubscribe = this.store.subscribeChanges(() => this.requestFlush());
  }

  stop(): void {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
  }

  /** Sunum aşamalarını değiştirir (ör. kümelemeyi aç/kapat); tam yeniden değerlendirme planlar. */
  setStages(stages: readonly PresentationStage[]): void {
    this.stages = stages;
    this.fullPending = true;
    // Aşama değişince adapter'daki görüntü güvenilmez: görünen her şey tüm bitlerle yeniden gider.
    // (`rendered` temizlenmez; temizlense artık görünmeyen unsurlar için REMOVE üretilemezdi.)
    this.resendAll = true;
    this.requestFlush();
  }

  /**
   * Kamera değişti (adapter'ın VIEW_CHANGE olayından). Bir katmanın zoom eşiği geçildiyse
   * unsurlar yeniden değerlendirilir; sunum aşamalarına da haber verilir.
   */
  setView(view: CameraView): void {
    this.view = view;
    if (this.resolver.setZoom(view.zoom ?? null)) {
      this.fullPending = true;
      this.requestFlush();
    }
    const context = this.context();
    for (const stage of this.stages) {
      const batch = stage.onViewChange?.(view, context);
      if (batch && !isEmptyBatch(batch)) this.adapter.applyBatch(batch);
    }
  }

  /** Bekleyen değişiklikleri şimdi uygular (zamanlayıcıyı beklemeden). */
  flush(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;

    const changes = this.store.drainChanges();
    const full = this.fullPending || changes.structure;
    this.fullPending = false;

    const batch = this.buildBatch(changes, full);
    this.resendAll = false;
    const output = runStages(this.stages, batch, this.context());
    if (!isEmptyBatch(output)) this.adapter.applyBatch(output);
  }

  // ── Batch üretimi ──────────────────────────────────────────────

  private buildBatch(changes: ChangeSet, full: boolean): RenderBatch {
    const changedLayers = [...changes.layers].filter(
      ([, change]) => change.op !== CHANGE_OP.UPDATE || (change.mask & LAYER_RENDER_BITS) !== 0,
    );
    if (full || changedLayers.length > 0) this.resolver.invalidate();

    // Değerlendirilecek unsurlar → kendi değişiklik maskeleri (0 = yalnız efektif değerler).
    const toEvaluate = new Map<string, number>();
    for (const [id, change] of changes.features) toEvaluate.set(id, change.mask);

    if (full) {
      this.resolver.forEachReachable((layer) => {
        for (const id of this.store.getFeatureIds(layer.id)) if (!toEvaluate.has(id)) toEvaluate.set(id, 0);
      });
      // Artık ulaşılamayan (ör. katmanı yetim kalan) ama ekranda olanlar da değerlendirilsin.
      for (const id of this.rendered.keys()) if (!toEvaluate.has(id)) toEvaluate.set(id, 0);
    } else {
      for (const [layerId] of changedLayers) {
        for (const subId of this.resolver.subtree(layerId)) {
          for (const id of this.store.getFeatureIds(subId)) if (!toEvaluate.has(id)) toEvaluate.set(id, 0);
        }
      }
    }

    const upsert: RenderFeature[] = [];
    const remove: string[] = [];
    const state = new Map<string, Partial<FeatureVisualState>>();
    for (const [id, mask] of toEvaluate) this.evaluate(id, mask, upsert, remove, state);

    this.collectStatePatches(changes, state);

    const batch: RenderBatch = {};
    if (full || changedLayers.length > 0) {
      const groups = this.diffGroups();
      if (groups) batch.groups = groups;
    }
    const basemaps = full ? this.allBasemaps() : this.diffBasemaps(changes);
    if (basemaps) batch.basemaps = basemaps;
    if (upsert.length > 0 || remove.length > 0) batch.features = { upsert, remove };
    if (state.size > 0) batch.state = [...state].map(([id, s]): FeatureStatePatch => ({ id, state: s }));
    return batch;
  }

  /** Tek unsuru değerlendirir: göster / güncelle / kaldır / dokunma. */
  private evaluate(
    id: string,
    ownMask: number,
    upsert: RenderFeature[],
    remove: string[],
    state: Map<string, Partial<FeatureVisualState>>,
  ): void {
    const feature = this.store.getEffectiveFeature(id); // düzenleniyorsa taslak
    const prev = this.rendered.get(id);
    const layer = feature && !feature.hidden ? this.resolver.get(feature.layerId) : null;

    if (!feature || !layer || !layer.visible) {
      if (prev) {
        this.rendered.delete(id);
        remove.push(id);
      }
      return;
    }

    const next: RenderedEntry = {
      groupId: layer.groupId,
      opacity: layer.opacity,
      zIndex: layer.order * Z_LAYER_STRIDE + (feature.z ?? 0),
    };

    let changed: number;
    if (!prev || this.resendAll) {
      changed = RENDER_CHANGE_ALL;
      // Yeniden görünen unsurun görsel durumu da gönderilir (adapter onu yeni ekliyor olabilir).
      if (this.store.getSelection().has(id)) mergeState(state, id, { selected: true });
      if (this.store.getHovered() === id) mergeState(state, id, { hovered: true });
    } else {
      changed = ownMask & FEATURE_CHANGE_VISUAL; // yalnız META değiştiyse 0 → gönderilmez
      if (prev.opacity !== next.opacity) changed |= RENDER_CHANGE.OPACITY;
      if (prev.zIndex !== next.zIndex) changed |= RENDER_CHANGE.Z_INDEX;
      if (prev.groupId !== next.groupId) changed |= RENDER_CHANGE.GROUP;
      if (changed === 0) return;
    }

    this.rendered.set(id, next);
    upsert.push({ feature, ...next, changed });
  }

  private collectStatePatches(changes: ChangeSet, state: Map<string, Partial<FeatureVisualState>>): void {
    const selection = this.store.getSelection();
    for (const id of changes.selection) mergeState(state, id, { selected: selection.has(id) });
    if (changes.hover) {
      if (changes.hover.prev !== null) mergeState(state, changes.hover.prev, { hovered: false });
      if (changes.hover.next !== null) mergeState(state, changes.hover.next, { hovered: true });
    }
  }

  private diffGroups(): RenderBatch["groups"] | null {
    const next = new Map(this.resolver.groups().map((g) => [g.id, g]));
    const upsert = [...next.values()].filter((g) => {
      const prev = this.renderedGroups.get(g.id);
      return !prev || prev.order !== g.order;
    });
    const remove = [...this.renderedGroups.keys()].filter((id) => !next.has(id));
    this.renderedGroups = next;
    return upsert.length > 0 || remove.length > 0 ? { upsert, remove } : null;
  }

  private allBasemaps(): RenderBatch["basemaps"] | null {
    const all = this.store.getBasemaps();
    return all.length > 0 ? { upsert: all, remove: [] } : null;
  }

  private diffBasemaps(changes: ChangeSet): RenderBatch["basemaps"] | null {
    if (changes.basemaps.size === 0) return null;
    const upsert: Basemap[] = [];
    const remove: string[] = [];
    for (const [id, change] of changes.basemaps) {
      const basemap = this.store.getBasemap(id);
      if (change.op === CHANGE_OP.REMOVE || !basemap) remove.push(id);
      else upsert.push(basemap);
    }
    return { upsert, remove };
  }

  // ── Yardımcılar ────────────────────────────────────────────────

  private requestFlush(): void {
    if (!this.running || this.cancelScheduled) return;
    this.cancelScheduled = this.scheduler.schedule(() => {
      this.cancelScheduled = null;
      this.flush();
    });
  }

  private context(): PresentationContext {
    return { store: this.store, view: this.view };
  }
}

function mergeState(
  state: Map<string, Partial<FeatureVisualState>>,
  id: string,
  patch: Partial<FeatureVisualState>,
): void {
  state.set(id, { ...state.get(id), ...patch });
}
