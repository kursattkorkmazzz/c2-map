// ── MapStore ─────────────────────────────────────────────────────
// Tasarım: plan/design/03-store.md
//
// Tek doğruluk kaynağı: katmanlar, altlıklar, unsurlar, seçim, hover.
// Tüm yazmalar `transaction(tx => …)` içinden yapılır; her yazma değişiklik günlüğüne
// (ChangeJournal) düşer ve MapSync bunu `drainChanges()` ile alır.
//
// Durum: 0.2.4 (iç yapılar + okuma) ve 0.2.5 (transaction + unsur işlemleri) hazır.
// Katman (0.2.6), altlık (0.2.7), snapshot (0.2.8), seçim/hover (0.2.9) ve abonelik (0.2.10)
// işlemleri sonraki adımlarda bu dosyaya eklenecek.

import type { Basemap } from "../model/basemap";
import type { Feature } from "../model/feature";
import type { Layer } from "../model/layer";
import { CHANGE_OP, type ChangeSet } from "./change";
import { ChangeJournal, ENTITY_KIND } from "./change-journal";
import { diffFeature, mergeFeaturePatch, type FeaturePatch } from "./diff";

// ── Genel API ────────────────────────────────────────────────────

export type MapStoreOptions = {
  /** Saat kaynağı (ms). Testte enjekte edilir. Varsayılan: `performance.now` / `Date.now`. */
  now?: () => number;
};

export type MapStoreStats = {
  /** `rev`'i eski veya eşit olduğu için düşürülen yazmalar. */
  readonly droppedStale: number;
  /** Store'da olmayan id'ye gelen (yok sayılan) patch'ler. */
  readonly ignoredPatches: number;
};

/** Transaction içinde kullanılabilen yazma işlemleri. Transaction dışında çağrılırsa hata fırlatır. */
export interface MapTx {
  /** Tam nesne: yoksa ekler, varsa değiştirir. Değişiklik yoksa hiçbir şey yapmaz. */
  upsertFeatures(features: readonly Feature[]): void;
  /** Kısmi güncelleme. Store'da olmayan id yok sayılır (patch ekleme yapamaz). */
  patchFeatures(patches: readonly FeaturePatch[]): void;
  /** Siler; seçimden ve hover'dan da düşürür. Olmayan id sessizce yok sayılır. */
  removeFeatures(ids: readonly string[]): void;
}

export interface MapStore {
  // okuma
  getFeature(id: string): Feature | undefined;
  getLayer(id: string): Layer | undefined;
  getBasemap(id: string): Basemap | undefined;
  /** Kardeş katman sırası. Kök için `null`. Değişince yeni dizi referansı. */
  getChildLayerIds(parentId: string | null): readonly string[];
  /**
   * Katmanın doğrudan unsurları. Kopyalanmadan döner (50k unsurlu katmana her eklemede kopya
   * O(n²) olurdu): içerik yerinde değişir, referans sabit **değildir** (katman boşalınca küme
   * silinir). Referansı saklamayın; değişimi `subscribeLayerContents` (0.2.10) ile dinleyip
   * yeniden okuyun.
   */
  getFeatureIds(layerId: string): ReadonlySet<string>;
  /** `order`'a göre sıralı altlıklar. */
  getBasemaps(): readonly Basemap[];
  /** Seçili unsurlar. Değişince yeni küme referansı. */
  getSelection(): ReadonlySet<string>;
  getHovered(): string | null;
  /** Unsurun son yazılma zamanı (bayatlık hesabı için). */
  getUpdatedAt(featureId: string): number | undefined;
  readonly stats: MapStoreStats;

  // yazma
  /** İç içe çağrı dıştakine katılır. `fn` hata fırlatırsa o ana kadarki yazmalar kalır (geri alma yok). */
  transaction(fn: (tx: MapTx) => void): void;

  // MapSync için
  /** Son çağrıdan beri biriken değişiklikleri döner ve günlüğü sıfırlar. */
  drainChanges(): ChangeSet;
}

export function createMapStore(options: MapStoreOptions = {}): MapStore {
  return new MapStoreImpl(options);
}

// ── Uygulama ─────────────────────────────────────────────────────

const EMPTY_IDS: readonly string[] = Object.freeze([]);
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_BASEMAPS: readonly Basemap[] = Object.freeze([]);

const defaultNow = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

class MapStoreImpl implements MapStore {
  // Varlıklar (değişmez nesneler; değişince Map'teki kayıt yeni nesneyle değiştirilir)
  private readonly features = new Map<string, Feature>();
  private readonly layers = new Map<string, Layer>();
  private readonly basemaps = new Map<string, Basemap>();

  // İndeksler
  private readonly childLayerIds = new Map<string | null, readonly string[]>();
  private readonly featureIdsByLayer = new Map<string, Set<string>>();

  // Etkileşim durumu
  private selection: ReadonlySet<string> = EMPTY_SET;
  private hovered: string | null = null;

  // Unsur başına yardımcı kayıtlar
  private readonly updatedAt = new Map<string, number>();
  /**
   * Son kabul edilen `rev`. Nesneden ayrı tutulur: içerik aynı ama `rev` yeni bir mesaj
   * geldiğinde nesne referansını değiştirmeden (bildirim üretmeden) `rev` ilerleyebilsin.
   */
  private readonly revs = new Map<string, number>();

  private readonly journal = new ChangeJournal();
  private readonly now: () => number;
  private readonly mutableStats = { droppedStale: 0, ignoredPatches: 0 };

  /** Açık transaction derinliği (iç içe çağrılar için). */
  private depth = 0;
  private readonly tx: MapTx;

  constructor(options: MapStoreOptions) {
    this.now = options.now ?? defaultNow;
    this.tx = {
      upsertFeatures: (features) => this.guard(() => this.upsertFeatures(features)),
      patchFeatures: (patches) => this.guard(() => this.patchFeatures(patches)),
      removeFeatures: (ids) => this.guard(() => this.removeFeatures(ids)),
    };
  }

  // ── Okuma ──────────────────────────────────────────────────────

  getFeature(id: string): Feature | undefined {
    return this.features.get(id);
  }

  getLayer(id: string): Layer | undefined {
    return this.layers.get(id);
  }

  getBasemap(id: string): Basemap | undefined {
    return this.basemaps.get(id);
  }

  getChildLayerIds(parentId: string | null): readonly string[] {
    return this.childLayerIds.get(parentId) ?? EMPTY_IDS;
  }

  getFeatureIds(layerId: string): ReadonlySet<string> {
    return this.featureIdsByLayer.get(layerId) ?? EMPTY_SET;
  }

  getBasemaps(): readonly Basemap[] {
    // 0.2.7'de sıralı ve önbellekli hale gelecek.
    return this.basemaps.size === 0 ? EMPTY_BASEMAPS : [...this.basemaps.values()];
  }

  getSelection(): ReadonlySet<string> {
    return this.selection;
  }

  getHovered(): string | null {
    return this.hovered;
  }

  getUpdatedAt(featureId: string): number | undefined {
    return this.updatedAt.get(featureId);
  }

  get stats(): MapStoreStats {
    return { ...this.mutableStats };
  }

  // ── Transaction ────────────────────────────────────────────────

  transaction(fn: (tx: MapTx) => void): void {
    this.depth++;
    try {
      fn(this.tx);
    } finally {
      this.depth--;
      if (this.depth === 0) this.commit();
    }
  }

  drainChanges(): ChangeSet {
    return this.journal.drain();
  }

  /** En dıştaki transaction bitti. 0.2.10'da abonelere bildirim burada gönderilecek. */
  private commit(): void {}

  /** `tx` referansı transaction dışına kaçırılıp kullanılırsa hata. */
  private guard(fn: () => void): void {
    if (this.depth === 0) {
      throw new Error("MapTx yalnız store.transaction(...) içinde kullanılabilir.");
    }
    fn();
  }

  // ── Unsur işlemleri ────────────────────────────────────────────

  private upsertFeatures(features: readonly Feature[]): void {
    for (const next of features) {
      const prev = this.features.get(next.id);
      if (!prev) {
        this.addFeature(next);
        continue;
      }
      if (this.isStale(next.id, next.rev)) continue;
      this.replaceFeature(prev, next, next.rev);
    }
  }

  private patchFeatures(patches: readonly FeaturePatch[]): void {
    for (const patch of patches) {
      const prev = this.features.get(patch.id);
      if (!prev) {
        this.mutableStats.ignoredPatches++;
        continue;
      }
      if (this.isStale(patch.id, patch.rev)) continue;
      this.replaceFeature(prev, mergeFeaturePatch(prev, patch), patch.rev);
    }
  }

  private removeFeatures(ids: readonly string[]): void {
    for (const id of ids) {
      const prev = this.features.get(id);
      if (!prev) continue;

      this.features.delete(id);
      this.unindexFeature(prev.layerId, id);
      this.updatedAt.delete(id);
      this.revs.delete(id);

      if (this.selection.has(id)) {
        const next = new Set(this.selection);
        next.delete(id);
        this.selection = next;
        this.journal.flipSelection(id);
      }
      if (this.hovered === id) {
        this.hovered = null;
        this.journal.recordHover(id, null);
      }

      this.journal.record(ENTITY_KIND.FEATURE, id, CHANGE_OP.REMOVE);
    }
  }

  private addFeature(feature: Feature): void {
    this.features.set(feature.id, feature);
    this.indexFeature(feature.layerId, feature.id);
    this.touch(feature.id, feature.rev);
    this.journal.record(ENTITY_KIND.FEATURE, feature.id, CHANGE_OP.ADD);
  }

  /** Var olan unsuru yenisiyle değiştirir; değişiklik yoksa yalnız zaman ve `rev` ilerler. */
  private replaceFeature(prev: Feature, next: Feature, rev: number | undefined): void {
    // Aynı içerikteki mesaj da unsurun "taze" olduğunu gösterir (bayatlık için).
    this.touch(next.id, rev);

    const mask = diffFeature(prev, next);
    if (mask === 0) return; // eski referans kalır → React yeniden çizmez, harita güncellenmez

    if (prev.layerId !== next.layerId) {
      this.unindexFeature(prev.layerId, next.id);
      this.indexFeature(next.layerId, next.id);
    }
    this.features.set(next.id, next);
    this.journal.record(ENTITY_KIND.FEATURE, next.id, CHANGE_OP.UPDATE, mask);
  }

  /** Gelen `rev` mevcut olandan eski veya eşitse true (ve sayaç artar). */
  private isStale(id: string, incoming: number | undefined): boolean {
    if (incoming === undefined) return false;
    const current = this.revs.get(id);
    if (current === undefined || incoming > current) return false;
    this.mutableStats.droppedStale++;
    return true;
  }

  private touch(id: string, rev: number | undefined): void {
    this.updatedAt.set(id, this.now());
    if (rev !== undefined) this.revs.set(id, rev);
  }

  // Yetim unsur (katmanı henüz yok) de indekslenir: katman sonradan gelince unsurları hazırdır.
  private indexFeature(layerId: string, id: string): void {
    let ids = this.featureIdsByLayer.get(layerId);
    if (!ids) {
      ids = new Set();
      this.featureIdsByLayer.set(layerId, ids);
    }
    ids.add(id);
  }

  private unindexFeature(layerId: string, id: string): void {
    const ids = this.featureIdsByLayer.get(layerId);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.featureIdsByLayer.delete(layerId);
  }
}
