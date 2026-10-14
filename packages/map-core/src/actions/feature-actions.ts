// ── FeatureActions: izinli ekle / güncelle / sil ─────────────────
// Tasarım: plan/design/09-interaction-and-editing.md#izinler-ve-yaşam-döngüsü
//
// Her işlem aynı sırayı izler:
//   1) Bayrak: unsurun veya katman zincirinin `editable` / `deletable` alanı açıkça `false` ise
//      işlem reddedilir (DENIED). Varsayılan AÇIK: hatayla eklenen bir çizim kaldırılamaz olmasın.
//   2) Yaşam döngüsü fonksiyonu (uygulamanın; ör. backend'de yetki kontrolü + kayıt):
//      `false` → iptal (REJECTED); `true` → devam; `Feature` → backend'in döndürdüğü hâli yazılır
//      (yeni id / rev). Cevap gelene kadar store'a DOKUNULMAZ; unsur "bekliyor" sayılır, ona
//      ikinci işlem başlatılamaz (BUSY). Hata ve zaman aşımı uygulamanın: fonksiyon hata
//      fırlatırsa store değişmez, hata çağırana iletilir.
//   3) Store'a yazılır.
//
// Store'u doğrudan (`tx.removeFeatures`) kullanan kod bu kuralları atlar: akış (backend) için
// doğru olan budur. Kullanıcı etkileşimi (sağ tık "Sil", çizim, düzenleme) buradan geçer.

import type { Feature } from "../model/feature";
import type { MapStore, Unsubscribe } from "../store/map-store";

export const ACTION_RESULT = {
  /** Store'a yazıldı. */
  DONE: "done",
  /** Bayrak (`editable` / `deletable: false`) izin vermiyor; yaşam döngüsü çağrılmadı. */
  DENIED: "denied",
  /** Yaşam döngüsü fonksiyonu `false` döndü. */
  REJECTED: "rejected",
  /** Unsur yok (silinmiş / hiç olmamış). */
  MISSING: "missing",
  /** Aynı unsurda başka bir işlem sürüyor. */
  BUSY: "busy",
} as const;
export type ActionResult = (typeof ACTION_RESULT)[keyof typeof ACTION_RESULT];

type Decision<T> = boolean | T | Promise<boolean | T>;

/** Uygulamanın verdiği "önce" kancaları. Hepsi isteğe bağlı; verilmeyen adım doğrudan geçer. */
export type FeatureLifecycle = {
  /** Eklemeden önce (ör. backend'e kaydet). `Feature` dönerse (backend id / rev verdi) o eklenir. */
  beforeCreate?(feature: Feature): Decision<Feature>;
  /** Güncellemeden önce. `prev`: store'daki hâli. */
  beforeUpdate?(next: Feature, prev: Feature): Decision<Feature>;
  /** Silmeden önce (ör. backend'de sil; onay gelince haritadan kalkar). */
  beforeDelete?(feature: Feature): Decision<never>;
};

export type FeaturePermissions = {
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  /** Bu unsur için bir işlem (yaşam döngüsü cevabı) bekleniyor. */
  readonly pending: boolean;
};

const PERMISSION = { EDIT: "editable", DELETE: "deletable" } as const;
type PermissionKey = (typeof PERMISSION)[keyof typeof PERMISSION];

export class FeatureActions {
  private readonly pending = new Set<string>();
  private readonly pendingListeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly store: MapStore,
    private lifecycle: FeatureLifecycle = {},
  ) {}

  /** Yaşam döngüsü kancalarını değiştirir (React: her render'daki güncel fonksiyonlar). */
  setLifecycle(lifecycle: FeatureLifecycle): void {
    this.lifecycle = lifecycle;
  }

  // ── İzinler ────────────────────────────────────────────────────

  canEdit(id: string): boolean {
    return this.allowed(id, PERMISSION.EDIT);
  }

  canDelete(id: string): boolean {
    return this.allowed(id, PERMISSION.DELETE);
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  permissions(id: string): FeaturePermissions {
    return { canEdit: this.canEdit(id), canDelete: this.canDelete(id), pending: this.isPending(id) };
  }

  /**
   * Unsurun izinleri değişince haber verir: unsur, katman zinciri (taşınınca yeniden kurulur)
   * veya bekleme durumu.
   */
  subscribe(id: string, cb: () => void): Unsubscribe {
    let layerOffs: Unsubscribe[] = [];
    const watchChain = () => {
      for (const off of layerOffs) off();
      layerOffs = this.chain(id).map((layerId) => this.store.subscribeLayer(layerId, notify));
    };
    const notify = () => {
      watchChain(); // unsur başka katmana taşınmış veya katman ağacı değişmiş olabilir
      cb();
    };
    const offFeature = this.store.subscribeFeature(id, notify);
    const offStructure = this.store.subscribeStructure(notify);
    let listeners = this.pendingListeners.get(id);
    if (!listeners) this.pendingListeners.set(id, (listeners = new Set()));
    listeners.add(cb);
    watchChain();
    return () => {
      offFeature();
      offStructure();
      for (const off of layerOffs) off();
      listeners.delete(cb);
      if (listeners.size === 0) this.pendingListeners.delete(id);
    };
  }

  // ── İşlemler ───────────────────────────────────────────────────

  async create(feature: Feature): Promise<ActionResult> {
    if (this.pending.has(feature.id)) return ACTION_RESULT.BUSY;
    const decision = await this.ask(feature.id, () => this.lifecycle.beforeCreate?.(feature) ?? true);
    if (decision === false) return ACTION_RESULT.REJECTED;
    const final = decision === true ? feature : decision;
    this.store.transaction((tx) => tx.upsertFeatures([final]));
    return ACTION_RESULT.DONE;
  }

  /** `next.id` store'da olmalı. */
  async update(next: Feature): Promise<ActionResult> {
    const prev = this.store.getFeature(next.id);
    if (!prev) return ACTION_RESULT.MISSING;
    if (!this.canEdit(next.id)) return ACTION_RESULT.DENIED;
    if (this.pending.has(next.id)) return ACTION_RESULT.BUSY;
    const decision = await this.ask(next.id, () => this.lifecycle.beforeUpdate?.(next, prev) ?? true);
    if (decision === false) return ACTION_RESULT.REJECTED;
    const final = decision === true ? next : decision;
    this.store.transaction((tx) => tx.upsertFeatures([final]));
    return ACTION_RESULT.DONE;
  }

  async delete(id: string): Promise<ActionResult> {
    const feature = this.store.getFeature(id);
    if (!feature) return ACTION_RESULT.MISSING;
    if (!this.canDelete(id)) return ACTION_RESULT.DENIED;
    if (this.pending.has(id)) return ACTION_RESULT.BUSY;
    const decision = await this.ask(id, () => this.lifecycle.beforeDelete?.(feature) ?? true);
    if (decision === false) return ACTION_RESULT.REJECTED;
    // Akış aynı silmeyi zaten getirmiş olabilir: silme idempotent.
    this.store.transaction((tx) => tx.removeFeatures([id]));
    return ACTION_RESULT.DONE;
  }

  // ── İç ─────────────────────────────────────────────────────────

  /** Kancayı çağırır; cevap gelene kadar unsuru "bekliyor" işaretler. Hata çağırana gider. */
  private async ask<T>(id: string, hook: () => Decision<T>): Promise<boolean | T> {
    this.setPending(id, true);
    try {
      return await hook();
    } finally {
      this.setPending(id, false);
    }
  }

  private setPending(id: string, on: boolean): void {
    if (on === this.pending.has(id)) return;
    if (on) this.pending.add(id);
    else this.pending.delete(id);
    for (const cb of [...(this.pendingListeners.get(id) ?? [])]) cb();
  }

  private allowed(id: string, key: PermissionKey): boolean {
    const feature = this.store.getFeature(id);
    if (!feature) return false;
    if (feature[key] === false) return false;
    for (const layerId of this.chain(id)) if (this.store.getLayer(layerId)?.[key] === false) return false;
    return true;
  }

  /** Unsurun katmanından köke katman id'leri (yetim / döngüye karşı korumalı). */
  private chain(id: string): string[] {
    const ids: string[] = [];
    let layerId = this.store.getFeature(id)?.layerId ?? null;
    while (layerId !== null && !ids.includes(layerId)) {
      ids.push(layerId);
      layerId = this.store.getLayer(layerId)?.parentId ?? null;
    }
    return ids;
  }
}
