// ── Maske hesabı ve patch birleştirme ────────────────────────────
// Tasarım: plan/design/03-store.md#değişmezlik-kuralı, #unsurlar
//
// Store varlıkları değişmez (immutable) kabul eder: bir alan değiştiyse o alanın REFERANSI
// değişmiştir. Bu yüzden karşılaştırma derin değil, alan alan `Object.is` ile yapılır (O(alan)).
// Yeni ama içeriği aynı bir nesne "değişti" sayılır; bu temkinli tercih adapter'ın diff'inde yakalanır.

import type { Basemap } from "../model/basemap";
import type { Feature } from "../model/feature";
import type { Layer } from "../model/layer";
import {
  BASEMAP_CHANGE,
  FEATURE_CHANGE,
  FEATURE_CHANGE_ALL,
  LAYER_CHANGE,
} from "./change";

// ── Patch tipleri ────────────────────────────────────────────────
// `id` zorunlu, diğer alanlar isteğe bağlı. Bir anahtar patch'te VARSA (değeri `undefined`
// olsa bile) uygulanır: `{ id, hidden: undefined }` alanı temizler. Anahtar YOKSA dokunulmaz.

export type FeaturePatch = { id: string } & Partial<Omit<Feature, "id">>;
export type LayerPatch = Partial<Omit<Layer, "id">>;
export type BasemapPatch = Partial<Omit<Basemap, "id">>;

// ── Maske hesabı ─────────────────────────────────────────────────

/** İki unsur arasındaki değişen alanların maskesi. Değişiklik yoksa 0. */
export function diffFeature(prev: Feature, next: Feature): number {
  if (prev === next) return 0;
  // kind değişirse çizici (renderer) değişir: her şey yeniden çizilmeli.
  if (prev.kind !== next.kind) return FEATURE_CHANGE_ALL;

  let mask = 0;
  if (!Object.is(prev.geometry, next.geometry)) mask |= FEATURE_CHANGE.GEOMETRY;
  if (!Object.is(prev.style, next.style)) mask |= FEATURE_CHANGE.STYLE;
  if (!Object.is(prev.props, next.props)) mask |= FEATURE_CHANGE.PROPS;
  if (!Object.is(prev.z, next.z)) mask |= FEATURE_CHANGE.Z;
  if (!Object.is(prev.hidden, next.hidden)) mask |= FEATURE_CHANGE.HIDDEN;
  if (prev.layerId !== next.layerId) mask |= FEATURE_CHANGE.LAYER;
  if (!Object.is(prev.selectable, next.selectable)) mask |= FEATURE_CHANGE.INTERACTION;
  if (!Object.is(prev.meta, next.meta)) mask |= FEATURE_CHANGE.META;
  // İzinler görsel değil: META gibi yalnız abonelere gider, haritaya gitmez.
  if (!Object.is(prev.editable, next.editable) || !Object.is(prev.deletable, next.deletable)) mask |= FEATURE_CHANGE.META;
  // `rev` bilerek karşılaştırılmaz: sürüm numarası görsel veya domain değişikliği değildir.
  return mask;
}

/** İki katman arasındaki değişen alanların maskesi. Değişiklik yoksa 0. */
export function diffLayer(prev: Layer, next: Layer): number {
  if (prev === next) return 0;

  let mask = 0;
  if (prev.name !== next.name) mask |= LAYER_CHANGE.NAME;
  if (prev.visible !== next.visible) mask |= LAYER_CHANGE.VISIBLE;
  if (!Object.is(prev.opacity, next.opacity)) mask |= LAYER_CHANGE.OPACITY;
  if (!Object.is(prev.minZoom, next.minZoom) || !Object.is(prev.maxZoom, next.maxZoom)) {
    mask |= LAYER_CHANGE.ZOOM;
  }
  if (!Object.is(prev.selectable, next.selectable) || !Object.is(prev.interactive, next.interactive)) {
    mask |= LAYER_CHANGE.INTERACTION;
  }
  if (!Object.is(prev.renderGroup, next.renderGroup)) mask |= LAYER_CHANGE.RENDER_GROUP;
  // Kardeşler arası sıra değişimi (aynı parentId) store tarafından ayrıca PARENT olarak işaretlenir.
  if (prev.parentId !== next.parentId) mask |= LAYER_CHANGE.PARENT;
  if (!Object.is(prev.meta, next.meta)) mask |= LAYER_CHANGE.META;
  if (!Object.is(prev.editable, next.editable) || !Object.is(prev.deletable, next.deletable)) mask |= LAYER_CHANGE.META;
  return mask;
}

/** İki altlık arasındaki değişen alanların maskesi. Değişiklik yoksa 0. */
export function diffBasemap(prev: Basemap, next: Basemap): number {
  if (prev === next) return 0;

  let mask = 0;
  if (!Object.is(prev.source, next.source)) mask |= BASEMAP_CHANGE.SOURCE;
  if (prev.visible !== next.visible) mask |= BASEMAP_CHANGE.VISIBLE;
  if (!Object.is(prev.opacity, next.opacity)) mask |= BASEMAP_CHANGE.OPACITY;
  if (!Object.is(prev.order, next.order)) mask |= BASEMAP_CHANGE.ORDER;
  if (
    prev.name !== next.name ||
    prev.provider !== next.provider ||
    prev.attribution !== next.attribution ||
    prev.thumbnail !== next.thumbnail ||
    prev.exclusiveGroup !== next.exclusiveGroup
  ) {
    mask |= BASEMAP_CHANGE.INFO;
  }
  return mask;
}

// ── Patch birleştirme ────────────────────────────────────────────

/**
 * Unsura kısmi güncelleme uygular ve YENİ nesne döner (`prev` değişmez).
 * `style`, `props`, `meta` sığ birleştirilir (backend `{ id, style: { color } }` gönderebilsin),
 * diğer alanlar doğrudan değiştirilir. Birleşen nesnenin içeriği aynı kalırsa eski referans
 * korunur → gereksiz STYLE/PROPS/META biti üretilmez.
 */
export function mergeFeaturePatch(prev: Feature, patch: FeaturePatch): Feature {
  const next: Feature = { ...prev, ...patch, id: prev.id };
  if ("style" in patch) next.style = shallowMerge(prev.style, patch.style);
  if ("props" in patch) next.props = shallowMerge(prev.props, patch.props);
  if ("meta" in patch) next.meta = shallowMerge(prev.meta, patch.meta);
  return next;
}

/** Katmana kısmi güncelleme uygular (`meta` sığ birleştirilir). */
export function mergeLayerPatch(prev: Layer, patch: LayerPatch): Layer {
  const next: Layer = { ...prev, ...patch, id: prev.id };
  if ("meta" in patch) next.meta = shallowMerge(prev.meta, patch.meta);
  return next;
}

/** Altlığa kısmi güncelleme uygular. `source` ayrışık birleşim olduğu için birleştirilmez, değiştirilir. */
export function mergeBasemapPatch(prev: Basemap, patch: BasemapPatch): Basemap {
  return { ...prev, ...patch, id: prev.id };
}

/**
 * İki düz nesneyi sığ birleştirir. Biri düz nesne değilse (undefined, dizi, sayı…) `patch`
 * aynen alınır. Birleşim `prev` ile aynı içerikteyse `prev` referansı döner.
 */
export function shallowMerge<T>(prev: T, patch: T): T {
  if (!isPlainObject(prev) || !isPlainObject(patch)) return patch;

  let changed = false;
  for (const key of Object.keys(patch)) {
    if (!Object.is(prev[key], patch[key]) || !(key in prev)) {
      changed = true;
      break;
    }
  }
  return changed ? ({ ...prev, ...patch } as T) : prev;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
