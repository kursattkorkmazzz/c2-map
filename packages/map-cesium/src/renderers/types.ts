// ── Cesium kind renderer sözleşmesi ──────────────────────────────
// Tasarım: plan/design/04-sync-and-rendering.md#cesium-yolu
//
// MapLibre'de renderer veri KODLAR (katman + GeoJSON özelliği), motor çizer. Cesium imperatif bir
// sahne grafiğidir: renderer unsur başına motor nesnesi (billboard, entity, model) KURAR ve günceller.
// Çekirdeğin öngördüğü şekil budur (`AdapterRenderer`: "Cesium: create/update/remove").
//
//   create(rf)            → tutamaç (renderer'ın kendi nesneleri)
//   update(tutamaç, rf)   → yerinde güncelle (`rf.changed` hangi bitlerin değiştiğini söyler)
//   setState(tutamaç, s)  → seçim / hover (veriye dokunmadan)
//   remove(tutamaç)
//
// Toplu iş (koleksiyon kurma, model indirme) `init`'te, mount'ta bir kez.

import type { FeatureKindRegistry, FeatureVisualState, LngLat, RenderFeature } from '@c2/map-core';
import type { CustomDataSource, EntityCollection, PrimitiveCollection, Scene } from 'cesium';

export type CesiumRenderContext = {
  readonly scene: Scene;
  /** Unsur entity'leri (adapter `applyBatch` boyunca olayları askıya alır: toplu güncelleme). */
  readonly entities: EntityCollection;
  /** Renderer'ın kendi koleksiyonları (BillboardCollection …) buraya eklenir. */
  readonly primitives: PrimitiveCollection;
  /** Entity'lerin veri kaynağı (görünürlük / kümeleme gerekirse). */
  readonly dataSource: CustomDataSource;
  readonly kinds: FeatureKindRegistry;
  readonly pixelRatio: number;
  /**
   * Hit-test: tıklanınca bu motor nesnesinin (entity, billboard …) hangi unsura ait olduğu.
   * Renderer her seçilebilir nesneyi kaydeder, kaldırırken siler.
   */
  own(target: object, featureId: string): void;
  disown(target: object): void;
  /**
   * Yüklü araziden zemin yüksekliği (m, elipsoit); arazi henüz yoksa `undefined`. Önbellekli (~100 m hücre,
   * kısa ömür): Cesium'un sorgusu pahalıdır (karonun üçgenlerinde ışın testi), her karede çağrılabilir.
   */
  groundHeight(coord: LngLat): number | undefined;
  /** Sahnenin kare numarası: aynı karede tekrarlanan hesapları önbelleklemek için. */
  frameNumber(): number;
  /** `requestRenderMode`'da yeni kare iste (sürekli çizimde etkisiz). */
  requestRender(): void;
};

export type FullVisualState = FeatureVisualState;

export const EMPTY_STATE: FullVisualState = { selected: false, hovered: false, highlighted: false, stale: false };

export interface CesiumKindRenderer<THandle = unknown> {
  /** Mount'ta bir kez: koleksiyon kur, model indir. */
  init?(ctx: CesiumRenderContext): void | Promise<void>;
  /** Unmount'ta: `init`'te kurulanları kaldır. */
  destroy?(ctx: CesiumRenderContext): void;
  create(rf: RenderFeature, ctx: CesiumRenderContext, state: FullVisualState): THandle | null;
  /** Yerinde güncelleme. Yeni tutamaç dönerse eskisinin yerine geçer. `null` → çizilemez, kaldır. */
  update(handle: THandle, rf: RenderFeature, ctx: CesiumRenderContext, state: FullVisualState): THandle | null | void;
  remove(handle: THandle, ctx: CesiumRenderContext): void;
  setState?(handle: THandle, state: FullVisualState, ctx: CesiumRenderContext): void;
}

/** Seçim / hover vurgusu (MapLibre adapter'ıyla aynı renkler). */
export const SELECTED_COLOR = '#ffffff';
export const HOVER_COLOR = '#9ad0ff';

let entitySeq = 0;
/**
 * Entity id'si: unsur + parça + artan sayı. Sayı ŞART: aynı id ile silinip aynı batch'te (olaylar
 * askıdayken) yeniden eklenen entity'yi Cesium "değişmedi" sayar ve ekranda ESKİSİ kalır
 * (düzenlemede bulundu: kaydedilen şekil haritaya yansımıyordu).
 */
export const entityId = (featureId: string, part: string | number): string => `${featureId}#${part}@${++entitySeq}`;
