// ── Encode ve fark (diff) ────────────────────────────────────────
// Tasarım: plan/design/04-sync-and-rendering.md#encode-ve-diff
//
// Renderer bir unsuru bir veya daha fazla düz GeoJSON parçasına çevirir (encode). Adapter her
// parçanın son gönderilen özelliklerini saklar; yeni encode ile karşılaştırıp MapLibre'ye yalnız
// farkı (`updateData`) gönderir: konum-only güncelleme = yalnız `newGeometry`.

import type { GeoJSONSourceDiff } from 'maplibre-gl';

export type PropertyValue = string | number | boolean;

/** Renderer'ın ürettiği parça. Kimlik ve standart alanları adapter ekler. */
export type EncodedPart = {
  /** Composite parçaları için ad (`icon`, `ring`…); tek parçalı unsurda verilmez. */
  part?: string;
  geometry: GeoJSON.Geometry;
  /** Yalnız stilin okuduğu düz alanlar. Domain verisi (meta) asla. */
  properties: Record<string, PropertyValue>;
};

/** Adapter'ın her parçaya eklediği standart özellikler (renderer'ların stilleri bunları okur). */
export const STANDARD_PROPS = {
  /** Parça kimliği (`promoteId`): feature-state ve updateData bununla çalışır. */
  ID: '_id',
  /** Asıl unsurun id'si: hit-test buradan unsura döner. */
  FEATURE_ID: '_fid',
  /** Efektif opaklık (katman + ataları). */
  OPACITY: '_op',
  /** Global sıra (`*-sort-key`). */
  Z: '_z',
  /**
   * Parçayı çizen renderer'ın kind'ı. Bir render group'un kaynağını birden fazla kind paylaşır;
   * her kind'ın katmanları bununla süzer. Fallback'te (ör. model3d → marker) unsurun kind'ından farklıdır.
   */
  KIND: '_kind',
} as const;

export const partId = (featureId: string, part?: string): string => (part ? `${featureId}#${part}` : featureId);

/** Kaynakta duran parça: son gönderilen özellikler (geometri saklanmaz; değişip değişmediğini maske söyler). */
export type StoredPart = { properties: Record<string, PropertyValue> };

type SourceDiff = Required<Pick<GeoJSONSourceDiff, 'add' | 'update' | 'remove'>>;
type FeatureDiff = NonNullable<GeoJSONSourceDiff['update']>[number];

/** Kaynak başına birikmiş fark; flush sonunda tek `updateData` çağrısına dönüşür. */
export class SourceDiffBuilder {
  readonly add: SourceDiff['add'] = [];
  readonly update: FeatureDiff[] = [];
  readonly remove: (string | number)[] = [];

  get isEmpty(): boolean {
    return this.add.length === 0 && this.update.length === 0 && this.remove.length === 0;
  }

  toDiff(): GeoJSONSourceDiff {
    const diff: GeoJSONSourceDiff = {};
    if (this.remove.length > 0) diff.remove = this.remove;
    if (this.add.length > 0) diff.add = this.add;
    if (this.update.length > 0) diff.update = this.update;
    return diff;
  }
}

/**
 * Var olan parçanın yeni haliyle farkı. Geometri yalnız `geometryChanged` ise gönderilir;
 * özelliklerden yalnız değerleri değişenler (ve kaybolanlar) gönderilir. Fark yoksa `null`.
 */
export function diffPart(
  id: string,
  prev: StoredPart,
  next: EncodedPart & { properties: Record<string, PropertyValue> },
  geometryChanged: boolean,
): FeatureDiff | null {
  const diff: FeatureDiff = { id };
  let changed = false;

  if (geometryChanged) {
    diff.newGeometry = next.geometry;
    changed = true;
  }

  const addOrUpdate: { key: string; value: PropertyValue }[] = [];
  for (const key in next.properties) {
    const value = next.properties[key]!;
    if (!Object.is(prev.properties[key], value)) addOrUpdate.push({ key, value });
  }
  const removed: string[] = [];
  for (const key in prev.properties) if (!(key in next.properties)) removed.push(key);

  if (addOrUpdate.length > 0) {
    diff.addOrUpdateProperties = addOrUpdate;
    changed = true;
  }
  if (removed.length > 0) {
    diff.removeProperties = removed;
    changed = true;
  }
  return changed ? diff : null;
}
