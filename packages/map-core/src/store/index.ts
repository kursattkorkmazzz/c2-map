// Store'un genel API'si. Günlük (ChangeJournal), birleştirme (coalesce) ve maske hesabı
// (diff*, merge*) iç ayrıntıdır; yalnız store ve MapSync kullanır, dışa açılmaz.

export {
  BASEMAP_CHANGE,
  BASEMAP_CHANGE_ALL,
  CHANGE_OP,
  FEATURE_CHANGE,
  FEATURE_CHANGE_ALL,
  FEATURE_CHANGE_VISUAL,
  LAYER_CHANGE,
  LAYER_CHANGE_ALL,
  type ChangeOp,
  type ChangeSet,
  type EntityChange,
} from "./change";
export type { BasemapPatch, FeaturePatch, LayerPatch } from "./diff";
export {
  createMapStore,
  SELECT_MODE,
  type MapStore,
  type MapStoreOptions,
  type MapStoreStats,
  type MapTx,
  type SelectMode,
  type Unsubscribe,
} from "./map-store";
