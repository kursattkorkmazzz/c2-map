// ── MapStore ─────────────────────────────────────────────────────
// Tasarım: plan/design/03-store.md
//
// Tek doğruluk kaynağı: katmanlar, altlıklar, unsurlar, seçim, hover.
// Tüm yazmalar `transaction(tx => …)` içinden yapılır; her yazma değişiklik günlüğüne
// (ChangeJournal) düşer ve MapSync bunu `drainChanges()` ile alır.
//
// Durum: 0.2.4 (iç yapılar + okuma), 0.2.5 (transaction + unsur), 0.2.6 (katman),
// 0.2.7 (altlık), 0.2.8 (snapshot) ve 0.2.9 (seçim/hover) hazır. Abonelik (0.2.10)
// sonraki adımda bu dosyaya eklenecek.

import type { Basemap } from "../model/basemap";
import type { Feature } from "../model/feature";
import type { Layer } from "../model/layer";
import { BASEMAP_CHANGE, CHANGE_OP, LAYER_CHANGE, type ChangeSet } from "./change";
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

// ── Genel API ────────────────────────────────────────────────────

export type MapStoreOptions = {
  /** Saat kaynağı (ms). Testte enjekte edilir. Varsayılan: `performance.now` / `Date.now`. */
  now?: () => number;
};

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
}

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
   * silinir). Referansı saklamayın; değişimi `subscribeLayerContents` (0.2.10) ile dinleyip
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

  /** Açık transaction derinliği (iç içe çağrılar için). */
  private depth = 0;
  private readonly tx: MapTx;

  constructor(options: MapStoreOptions) {
    this.now = options.now ?? defaultNow;
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
        this.applySelection(next);
      }
      if (this.hovered === id) {
        this.hovered = null;
        this.journal.recordHover(id, null);
      }

      this.journal.record(ENTITY_KIND.FEATURE, id, CHANGE_OP.REMOVE);
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
      this.journal.record(ENTITY_KIND.LAYER, next.id, CHANGE_OP.ADD);
      this.journal.markStructure();
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
  private replaceLayer(prev: Layer, next: Layer): void {
    const parentChanged = prev.parentId !== next.parentId;
    if (parentChanged) this.assertNoCycle(next.id, next.parentId);

    const mask = diffLayer(prev, next);
    if (mask === 0) return;

    if (parentChanged) {
      this.removeChild(prev.parentId, next.id);
      this.insertChild(next.parentId, next.id);
      this.journal.markStructure();
    }
    this.layers.set(next.id, next);
    this.journal.record(ENTITY_KIND.LAYER, next.id, CHANGE_OP.UPDATE, mask);
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
    this.journal.record(ENTITY_KIND.LAYER, id, CHANGE_OP.UPDATE, LAYER_CHANGE.PARENT);
    this.journal.markStructure();
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
    this.journal.record(ENTITY_KIND.LAYER, id, CHANGE_OP.REMOVE);
    this.journal.markStructure();
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
      this.journal.record(ENTITY_KIND.BASEMAP, next.id, CHANGE_OP.ADD);
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

  private replaceBasemap(prev: Basemap, next: Basemap): void {
    const mask = diffBasemap(prev, next);
    if (mask === 0) return;

    this.basemaps.set(next.id, next);
    this.sortedBasemaps = null;
    this.journal.record(ENTITY_KIND.BASEMAP, next.id, CHANGE_OP.UPDATE, mask);

    // Görünür hale geldi ya da görünürken başka bir gruba geçti → grubunda tek açık o olmalı.
    if (next.visible && (!prev.visible || prev.exclusiveGroup !== next.exclusiveGroup)) {
      this.enforceExclusiveGroup(next);
    }
  }

  private removeBasemaps(ids: readonly string[]): void {
    for (const id of ids) {
      if (!this.basemaps.delete(id)) continue;
      this.sortedBasemaps = null;
      this.journal.record(ENTITY_KIND.BASEMAP, id, CHANGE_OP.REMOVE);
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
      this.journal.record(ENTITY_KIND.BASEMAP, other.id, CHANGE_OP.UPDATE, BASEMAP_CHANGE.VISIBLE);
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
        this.journal.flipSelection(id);
        changed = true;
      }
    }
    for (const id of next) {
      if (!current.has(id)) {
        this.journal.flipSelection(id);
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
    this.journal.recordHover(this.hovered, id);
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
  }

  private unindexFeature(layerId: string, id: string): void {
    const ids = this.featureIdsByLayer.get(layerId);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.featureIdsByLayer.delete(layerId);
  }
}
