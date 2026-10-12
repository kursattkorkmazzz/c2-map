// ── Değişiklik günlüğü ───────────────────────────────────────────
// Tasarım: plan/design/03-store.md#işlemler-ve-birleştirme
//
// Store her yazmada buraya "şu varlık şöyle değişti" diye kayıt düşer. MapSync her flush'ta
// `drain()` ile biriken kayıtları alır. Aynı id için gelen kayıtlar birleştirilir (coalescing):
// 10 konum güncellemesi → tek kayıt. Bellek, değişen varlık sayısıyla sınırlı kalır.

import {
  BASEMAP_CHANGE_ALL,
  CHANGE_OP,
  FEATURE_CHANGE_ALL,
  LAYER_CHANGE_ALL,
  type ChangeOp,
  type ChangeSet,
  type EntityChange,
} from "./change";

export const ENTITY_KIND = {
  FEATURE: "feature",
  LAYER: "layer",
  BASEMAP: "basemap",
} as const;
export type EntityKind = (typeof ENTITY_KIND)[keyof typeof ENTITY_KIND];

const ALL_BITS: Record<EntityKind, number> = {
  [ENTITY_KIND.FEATURE]: FEATURE_CHANGE_ALL,
  [ENTITY_KIND.LAYER]: LAYER_CHANGE_ALL,
  [ENTITY_KIND.BASEMAP]: BASEMAP_CHANGE_ALL,
};

/**
 * Aynı id için önceki kayıt ile yeni işlemi birleştirir.
 * `null` dönerse kayıt silinmelidir (ör. ekle → sil: harita onu hiç görmedi).
 *
 * Normalleştirme: ADD her zaman tüm bitleri taşır (yeni varlığın her alanı "yeni"),
 * REMOVE hiç bit taşımaz (silinen varlığın alanları önemsiz).
 */
export function coalesce(
  prev: EntityChange | undefined,
  op: ChangeOp,
  mask: number,
  allBits: number,
): EntityChange | null {
  const { ADD, UPDATE, REMOVE } = CHANGE_OP;

  if (!prev) {
    if (op === ADD) return { op: ADD, mask: allBits };
    if (op === REMOVE) return { op: REMOVE, mask: 0 };
    return mask === 0 ? null : { op: UPDATE, mask };
  }

  switch (prev.op) {
    case ADD:
      // Harita bu varlığı henüz görmedi.
      if (op === REMOVE) return null; // ekle → sil: söylenecek bir şey yok
      return { op: ADD, mask: allBits }; // ekle → güncelle: son haliyle ekle

    case UPDATE:
      if (op === REMOVE) return { op: REMOVE, mask: 0 };
      if (op === ADD) return { op: UPDATE, mask: allBits }; // olmamalı (varlık zaten vardı)
      return { op: UPDATE, mask: prev.mask | mask }; // güncelle → güncelle: maskeler OR

    case REMOVE:
      if (op === REMOVE) return prev; // olmamalı, ama zararsız
      // sil → ekle: harita eskisini biliyor, yeni nesne tamamen farklı olabilir.
      // (sil → güncelle olmamalı; varlık var demektir, aynı şekilde ele alınır.)
      return { op: UPDATE, mask: allBits };
  }
}

export class ChangeJournal {
  private entities: Record<EntityKind, Map<string, EntityChange>> =
    emptyEntityMaps();
  private structure = false;
  private selection = new Set<string>();
  private hover: { prev: string | null; next: string | null } | null = null;

  /** Bir varlık değişikliğini kaydeder (birleştirerek). */
  record(kind: EntityKind, id: string, op: ChangeOp, mask = 0): void {
    const map = this.entities[kind];
    const next = coalesce(map.get(id), op, mask, ALL_BITS[kind]);
    if (next) map.set(id, next);
    else map.delete(id);
  }

  /** Katman ağacının şekli değişti (ekle / sil / taşı). */
  markStructure(): void {
    this.structure = true;
  }

  /**
   * Bir unsurun seçim durumu **tersine döndü** (seçildi veya seçimi kalktı).
   * Store yalnız durum gerçekten değiştiğinde çağırır. Aynı flush içinde iki kez dönen
   * (seçildi → kalktı) unsurun net değişikliği yoktur ve listeden çıkar.
   */
  flipSelection(id: string): void {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
  }

  /** Hover değişti. İlk `prev` korunur, `next` güncellenir; başa dönerse kayıt silinir. */
  recordHover(prev: string | null, next: string | null): void {
    if (prev === next) return;
    const start = this.hover ? this.hover.prev : prev;
    this.hover = start === next ? null : { prev: start, next };
  }

  get isEmpty(): boolean {
    return (
      this.entities.feature.size === 0 &&
      this.entities.layer.size === 0 &&
      this.entities.basemap.size === 0 &&
      !this.structure &&
      this.selection.size === 0 &&
      this.hover === null
    );
  }

  /** Biriken değişiklikleri döner ve günlüğü sıfırlar. */
  drain(): ChangeSet {
    const changes: ChangeSet = {
      features: this.entities.feature,
      layers: this.entities.layer,
      basemaps: this.entities.basemap,
      structure: this.structure,
      selection: this.selection,
      hover: this.hover,
    };
    // Dönen nesneler artık çağırana ait; günlük yeni boş yapılarla devam eder.
    this.entities = emptyEntityMaps();
    this.structure = false;
    this.selection = new Set();
    this.hover = null;
    return changes;
  }
}

function emptyEntityMaps(): Record<EntityKind, Map<string, EntityChange>> {
  return {
    [ENTITY_KIND.FEATURE]: new Map(),
    [ENTITY_KIND.LAYER]: new Map(),
    [ENTITY_KIND.BASEMAP]: new Map(),
  };
}
