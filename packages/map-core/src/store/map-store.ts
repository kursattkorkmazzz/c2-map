// ── MapStore ─────────────────────────────────────────────────────
// Tasarım: plan/design/03-store.md
//
// Tek doğruluk kaynağı: katmanlar, altlıklar, unsurlar, seçim, hover.
// Tüm yazmalar `transaction(tx => …)` içinden yapılır; her yazma değişiklik günlüğüne
// (ChangeJournal) düşer ve MapSync bunu `drainChanges()` ile alır.
//
// Aboneler (React hook'ları, LayerTree) id bazlı dinler; bildirimler en dıştaki transaction
// bitince, her hedef için bir kez gider (`commit()`).

import type { Basemap } from "../model/basemap";
import type { Feature } from "../model/feature";
import type { Layer } from "../model/layer";
import { BASEMAP_CHANGE, CHANGE_OP, FEATURE_CHANGE, LAYER_CHANGE, type ChangeOp, type ChangeSet } from "./change";
import { ChangeJournal, ENTITY_KIND } from "./change-journal";
import {
  diffBasemap,
  diffFeature,
  diffLayer,
  mergeBasemapPatch,
  mergeFeaturePatch,
  mergeLayerPatch,
  type BasemapPatch,
  type FeaturePatch,
  type LayerPatch,
} from "./diff";
import { stabilizeBasemap, stabilizeFeature, stabilizeLayer } from "./stabilize";

// ── Genel API ────────────────────────────────────────────────────

export type MapStoreOptions = {
  /** Saat kaynağı (ms). Testte enjekte edilir. Varsayılan: `performance.now` / `Date.now`. */
  now?: () => number;
  /**
   * Bir dinleyici hata fırlatırsa çağrılır (diğer dinleyiciler çalışmaya devam eder).
   * Varsayılan: hata transaction'ı bozmadan asenkron olarak raporlanır (`reportError` / mikro görev).
   */
  onListenerError?: (error: unknown) => void;
};

/** Abonelikten çıkma fonksiyonu. */
export type Unsubscribe = () => void;

export type MapStoreStats = {
  /** `rev`'i eski veya eşit olduğu için düşürülen yazmalar. */
  readonly droppedStale: number;
  /** Store'da olmayan id'ye gelen (yok sayılan) patch'ler (unsur, katman, altlık). */
  readonly ignoredPatches: number;
  /** `replaceLayerContents`'te `layerId`'si hedef katmandan farklı olduğu için atlanan unsurlar. */
  readonly rejectedSnapshotItems: number;
};

/** Transaction içinde kullanılabilen yazma işlemleri. Transaction dışında çağrılırsa hata fırlatır. */
export interface MapTx {
  /** Tam nesne: yoksa ekler, varsa değiştirir. Değişiklik yoksa hiçbir şey yapmaz. */
  upsertFeatures(features: readonly Feature[]): void;
  /** Kısmi güncelleme. Store'da olmayan id yok sayılır (patch ekleme yapamaz). */
  patchFeatures(patches: readonly FeaturePatch[]): void;
  /** Siler; seçimden ve hover'dan da düşürür. Olmayan id sessizce yok sayılır. */
  removeFeatures(ids: readonly string[]): void;
  /**
   * Snapshot (ör. yeniden bağlanma): katmanın **doğrudan** unsurlarını listeyle birebir eşitler.
   * Listede olmayan → silinir; olan → upsert (maske hesabıyla). Diğer katmanlara dokunulmaz.
   * Snapshot yetkilidir: `rev` kontrolü yapılmaz ve unsurların `rev` durumu sıfırlanır
   * (sunucu yeniden başlayıp `rev`'i sıfırlamış olabilir). `layerId`'si farklı olan unsur atlanır
   * (`stats.rejectedSnapshotItems`).
   */
  replaceLayerContents(layerId: string, features: readonly Feature[]): void;

  /**
   * Tam nesne: yeni katman ebeveyninin **sonuna** eklenir. Var olan katmanda `parentId`
   * değişirse yeni ebeveynin sonuna taşınır. Döngü oluşturacaksa hata fırlatır.
   */
  upsertLayers(layers: readonly Layer[]): void;
  /** Kısmi güncelleme. Olmayan id yok sayılır. `parentId` verilirse taşıma gibi davranır. */
  patchLayer(id: string, patch: LayerPatch): void;
  /**
   * Katmanı `parentId` altında `index` konumuna taşır (varsayılan: sona). `index` taşımadan
   * SONRAKİ sırayı ifade eder ve [0, kardeş sayısı] aralığına sıkıştırılır.
   * Olmayan katman veya döngü (katmanı kendi altına taşımak) → hata, işlem uygulanmaz.
   */
  moveLayer(id: string, parentId: string | null, index?: number): void;
  /** Katmanı alt ağacıyla (alt katmanlar + tüm unsurları) birlikte siler. */
  removeLayers(ids: readonly string[]): void;

  /**
   * Tam nesne: yoksa ekler, varsa değiştirir. `exclusiveGroup` kuralı: görünür hale gelen
   * altlık, aynı gruptaki diğer görünür altlıkları kapatır (aynı pakette ikisi açıksa sonuncu kazanır).
   */
  upsertBasemaps(basemaps: readonly Basemap[]): void;
  /** Kısmi güncelleme. Olmayan id yok sayılır. `exclusiveGroup` kuralı burada da geçerli. */
  patchBasemap(id: string, patch: BasemapPatch): void;
  /** Siler. Olmayan id sessizce yok sayılır. */
  removeBasemaps(ids: readonly string[]): void;

  /**
   * Seçimi değiştirir (varsayılan `replace`). Store'da olmayan ve seçilemeyen unsurlar
   * (unsurun veya katman zincirinden birinin `selectable === false`) atlanır; çıkarma (`remove`,
   * `toggle` ile kaldırma) her zaman serbesttir.
   */
  select(ids: readonly string[], mode?: SelectMode): void;
  clearSelection(): void;
  /** Fare altındaki unsur. Store'da olmayan id (ör. sentetik küme) yok sayılır. */
  setHovered(id: string | null): void;

  /**
   * Düzenleme taslağı (karar #20). Taslak varken haritada taslak çizilir; asıl kayıt akıştan
   * güncellenmeye devam eder (taslak kaymaz). İlk `setDraft` asıl kaydın o anki hâlini taban
   * (`base`) olarak saklar. Store'da olmayan id yok sayılır.
   */
  setDraft(feature: Feature): void;
  /** Taslağı atar; harita asıl kayda döner. */
  clearDraft(id: string): void;
}

/** Düzenlenen unsurun taslağı. */
export type FeatureDraft = {
  /** Kullanıcının düzenlediği hâl (haritada bu çizilir). */
  readonly feature: Feature;
  /** Düzenleme başladığında asıl kayıt. Asıl kayıt bundan farklıysa "başkası değiştirdi". */
  readonly base: Feature;
};

export const SELECT_MODE = {
  REPLACE: "replace",
  ADD: "add",
  REMOVE: "remove",
  TOGGLE: "toggle",
} as const;
export type SelectMode = (typeof SELECT_MODE)[keyof typeof SELECT_MODE];

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
   * silinir). Referansı saklamayın; değişimi `subscribeLayerContents` ile dinleyip
   * yeniden okuyun.
   */
  getFeatureIds(layerId: string): ReadonlySet<string>;
  /** `order`'a göre artan sıralı altlıklar (eşitlikte ekleme sırası). Değişince yeni dizi referansı. */
  getBasemaps(): readonly Basemap[];
  /** Seçili unsurlar. Değişince yeni küme referansı. */
  getSelection(): ReadonlySet<string>;
  getHovered(): string | null;
  /** Unsurun son yazılma zamanı (bayatlık hesabı için). */
  getUpdatedAt(featureId: string): number | undefined;
  /** Düzenleme taslağı (yoksa `undefined`). Değişimi `subscribeFeature` ile gelir. */
  getDraft(featureId: string): FeatureDraft | undefined;
  /** Haritada görünen hâl: taslak varsa taslak, yoksa asıl kayıt (MapSync bunu çizer). */
  getEffectiveFeature(featureId: string): Feature | undefined;
  readonly stats: MapStoreStats;

  // yazma
  /** İç içe çağrı dıştakine katılır. `fn` hata fırlatırsa o ana kadarki yazmalar kalır (geri alma yok). */
  transaction(fn: (tx: MapTx) => void): void;

  // abonelik — bildirimler en dıştaki transaction bitince, her hedef için bir kez gider
  /** Bu unsur eklendi / değişti / silindi. */
  subscribeFeature(id: string, cb: () => void): Unsubscribe;
  /** Bu katman eklendi / değişti / taşındı / silindi. */
  subscribeLayer(id: string, cb: () => void): Unsubscribe;
  /** Bu altlık eklendi / değişti / silindi. */
  subscribeBasemap(id: string, cb: () => void): Unsubscribe;
  /** Katmanın doğrudan unsur kümesi değişti (eklendi / çıktı). Sayaç, ağaçta unsur listesi için. */
  subscribeLayerContents(layerId: string, cb: () => void): Unsubscribe;
  /** Katman ağacının şekli değişti (ekle / sil / taşı). */
  subscribeStructure(cb: () => void): Unsubscribe;
  /** Altlık listesi değişti (`getBasemaps()` yeni referans). */
  subscribeBasemaps(cb: () => void): Unsubscribe;
  subscribeSelection(cb: () => void): Unsubscribe;
  subscribeHover(cb: () => void): Unsubscribe;
  /** Günlüğe herhangi bir şey yazıldı (MapSync flush planlamak için). */
  subscribeChanges(cb: () => void): Unsubscribe;

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

/** Dinleyici hatasını transaction'ı bozmadan raporla (tarayıcıda konsola düşer). */
const defaultReportError = (error: unknown): void => {
  if (typeof globalThis.reportError === "function") globalThis.reportError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
};

type Listener = () => void;

/** Bir transaction boyunca kimin bildirim alacağının listesi. */
type PendingNotifications = {
  any: boolean;
  features: Set<string>;
  layers: Set<string>;
  basemaps: Set<string>;
  layerContents: Set<string>;
  structure: boolean;
  basemapList: boolean;
  selection: boolean;
  hover: boolean;
};

const emptyPending = (): PendingNotifications => ({
  any: false,
  features: new Set(),
  layers: new Set(),
  basemaps: new Set(),
  layerContents: new Set(),
  structure: false,
  basemapList: false,
  selection: false,
  hover: false,
});

/** Anahtar başına dinleyici kümesi. */
class KeyedListeners {
  private readonly map = new Map<string, Set<Listener>>();

  add(key: string, cb: Listener): Unsubscribe {
    let set = this.map.get(key);
    if (!set) {
      set = new Set();
      this.map.set(key, set);
    }
    set.add(cb);
    return () => {
      const current = this.map.get(key);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this.map.delete(key);
    };
  }

  get(key: string): ReadonlySet<Listener> | undefined {
    return this.map.get(key);
  }
}

const addListener = (set: Set<Listener>, cb: Listener): Unsubscribe => {
  set.add(cb);
  return () => set.delete(cb);
};

class MapStoreImpl implements MapStore {
  // Varlıklar (değişmez nesneler; değişince Map'teki kayıt yeni nesneyle değiştirilir)
  private readonly features = new Map<string, Feature>();
  private readonly layers = new Map<string, Layer>();
  private readonly basemaps = new Map<string, Basemap>();
  /** `getBasemaps()` önbelleği; altlıklarda her değişiklikte `null` yapılır. */
  private sortedBasemaps: readonly Basemap[] | null = null;

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
  private readonly mutableStats = { droppedStale: 0, ignoredPatches: 0, rejectedSnapshotItems: 0 };

  /** En dıştaki transaction'ın başladığı an (tazelik zamanı). */
  private txTime = 0;

  /** Düzenleme taslakları (unsur id → taslak). */
  private readonly drafts = new Map<string, FeatureDraft>();

  /** Açık transaction derinliği (iç içe çağrılar için). */
  private depth = 0;
  private readonly tx: MapTx;

  // Abonelik
  private pending = emptyPending();
  private readonly featureListeners = new KeyedListeners();
  private readonly layerListeners = new KeyedListeners();
  private readonly basemapListeners = new KeyedListeners();
  private readonly layerContentsListeners = new KeyedListeners();
  private readonly structureListeners = new Set<Listener>();
  private readonly basemapListListeners = new Set<Listener>();
  private readonly selectionListeners = new Set<Listener>();
  private readonly hoverListeners = new Set<Listener>();
  private readonly changeListeners = new Set<Listener>();
  private readonly reportListenerError: (error: unknown) => void;

  constructor(options: MapStoreOptions) {
    this.now = options.now ?? defaultNow;
    this.reportListenerError = options.onListenerError ?? defaultReportError;
    this.tx = {
      upsertFeatures: (features) => this.guard(() => this.upsertFeatures(features)),
      patchFeatures: (patches) => this.guard(() => this.patchFeatures(patches)),
      removeFeatures: (ids) => this.guard(() => this.removeFeatures(ids)),
      replaceLayerContents: (layerId, features) =>
        this.guard(() => this.replaceLayerContents(layerId, features)),
      upsertLayers: (layers) => this.guard(() => this.upsertLayers(layers)),
      patchLayer: (id, patch) => this.guard(() => this.patchLayer(id, patch)),
      moveLayer: (id, parentId, index) => this.guard(() => this.moveLayer(id, parentId, index)),
      removeLayers: (ids) => this.guard(() => this.removeLayers(ids)),
      upsertBasemaps: (basemaps) => this.guard(() => this.upsertBasemaps(basemaps)),
      patchBasemap: (id, patch) => this.guard(() => this.patchBasemap(id, patch)),
      removeBasemaps: (ids) => this.guard(() => this.removeBasemaps(ids)),
      select: (ids, mode) => this.guard(() => this.select(ids, mode)),
      clearSelection: () => this.guard(() => this.applySelection(EMPTY_SET)),
      setHovered: (id) => this.guard(() => this.setHovered(id)),
      setDraft: (feature) => this.guard(() => this.setDraft(feature)),
      clearDraft: (id) => this.guard(() => this.clearDraft(id)),
    };
  }

  // ── Okuma ──────────────────────────────────────────────────────

  getDraft(id: string): FeatureDraft | undefined {
    return this.drafts.get(id);
  }

  getEffectiveFeature(id: string): Feature | undefined {
    return this.drafts.get(id)?.feature ?? this.features.get(id);
  }

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
    // Önbellek: değişiklik olmadıkça aynı dizi döner (React useSyncExternalStore buna güvenir).
    if (!this.sortedBasemaps) {
      this.sortedBasemaps =
        this.basemaps.size === 0
          ? EMPTY_BASEMAPS
          : // Array.prototype.sort kararlıdır: eşit `order`'da ekleme sırası korunur.
            [...this.basemaps.values()].sort((a, b) => a.order - b.order);
    }
    return this.sortedBasemaps;
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
    // Saat bir kez okunur: 50k unsurluk pakette unsur başına `performance.now()` ölçümde ~50 ms/sn tutuyordu.
    if (this.depth === 0) this.txTime = this.now();
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

  /**
   * En dıştaki transaction bitti: bekleyen bildirimleri gönder. Liste önce sıfırlanır; böylece
   * bir dinleyicinin açtığı yeni transaction ayrı bir dalga olarak işlenir.
   */
  private commit(): void {
    const p = this.pending;
    if (!p.any) return;
    this.pending = emptyPending();

    for (const id of p.features) this.notify(this.featureListeners.get(id));
    for (const id of p.layers) this.notify(this.layerListeners.get(id));
    for (const id of p.basemaps) this.notify(this.basemapListeners.get(id));
    for (const id of p.layerContents) this.notify(this.layerContentsListeners.get(id));
    if (p.structure) this.notify(this.structureListeners);
    if (p.basemapList) this.notify(this.basemapListListeners);
    if (p.selection) this.notify(this.selectionListeners);
    if (p.hover) this.notify(this.hoverListeners);
    this.notify(this.changeListeners);
  }

  private notify(listeners: ReadonlySet<Listener> | undefined): void {
    if (!listeners || listeners.size === 0) return;
    // Kopya üzerinde gez: dinleyici içinde abone olma/çıkma gezinmeyi etkilemesin.
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch (error) {
        this.reportListenerError(error);
      }
    }
  }

  // ── Abonelik ───────────────────────────────────────────────────

  subscribeFeature(id: string, cb: Listener): Unsubscribe {
    return this.featureListeners.add(id, cb);
  }

  subscribeLayer(id: string, cb: Listener): Unsubscribe {
    return this.layerListeners.add(id, cb);
  }

  subscribeBasemap(id: string, cb: Listener): Unsubscribe {
    return this.basemapListeners.add(id, cb);
  }

  subscribeLayerContents(layerId: string, cb: Listener): Unsubscribe {
    return this.layerContentsListeners.add(layerId, cb);
  }

  subscribeStructure(cb: Listener): Unsubscribe {
    return addListener(this.structureListeners, cb);
  }

  subscribeBasemaps(cb: Listener): Unsubscribe {
    return addListener(this.basemapListListeners, cb);
  }

  subscribeSelection(cb: Listener): Unsubscribe {
    return addListener(this.selectionListeners, cb);
  }

  subscribeHover(cb: Listener): Unsubscribe {
    return addListener(this.hoverListeners, cb);
  }

  subscribeChanges(cb: Listener): Unsubscribe {
    return addListener(this.changeListeners, cb);
  }

  // ── Günlük + bildirim yardımcıları ─────────────────────────────
  // Her yazma hem günlüğe (MapSync için) hem bekleyen bildirim listesine (aboneler için) düşer.

  private recordFeature(id: string, op: ChangeOp, mask?: number): void {
    this.journal.record(ENTITY_KIND.FEATURE, id, op, mask);
    this.pending.features.add(id);
    this.pending.any = true;
  }

  private recordLayer(id: string, op: ChangeOp, mask?: number): void {
    this.journal.record(ENTITY_KIND.LAYER, id, op, mask);
    this.pending.layers.add(id);
    this.pending.any = true;
  }

  private recordBasemap(id: string, op: ChangeOp, mask?: number): void {
    this.journal.record(ENTITY_KIND.BASEMAP, id, op, mask);
    this.pending.basemaps.add(id);
    this.pending.basemapList = true;
    this.pending.any = true;
  }

  private markStructure(): void {
    this.journal.markStructure();
    this.pending.structure = true;
    this.pending.any = true;
  }

  private flipSelection(id: string): void {
    this.journal.flipSelection(id);
    this.pending.selection = true;
    this.pending.any = true;
  }

  private recordHover(prev: string | null, next: string | null): void {
    this.journal.recordHover(prev, next);
    this.pending.hover = true;
    this.pending.any = true;
  }

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
      this.drafts.delete(id); // düzenlenen unsur silindi: taslak da gider (düzenleyici bunu görür)

      if (this.selection.has(id)) {
        const next = new Set(this.selection);
        next.delete(id);
        this.applySelection(next);
      }
      if (this.hovered === id) {
        this.hovered = null;
        this.recordHover(id, null);
      }

      this.recordFeature(id, CHANGE_OP.REMOVE);
    }
  }

  private replaceLayerContents(layerId: string, features: readonly Feature[]): void {
    const incoming: Feature[] = [];
    const incomingIds = new Set<string>();
    for (const feature of features) {
      if (feature.layerId !== layerId) {
        this.mutableStats.rejectedSnapshotItems++;
        continue;
      }
      incoming.push(feature);
      incomingIds.add(feature.id);
    }

    // 1) Katmanda olup snapshot'ta olmayanlar silinir (kopya üzerinde gez: silme kümeyi değiştirir).
    const current = this.featureIdsByLayer.get(layerId);
    if (current) {
      this.removeFeatures([...current].filter((id) => !incomingIds.has(id)));
    }

    // 2) Snapshot'takiler upsert edilir; `rev` kontrolü yok, `rev` durumu snapshot'tan yeniden kurulur.
    //    Başka katmanda duran aynı id'li unsur bu katmana taşınır (snapshot yetkilidir).
    for (const next of incoming) {
      this.revs.delete(next.id);
      const prev = this.features.get(next.id);
      if (prev) this.replaceFeature(prev, next, next.rev);
      else this.addFeature(next);
    }
  }

  private addFeature(feature: Feature): void {
    this.features.set(feature.id, feature);
    this.indexFeature(feature.layerId, feature.id);
    this.touch(feature.id, feature.rev);
    this.recordFeature(feature.id, CHANGE_OP.ADD);
  }

  /** Var olan unsuru yenisiyle değiştirir; değişiklik yoksa yalnız zaman ve `rev` ilerler. */
  private replaceFeature(prev: Feature, incoming: Feature, rev: number | undefined): void {
    // Aynı içerikteki mesaj da unsurun "taze" olduğunu gösterir (bayatlık için).
    this.touch(incoming.id, rev);

    // Tam nesne akışı: içeriği aynı kalan alanların eski referansı korunur (gereksiz bit yok).
    const next = stabilizeFeature(prev, incoming);
    const mask = diffFeature(prev, next);
    if (mask === 0) return; // eski referans kalır → React yeniden çizmez, harita güncellenmez

    if (prev.layerId !== next.layerId) {
      this.unindexFeature(prev.layerId, next.id);
      this.indexFeature(next.layerId, next.id);
    }
    this.features.set(next.id, next);
    // Taslak varken haritada taslak durur: asıl kayıttaki değişiklik çizilmez, yalnız abonelere
    // (çakışma uyarısı) gider. Taslak atılınca harita asıl kaydın son hâline döner.
    this.recordFeature(next.id, CHANGE_OP.UPDATE, this.drafts.has(next.id) ? FEATURE_CHANGE.META : mask);
  }

  private setDraft(feature: Feature): void {
    const stored = this.features.get(feature.id);
    if (!stored) return;
    const current = this.drafts.get(feature.id);
    const shown = current?.feature ?? stored;
    const next = stabilizeFeature(shown, feature);
    this.drafts.set(feature.id, { feature: next, base: current?.base ?? stored });
    const mask = diffFeature(shown, next);
    // İçerik aynı olsa da aboneler haber almalı (ör. düzenleme başladı).
    this.recordFeature(feature.id, CHANGE_OP.UPDATE, mask === 0 ? FEATURE_CHANGE.META : mask);
  }

  private clearDraft(id: string): void {
    const draft = this.drafts.get(id);
    if (!draft) return;
    this.drafts.delete(id);
    const stored = this.features.get(id);
    if (!stored) return;
    const mask = diffFeature(draft.feature, stored);
    this.recordFeature(id, CHANGE_OP.UPDATE, mask === 0 ? FEATURE_CHANGE.META : mask);
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
    this.updatedAt.set(id, this.txTime); // transaction başındaki zaman (aynı paket = aynı an)
    if (rev !== undefined) this.revs.set(id, rev);
  }

  // ── Katman işlemleri ───────────────────────────────────────────

  private upsertLayers(layers: readonly Layer[]): void {
    for (const next of layers) {
      const prev = this.layers.get(next.id);
      if (prev) {
        this.replaceLayer(prev, next);
        continue;
      }
      // Yeni katman da döngü oluşturabilir: daha önce `parentId`'si bu id olan yetim katmanlar
      // varsa ve yeni katman onlardan birinin altına konuyorsa.
      this.assertNoCycle(next.id, next.parentId);
      this.layers.set(next.id, next);
      this.insertChild(next.parentId, next.id);
      this.recordLayer(next.id, CHANGE_OP.ADD);
      this.markStructure();
    }
  }

  private patchLayer(id: string, patch: LayerPatch): void {
    const prev = this.layers.get(id);
    if (!prev) {
      this.mutableStats.ignoredPatches++;
      return;
    }
    this.replaceLayer(prev, mergeLayerPatch(prev, patch));
  }

  /** Var olan katmanı yenisiyle değiştirir; ebeveyn değiştiyse yeni ebeveynin sonuna taşır. */
  private replaceLayer(prev: Layer, incoming: Layer): void {
    const next = stabilizeLayer(prev, incoming);
    const parentChanged = prev.parentId !== next.parentId;
    if (parentChanged) this.assertNoCycle(next.id, next.parentId);

    const mask = diffLayer(prev, next);
    if (mask === 0) return;

    if (parentChanged) {
      this.removeChild(prev.parentId, next.id);
      this.insertChild(next.parentId, next.id);
      this.markStructure();
    }
    this.layers.set(next.id, next);
    this.recordLayer(next.id, CHANGE_OP.UPDATE, mask);
  }

  private moveLayer(id: string, parentId: string | null, index?: number): void {
    const prev = this.layers.get(id);
    if (!prev) throw new Error(`moveLayer: katman yok (${id}).`);
    this.assertNoCycle(id, parentId);

    const sameParent = prev.parentId === parentId;
    const current = this.getChildLayerIds(parentId);
    const siblings = current.filter((childId) => childId !== id);
    const target = Math.min(Math.max(index ?? siblings.length, 0), siblings.length);

    if (sameParent && current.indexOf(id) === target) return; // yer değişmiyor

    if (!sameParent) this.removeChild(prev.parentId, id);
    const nextIds = [...siblings];
    nextIds.splice(target, 0, id);
    this.childLayerIds.set(parentId, nextIds);

    if (!sameParent) this.layers.set(id, { ...prev, parentId });
    this.recordLayer(id, CHANGE_OP.UPDATE, LAYER_CHANGE.PARENT);
    this.markStructure();
  }

  private removeLayers(ids: readonly string[]): void {
    for (const id of ids) this.removeLayerTree(id);
  }

  /** Katmanı alt katmanları ve tüm unsurlarıyla birlikte siler (önce çocuklar). */
  private removeLayerTree(id: string): void {
    const layer = this.layers.get(id);
    if (!layer) return;

    // Çocuk listesi her değişimde yeni dizi olur (yerinde değişmez); eski referansı gezmek güvenli.
    for (const childId of this.getChildLayerIds(id)) this.removeLayerTree(childId);

    const featureIds = this.featureIdsByLayer.get(id);
    if (featureIds) this.removeFeatures([...featureIds]);

    this.childLayerIds.delete(id);
    this.removeChild(layer.parentId, id);
    this.layers.delete(id);
    this.recordLayer(id, CHANGE_OP.REMOVE);
    this.markStructure();
  }

  /** `id` katmanı `parentId` altına konursa döngü oluşur mu? Oluşursa hata fırlatır. */
  private assertNoCycle(id: string, parentId: string | null): void {
    let current = parentId;
    for (let guard = 0; current !== null; guard++) {
      if (current === id) {
        throw new Error(`Katman döngüsü: "${id}" kendi alt ağacına (${parentId}) konamaz.`);
      }
      if (guard > this.layers.size) break; // var olan bozuk veriye karşı sonsuz döngü koruması
      current = this.layers.get(current)?.parentId ?? null;
    }
  }

  /** Çocuk listesine ekler. Liste yerinde değişmez, yeni dizi yazılır (React referansa güvenir). */
  private insertChild(parentId: string | null, id: string): void {
    this.childLayerIds.set(parentId, [...this.getChildLayerIds(parentId), id]);
  }

  private removeChild(parentId: string | null, id: string): void {
    const next = this.getChildLayerIds(parentId).filter((childId) => childId !== id);
    if (next.length === 0) this.childLayerIds.delete(parentId);
    else this.childLayerIds.set(parentId, next);
  }

  // ── Altlık işlemleri ───────────────────────────────────────────

  private upsertBasemaps(basemaps: readonly Basemap[]): void {
    for (const next of basemaps) {
      const prev = this.basemaps.get(next.id);
      if (prev) {
        this.replaceBasemap(prev, next);
        continue;
      }
      this.basemaps.set(next.id, next);
      this.sortedBasemaps = null;
      this.recordBasemap(next.id, CHANGE_OP.ADD);
      if (next.visible) this.enforceExclusiveGroup(next);
    }
  }

  private patchBasemap(id: string, patch: BasemapPatch): void {
    const prev = this.basemaps.get(id);
    if (!prev) {
      this.mutableStats.ignoredPatches++;
      return;
    }
    this.replaceBasemap(prev, mergeBasemapPatch(prev, patch));
  }

  private replaceBasemap(prev: Basemap, incoming: Basemap): void {
    const next = stabilizeBasemap(prev, incoming);
    const mask = diffBasemap(prev, next);
    if (mask === 0) return;

    this.basemaps.set(next.id, next);
    this.sortedBasemaps = null;
    this.recordBasemap(next.id, CHANGE_OP.UPDATE, mask);

    // Görünür hale geldi ya da görünürken başka bir gruba geçti → grubunda tek açık o olmalı.
    if (next.visible && (!prev.visible || prev.exclusiveGroup !== next.exclusiveGroup)) {
      this.enforceExclusiveGroup(next);
    }
  }

  private removeBasemaps(ids: readonly string[]): void {
    for (const id of ids) {
      if (!this.basemaps.delete(id)) continue;
      this.sortedBasemaps = null;
      this.recordBasemap(id, CHANGE_OP.REMOVE);
    }
  }

  /** `winner` görünür: aynı `exclusiveGroup`'taki diğer görünür altlıkları kapatır (radyo davranışı). */
  private enforceExclusiveGroup(winner: Basemap): void {
    const group = winner.exclusiveGroup;
    if (group === undefined) return;

    for (const other of this.basemaps.values()) {
      if (other.id === winner.id || !other.visible || other.exclusiveGroup !== group) continue;
      // Var olan anahtarı güncellemek Map gezinmesini bozmaz.
      this.basemaps.set(other.id, { ...other, visible: false });
      this.sortedBasemaps = null;
      this.recordBasemap(other.id, CHANGE_OP.UPDATE, BASEMAP_CHANGE.VISIBLE);
    }
  }

  // ── Seçim ve hover ─────────────────────────────────────────────

  private select(ids: readonly string[], mode: SelectMode = SELECT_MODE.REPLACE): void {
    const current = this.selection;
    let next: Set<string>;

    switch (mode) {
      case SELECT_MODE.REPLACE:
        next = new Set(ids.filter((id) => this.isSelectable(id)));
        break;
      case SELECT_MODE.ADD:
        next = new Set(current);
        for (const id of ids) if (this.isSelectable(id)) next.add(id);
        break;
      case SELECT_MODE.REMOVE:
        next = new Set(current);
        for (const id of ids) next.delete(id);
        break;
      case SELECT_MODE.TOGGLE:
        next = new Set(current);
        for (const id of ids) {
          if (next.has(id)) next.delete(id);
          else if (this.isSelectable(id)) next.add(id);
        }
        break;
    }
    this.applySelection(next);
  }

  /**
   * Yeni seçimi uygular. Durumu gerçekten değişen her id günlüğe "döndü" olarak yazılır;
   * hiçbir şey değişmediyse küme referansı da değişmez.
   */
  private applySelection(next: ReadonlySet<string>): void {
    const current = this.selection;
    let changed = false;
    for (const id of current) {
      if (!next.has(id)) {
        this.flipSelection(id);
        changed = true;
      }
    }
    for (const id of next) {
      if (!current.has(id)) {
        this.flipSelection(id);
        changed = true;
      }
    }
    if (changed) this.selection = next.size === 0 ? EMPTY_SET : next;
  }

  /** Unsur var mı ve kendisi ile katman zincirindeki hiçbir katman `selectable: false` değil mi? */
  private isSelectable(id: string): boolean {
    const feature = this.features.get(id);
    if (!feature || feature.selectable === false) return false;

    let layerId: string | null = feature.layerId;
    for (let guard = 0; layerId !== null && guard <= this.layers.size; guard++) {
      const layer = this.layers.get(layerId);
      if (!layer) break; // yetim: üstünde katman bilgisi yok
      if (layer.selectable === false) return false;
      layerId = layer.parentId;
    }
    return true;
  }

  private setHovered(id: string | null): void {
    if (id !== null && !this.features.has(id)) return;
    if (id === this.hovered) return;
    this.recordHover(this.hovered, id);
    this.hovered = id;
  }

  // Yetim unsur (katmanı henüz yok) de indekslenir: katman sonradan gelince unsurları hazırdır.
  private indexFeature(layerId: string, id: string): void {
    let ids = this.featureIdsByLayer.get(layerId);
    if (!ids) {
      ids = new Set();
      this.featureIdsByLayer.set(layerId, ids);
    }
    ids.add(id);
    this.pending.layerContents.add(layerId);
    this.pending.any = true;
  }

  private unindexFeature(layerId: string, id: string): void {
    const ids = this.featureIdsByLayer.get(layerId);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.featureIdsByLayer.delete(layerId);
    this.pending.layerContents.add(layerId);
    this.pending.any = true;
  }
}
