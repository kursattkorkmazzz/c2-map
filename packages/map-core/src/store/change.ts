// ── Değişiklik maskeleri ve günlük tipleri ───────────────────────
// Tasarım: plan/design/03-store.md#değişiklik-günlüğü-changejournal
//
// Her varlık türünün değişen alanları bit maskesiyle ifade edilir. Birden fazla alan
// aynı anda değişebilir: `FEATURE_CHANGE.GEOMETRY | FEATURE_CHANGE.STYLE`.
// Bir bitin set olup olmadığı: `(mask & FEATURE_CHANGE.STYLE) !== 0`.

export const FEATURE_CHANGE = {
  GEOMETRY: 1 << 0,
  STYLE: 1 << 1,
  PROPS: 1 << 2,
  Z: 1 << 3,
  HIDDEN: 1 << 4,
  LAYER: 1 << 5, // layerId (başka katmana taşındı)
  INTERACTION: 1 << 6, // selectable
  META: 1 << 7, // görsel değil → haritaya gitmez (meta, editable, deletable)
} as const;

export const LAYER_CHANGE = {
  NAME: 1 << 0,
  VISIBLE: 1 << 1,
  OPACITY: 1 << 2,
  ZOOM: 1 << 3, // minZoom / maxZoom
  INTERACTION: 1 << 4, // selectable / interactive
  RENDER_GROUP: 1 << 5,
  PARENT: 1 << 6, // taşındı veya kardeşler arası sırası değişti
  META: 1 << 7,
} as const;

export const BASEMAP_CHANGE = {
  SOURCE: 1 << 0,
  VISIBLE: 1 << 1,
  OPACITY: 1 << 2,
  ORDER: 1 << 3,
  INFO: 1 << 4, // ad, sağlayıcı, attribution, thumbnail, exclusiveGroup
} as const;

/** Bir bit tablosundaki tüm bitlerin OR'u. */
const allBits = (bits: Record<string, number>): number =>
  Object.values(bits).reduce((acc, bit) => acc | bit, 0);

/** Tüm bitler: REMOVE → ADD birleşmesinde ("her şey değişmiş olabilir") kullanılır. */
export const FEATURE_CHANGE_ALL = allBits(FEATURE_CHANGE);
export const LAYER_CHANGE_ALL = allBits(LAYER_CHANGE);
export const BASEMAP_CHANGE_ALL = allBits(BASEMAP_CHANGE);

/** Haritayı ilgilendiren bitler (META hariç). Yalnız META değiştiyse unsur haritaya gitmez. */
export const FEATURE_CHANGE_VISUAL = FEATURE_CHANGE_ALL & ~FEATURE_CHANGE.META;

// ── İşlem türü ───────────────────────────────────────────────────

export const CHANGE_OP = {
  ADD: "add",
  UPDATE: "update",
  REMOVE: "remove",
} as const;
export type ChangeOp = (typeof CHANGE_OP)[keyof typeof CHANGE_OP];

/** Bir varlık için günlükteki tek kayıt (birleştirilmiş). */
export type EntityChange = {
  op: ChangeOp;
  mask: number;
};

/** Son flush'tan beri biriken değişiklikler. `store.drainChanges()` döner. */
export type ChangeSet = {
  features: ReadonlyMap<string, EntityChange>;
  layers: ReadonlyMap<string, EntityChange>;
  basemaps: ReadonlyMap<string, EntityChange>;
  /** Katman ağacının şekli değişti (ekle / sil / taşı). */
  structure: boolean;
  /** Seçim durumu değişen unsur id'leri (seçilen veya seçimi kalkan). */
  selection: ReadonlySet<string>;
  /** Hover değiştiyse ilk ve son durum; değişmediyse null. */
  hover: { prev: string | null; next: string | null } | null;
};
