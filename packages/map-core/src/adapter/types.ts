// ── MapAdapter sözleşmesi ────────────────────────────────────────
// Tasarım: plan/design/05-adapter-and-events.md
//
// Çekirdek hiçbir harita motorunu tanımaz; motorlar bu sözleşmeyi uygulayan adapter'lardır
// (@c2/map-maplibre, sonra @c2/map-cesium). Adapter her karede en fazla bir kez, birleştirilmiş
// bir `RenderBatch` alır; unsur başına create/update/remove çağrısı yoktur.

import type { Basemap, BasemapSourceType } from "../model/basemap";
import type { Bounds, CameraView } from "../model/camera";
import type { Feature } from "../model/feature";
import type { Geometry, GeometryKind, LngLat } from "../model/geometry";
import type { DrawPreview } from "../draw/types";
import type { MapEventSink } from "../events/event-router";
import type { BasemapProviderRegistry } from "../registry/basemap-provider-registry";
import type { FeatureKindRegistry } from "../registry/feature-kind-registry";
import type { SymbologyRegistry } from "../registry/symbology-registry";
import { FEATURE_CHANGE_ALL } from "../store/change";

// ── Yetenekler ───────────────────────────────────────────────────

export type MapCapabilities = {
  dimension: "2d" | "3d" | "both";
  terrain: boolean;
  models3d: boolean;
  clustering: boolean;
  draw: boolean;
  /** Hover/seçim için veriye dokunmadan boyama (MapLibre feature-state, deck.gl highlight). */
  featureState: boolean;
  supportedFeatureKinds: readonly string[];
  supportedBasemapSources: readonly BasemapSourceType[];
};

// ── RenderBatch ──────────────────────────────────────────────────

/**
 * `RenderFeature.changed` maskesi: unsurun kendi `FEATURE_CHANGE` bitleri (0–7) + MapSync'in
 * hesapladığı efektif değerlerin bitleri (8+). Adapter yalnız ilgili bitler set ise yeniden kodlar.
 */
export const RENDER_CHANGE = {
  /** Efektif opaklık (ataların çarpımı) değişti. */
  OPACITY: 1 << 8,
  /** Global sıra değişti (katman taşındı, feature.z değişti). */
  Z_INDEX: 1 << 9,
  /** Unsur başka bir render group'a geçti. */
  GROUP: 1 << 10,
} as const;

/** Yeni çizilen unsur: her şey "değişmiş" sayılır. */
export const RENDER_CHANGE_ALL =
  FEATURE_CHANGE_ALL | RENDER_CHANGE.OPACITY | RENDER_CHANGE.Z_INDEX | RENDER_CHANGE.GROUP;

/** Motorun ayrı kaynak/katman açtığı alt ağaç (en yakın `renderGroup` ata veya kökün çocuğu). */
export type RenderGroup = {
  id: string;
  /** Grubun kök katmanı. */
  layerId: string;
  /** Gruplar arası çizim sırası (küçük önce/altta). */
  order: number;
};

/** Motora giden "çözülmüş" unsur: efektif değerler hesaplanmış. */
export type RenderFeature = {
  /** Store'daki nesnenin kendisi (adapter kopyalamaz, değiştirmez). */
  feature: Feature;
  groupId: string;
  /** Efektif opaklık (katman ve atalarının çarpımı). */
  opacity: number;
  /** Global sıra: katman sırası × 10.000 + `feature.z`. */
  zIndex: number;
  /** `FEATURE_CHANGE` | `RENDER_CHANGE` bitleri. Yeni çizilen unsurda `RENDER_CHANGE_ALL`. */
  changed: number;
};

export type Diff<T> = {
  upsert: readonly T[];
  remove: readonly string[];
};

export type FeatureVisualState = {
  selected: boolean;
  hovered: boolean;
  highlighted: boolean;
  stale: boolean;
};

/** Veriye dokunmadan görsel durum değişikliği (seçim, hover, vurgu, bayatlık). */
export type FeatureStatePatch = {
  id: string;
  state: Partial<FeatureVisualState>;
};

/** MapSync'in (ve sunum aşamalarının) ürettiği paket — adapter yalnız bunu bilir. */
export type RenderBatch = {
  basemaps?: Diff<Basemap>;
  groups?: Diff<RenderGroup>;
  features?: Diff<RenderFeature>;
  state?: readonly FeatureStatePatch[];
};

export function isEmptyBatch(batch: RenderBatch): boolean {
  const emptyDiff = (d?: Diff<unknown>) => !d || (d.upsert.length === 0 && d.remove.length === 0);
  return (
    emptyDiff(batch.basemaps) &&
    emptyDiff(batch.groups) &&
    emptyDiff(batch.features) &&
    (!batch.state || batch.state.length === 0)
  );
}

// ── Çizim bağlamı ────────────────────────────────────────────────

export interface ImageAtlas {
  /** Anahtar yoksa factory ile üretir ve motora kaydeder; referans sayacını artırır. */
  acquire(
    key: string,
    factory: () => Promise<ImageData | ImageBitmap> | ImageData | ImageBitmap,
  ): void;
  release(key: string): void;
  has(key: string): boolean;
}

/** Renderer'ın çizerken ihtiyaç duyduğu, adapter'ın sağladığı bağlamın motor-bağımsız kısmı. */
export interface RenderContextBase {
  readonly kinds: FeatureKindRegistry;
  readonly symbology: SymbologyRegistry;
  readonly images: ImageAtlas;
  readonly pixelRatio: number;
  requestRepaint(): void;
}

/**
 * Kind → motor-özel çizici. Şekli motora göre değişir (MapLibre: `layers` + `encode`;
 * Cesium: create/update/remove); adapter paketi kendi tipiyle daraltır.
 */
export type AdapterRenderer<_TEngine = unknown> = object;

// ── Adapter ──────────────────────────────────────────────────────

export type MountOptions = {
  initialView: CameraView;
  /** Adapter ham etkileşimleri buraya basar (EventRouter). */
  events: MapEventSink;
  kinds: FeatureKindRegistry;
  symbology: SymbologyRegistry;
  basemapProviders: BasemapProviderRegistry;
};

export interface MapAdapter<TEngine = unknown> {
  readonly capabilities: MapCapabilities;

  // Yaşam döngüsü
  mount(container: HTMLElement, options: MountOptions): Promise<void>;
  unmount(): void;
  resize(): void;
  /** Kaçış kapısı: motorun kendisi (tipli). */
  getEngine(): TEngine;

  // Kamera
  setView(view: CameraView, options?: { animate?: boolean }): void;
  flyTo(view: CameraView, options?: { durationMs?: number }): Promise<void>;
  fitBounds(bounds: Bounds, options?: { paddingPx?: number }): void;
  getView(): CameraView;
  getBounds(): Bounds;
  project(coord: LngLat): { x: number; y: number } | null;
  unproject(point: { x: number; y: number }): LngLat | null;

  /** Tek giriş noktası: MapSync'ten gelen birleştirilmiş paket. */
  applyBatch(batch: RenderBatch): void;

  registerRenderer(kind: string, renderer: AdapterRenderer<TEngine>): void;

  // Çizim + düzenleme (capabilities.draw). Araçlar ve tutamaçlar çekirdekte (`DrawController`,
  // `EditController`, karar #8); adapter yalnız:
  /** Çizim modu: çift tık zoom'u kapat, imleç artı; unsur hover imleci gösterilmez. */
  setDrawMode(active: boolean): void;
  /** Anlık önizleme (store dışında, hemen çizilir). `null` → temizle. */
  setDrawPreview(preview: DrawPreview | null): void;
}
