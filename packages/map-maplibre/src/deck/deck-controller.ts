// ── deck.gl denetleyicisi (MaplibreAdapter içinde ikinci çizici) ──
// Tasarım: plan/design/04-sync-and-rendering.md#deckgl-yolu
//
// Canlı / yoğun kind'ler (birlikler) burada çizilir: render group başına bir `IconLayer`, birlik
// başına typed array satırı. deck.gl, MapLibre'ye resmi `@deck.gl/maplibre` paketiyle (MapLibreOverlay,
// interleaved) bağlanır: katmanlar MapLibre yığınına girer, `beforeId` ile doğru yere yerleşir.
// deck.gl sınıfları ve zamanlama dışarıdan verilebilir → testler WebGL'siz koşar.

import { FEATURE_CHANGE, RENDER_CHANGE, RENDER_CHANGE_ALL, type Feature, type FeatureVisualState, type RenderFeature } from '@c2/map-core';
import { representativePoint } from '../geometry';
import type { MapLike } from '../map-like';
import { DeckGroupData, type DeckIcon } from './deck-group';
import { MOTION_MODE, MotionGovernor, type MotionAutoOptions, type MotionMode } from './motion';

/** deck.gl ile çizilen kind'ın tarifi. */
export type DeckKindRenderer = {
  /** Unsurun ikonu. `undefined` → çizilmez (sayaçla raporlanır). */
  icon(feature: Feature): DeckIcon | undefined;
  /** Ekrandaki yükseklik (px). Varsayılan: ikonun piksel yüksekliği. */
  size?(feature: Feature, icon: DeckIcon): number;
};

/** Varsayılan ayarlarla deck.gl ikon renderer'ı. */
export function deckIconRenderer(options: DeckKindRenderer): DeckKindRenderer {
  return options;
}

export type DeckLayersContext = {
  groupId: string;
  /** Bu renderer'ın katman id öneki (benzersiz); katman id'leri `${idPrefix}-…` olmalı. */
  idPrefix: string;
  /** Katmanlara verilecek MapLibre `beforeId` (grup sırası). */
  beforeId: string | undefined;
};

/**
 * Az sayıda, zengin unsur (composite: 3B model + koni + etiket …) için: unsurlarından kendi deck.gl
 * katmanlarını üretir. İkon yolunun aksine typed array yok; her değişiklikte katmanlar baştan
 * kurulur (onlarca unsur için ucuz). Seçim / hover için katman veri nesnelerinde `featureId` olmalı.
 */
export type DeckLayersRenderer = {
  readonly type: 'layers';
  /** Mount'ta bir kez beklenir (ör. katman sınıflarını dinamik import et, modeli ön yükle). */
  load?(): Promise<void>;
  /** Grubun bu renderer'a düşen unsurları → deck.gl katmanları. */
  layers(features: readonly RenderFeature[], ctx: DeckLayersContext): unknown[];
};

export type DeckRenderer = DeckKindRenderer | DeckLayersRenderer;

export const isLayersRenderer = (renderer: DeckRenderer): renderer is DeckLayersRenderer =>
  (renderer as DeckLayersRenderer).type === 'layers';

/** Adapter'ın kullandığı deck.gl yüzü (gerçekte `@deck.gl/maplibre` + `@deck.gl/layers`). */
export interface DeckOverlayLike {
  setProps(props: { layers: unknown[] }): void;
  pickObject(params: { x: number; y: number; radius?: number; layerIds?: string[] }): {
    index: number;
    layer?: { id: string } | null;
    object?: unknown;
  } | null;
  finalize?(): void;
}

export type DeckModules = {
  MapLibreOverlay: new (props: { interleaved: boolean; layers: unknown[] }) => DeckOverlayLike;
  IconLayer: new (props: Record<string, unknown>) => unknown;
  ScatterplotLayer: new (props: Record<string, unknown>) => unknown;
};

export type DeckTiming = {
  now?: () => number;
  requestFrame?: (cb: (time: number) => void) => unknown;
};

export type DeckControllerOptions = {
  motion: MotionMode;
  /** Bir konumdan diğerine kayma süresi (ms) ≈ mesaj aralığı. */
  durationMs: number;
  auto?: MotionAutoOptions;
  /** Grubun deck katmanı hangi MapLibre katmanının altına girer (yoksa en üst). */
  beforeIdFor(groupId: string): string | undefined;
  /** Grupların çizim sırası (deck katmanları kendi aralarında bu sırayla). */
  orderOf(groupId: string): number;
  timing?: DeckTiming;
};

export type DeckStats = {
  /** İkonu olmadığı için çizilmeyen deck unsurları. */
  readonly skippedNoIcon: number;
};

const layerIdOf = (groupId: string) => `c2-deck-${groupId}`;
const MARKS_LAYER = 'c2-deck-marks';
// @deck.gl/maplibre 9.4 layer-utils.js: deck katmanlarının MapLibre tarafındaki grup katmanı id'leri.
const DECK_LAST_GROUP = 'deck-maplibre-layer-group-last';
const DECK_GROUP_BEFORE = 'deck-maplibre-layer-group-before:';

type GroupEntry = {
  data: DeckGroupData;
  layerData: { length: number; attributes: Record<string, unknown> };
  length: number;
  /** Son flush'taki beforeId (`null`: henüz gönderilmedi). */
  beforeId: string | undefined | null;
};

export class DeckController {
  readonly overlay: DeckOverlayLike;
  private readonly groups = new Map<string, GroupEntry>();
  /** Katman renderer'larının unsurları: grup → renderer → id → son RenderFeature. */
  private readonly composites = new Map<string, Map<DeckLayersRenderer, Map<string, RenderFeature>>>();
  /** Son flush'ta katman renderer'larının ürettiği katman id'leri (seçim için). */
  private compositeLayerIds: string[] = [];
  /** Görsel durumu olan (seçili / hover) birlikler → grubu. */
  private readonly marks = new Map<string, { groupId: string; selected: boolean; hovered: boolean }>();
  private dirty = false;
  private mode: MotionMode;
  private readonly governor: MotionGovernor;
  private smoothing: boolean;
  private animating = false;
  private skippedNoIcon = 0;
  private fpsFrames = 0;
  private fpsWindowStart = 0;
  private meterRunning = false;
  private destroyed = false;
  private readonly now: () => number;
  private readonly requestFrame: (cb: (time: number) => void) => unknown;

  constructor(
    private readonly map: MapLike,
    private readonly modules: DeckModules,
    private readonly options: DeckControllerOptions,
  ) {
    this.now = options.timing?.now ?? (() => performance.now());
    this.requestFrame =
      options.timing?.requestFrame ??
      (typeof requestAnimationFrame === 'function'
        ? (cb) => requestAnimationFrame(cb) // bağsız çağrı tarayıcıda "Illegal invocation" verir
        : (cb) => setTimeout(() => cb(this.now()), 16));
    this.governor = new MotionGovernor(options.auto);
    this.mode = options.motion;
    this.smoothing = this.mode === MOTION_MODE.ON || (this.mode === MOTION_MODE.AUTO && this.governor.isActive);

    this.overlay = new modules.MapLibreOverlay({ interleaved: true, layers: [] });
    map.addControl(this.overlay);
    if (this.mode === MOTION_MODE.AUTO) this.startMeter();
  }

  get stats(): DeckStats {
    return { skippedNoIcon: this.skippedNoIcon };
  }

  get motion(): { mode: MotionMode; active: boolean } {
    return { mode: this.mode, active: this.smoothing };
  }

  setMotionMode(mode: MotionMode): void {
    this.mode = mode;
    this.applySmoothing(mode === MOTION_MODE.ON || (mode === MOTION_MODE.AUTO && this.governor.isActive));
    if (mode === MOTION_MODE.AUTO) this.startMeter();
  }

  // ── Unsurlar ───────────────────────────────────────────────────

  /** Unsuru deck tarafında ekler/günceller. İkonu yoksa `false` (çizilmedi). */
  upsert(rf: RenderFeature, renderer: DeckRenderer): boolean {
    const entry = this.groupEntry(rf.groupId);
    if (isLayersRenderer(renderer)) {
      let byRenderer = this.composites.get(rf.groupId);
      if (!byRenderer) this.composites.set(rf.groupId, (byRenderer = new Map()));
      let features = byRenderer.get(renderer);
      if (!features) byRenderer.set(renderer, (features = new Map()));
      features.set(rf.feature.id, rf);
      this.dirty = true;
      return true;
    }
    const isNew = !entry.data.has(rf.feature.id);
    const all = isNew || rf.changed === RENDER_CHANGE_ALL;
    const update: Parameters<DeckGroupData['upsert']>[1] = {};

    if (all || rf.changed & FEATURE_CHANGE.PROPS || rf.changed & FEATURE_CHANGE.STYLE) {
      const icon = renderer.icon(rf.feature);
      if (!icon) {
        this.skippedNoIcon++;
        if (!isNew) this.remove(rf.feature.id, rf.groupId);
        return false;
      }
      update.icon = icon;
      update.size = renderer.size?.(rf.feature, icon) ?? icon.height;
    }
    if (all || rf.changed & FEATURE_CHANGE.GEOMETRY) {
      const [lon, lat] = representativePoint(rf.feature.geometry).coordinates as [number, number];
      update.coord = [lon, lat];
    }
    if (all || rf.changed & RENDER_CHANGE.OPACITY) update.opacity = rf.opacity;

    const smooth = this.smoothing && !all;
    entry.data.upsert(rf.feature.id, update, smooth, this.now());
    if (smooth && update.coord) this.startAnimation();
    this.dirty = true;
    return true;
  }

  remove(featureId: string, groupId: string): void {
    const entry = this.groups.get(groupId);
    if (entry?.data.remove(featureId)) this.dirty = true;
    for (const features of this.composites.get(groupId)?.values() ?? []) if (features.delete(featureId)) this.dirty = true;
    if (this.marks.delete(featureId)) this.dirty = true;
  }

  setState(featureId: string, groupId: string, state: Partial<FeatureVisualState>): void {
    const mark = this.marks.get(featureId) ?? { groupId, selected: false, hovered: false };
    if (state.selected !== undefined) mark.selected = state.selected;
    if (state.hovered !== undefined) mark.hovered = state.hovered;
    if (mark.selected || mark.hovered) this.marks.set(featureId, mark);
    else this.marks.delete(featureId);
    this.dirty = true;
  }

  removeGroup(groupId: string): void {
    if (!this.groups.delete(groupId)) return;
    this.composites.delete(groupId);
    for (const [id, mark] of this.marks) if (mark.groupId === groupId) this.marks.delete(id);
    this.dirty = true;
  }

  /** Grup sırası / beforeId değişti: katmanlar yeniden kurulmalı. */
  invalidateOrder(): void {
    this.dirty = true;
  }

  /** Bekleyen değişiklik varsa deck.gl'e gönderir. */
  flush(): void {
    if (!this.dirty || this.destroyed) return;
    this.dirty = false;
    this.overlay.setProps({ layers: this.buildLayers() });
  }

  /** Ekran noktasındaki en üstteki deck unsuru. */
  pick(point: { x: number; y: number }): string | undefined {
    const iconLayers = new Map([...this.groups.keys()].map((groupId) => [layerIdOf(groupId), groupId]));
    const layerIds = [...iconLayers.keys(), ...this.compositeLayerIds];
    if (layerIds.length === 0) return undefined;
    const info = this.overlay.pickObject({ x: point.x, y: point.y, radius: 4, layerIds });
    if (!info || info.index < 0 || !info.layer) return undefined;
    // Katman renderer'ı: veri nesnesi kendi unsur id'sini taşır
    const objectId = (info.object as { featureId?: unknown } | null | undefined)?.featureId;
    if (typeof objectId === 'string') return objectId;
    const groupId = iconLayers.get(info.layer.id);
    return groupId === undefined ? undefined : this.groups.get(groupId)?.data.ids[info.index];
  }

  /**
   * Grubun deck katmanını MapLibre yığınında taşıyan katmanın id'si (son flush'taki). deck.gl 9.4 aynı
   * `beforeId`'li deck katmanlarını tek bir MapLibre özel katmanında toplar; id'si buradan türer.
   */
  mapLayerIdOf(groupId: string): string | undefined {
    const entry = this.groups.get(groupId);
    if (!entry || entry.beforeId === null) return undefined;
    return entry.beforeId === undefined ? DECK_LAST_GROUP : `${DECK_GROUP_BEFORE}${entry.beforeId}`;
  }

  destroy(): void {
    this.destroyed = true;
    this.overlay.setProps({ layers: [] });
    if (this.overlay.finalize) this.overlay.finalize(); // kendi removeControl'ünü çağırır
    else this.map.removeControl(this.overlay);
  }

  // ── Katmanlar ──────────────────────────────────────────────────

  private groupEntry(groupId: string): GroupEntry {
    let entry = this.groups.get(groupId);
    if (!entry) {
      entry = { data: new DeckGroupData(), layerData: { length: 0, attributes: {} }, length: -1, beforeId: null };
      this.groups.set(groupId, entry);
    }
    return entry;
  }

  private buildLayers(): unknown[] {
    const { IconLayer, ScatterplotLayer } = this.modules;
    const ordered = [...this.groups].sort(([a], [b]) => this.options.orderOf(a) - this.options.orderOf(b));
    const layers: unknown[] = [];
    const compositeLayerIds: string[] = [];

    for (const [groupId, entry] of ordered) {
      const { data } = entry;
      // Uzunluk değişince yeni data nesnesi (deck.gl tüm öznitelikleri yeniden kurar); değişmezse aynı
      // nesne kalır, yalnız sarmalayıcılar yenilenir → ikon ataması her karede yeniden hesaplanmaz.
      if (entry.length !== data.lengthVersion) {
        entry.layerData = { length: data.n, attributes: {} };
        entry.length = data.lengthVersion;
      }
      const n = data.n;
      entry.layerData.attributes.getPosition = { value: data.pos.subarray(0, n * 2), size: 2 };
      entry.layerData.attributes.getSize = { value: data.size.subarray(0, n), size: 1 };
      entry.layerData.attributes.getColor = { value: data.color.subarray(0, n * 4), size: 4, normalized: true };

      entry.beforeId = this.options.beforeIdFor(groupId);

      layers.push(
        new IconLayer({
          id: layerIdOf(groupId),
          data: entry.layerData,
          getIcon: (_: unknown, { index }: { index: number }) => data.icons[index],
          sizeUnits: 'pixels',
          pickable: true,
          beforeId: entry.beforeId,
          updateTriggers: {
            getPosition: data.posVersion,
            getSize: data.styleVersion,
            getColor: data.styleVersion,
            getIcon: data.styleVersion,
          },
        }),
      );

      // Composite unsurlar: aynı grupta, ikonların üstünde
      let index = 0;
      for (const [renderer, features] of this.composites.get(groupId) ?? []) {
        if (features.size === 0) continue;
        const produced = renderer.layers([...features.values()], {
          groupId,
          idPrefix: `${layerIdOf(groupId)}~${index++}`,
          beforeId: entry.beforeId,
        });
        for (const layer of produced) {
          const id = (layer as { id?: unknown }).id;
          if (typeof id === 'string') compositeLayerIds.push(id);
          layers.push(layer);
        }
      }
    }
    this.compositeLayerIds = compositeLayerIds;

    const marks = [...this.marks].flatMap(([id, mark]) => {
      const coord = this.groups.get(mark.groupId)?.data.coordOf(id) ?? this.compositeCoord(id, mark.groupId);
      return coord ? [{ coord, mark }] : [];
    });
    if (marks.length > 0) {
      const posVersion = [...this.groups.values()].reduce((sum, e) => sum + e.data.posVersion, 0);
      layers.push(
        new ScatterplotLayer({
          id: MARKS_LAYER,
          data: marks,
          getPosition: (m: { coord: [number, number] }) => m.coord,
          getRadius: (m: { mark: { selected: boolean } }) => (m.mark.selected ? 24 : 20),
          getLineColor: (m: { mark: { selected: boolean } }) => (m.mark.selected ? [255, 255, 255, 255] : [154, 208, 255, 255]),
          radiusUnits: 'pixels',
          stroked: true,
          filled: false,
          lineWidthMinPixels: 2,
          updateTriggers: { getPosition: posVersion, getRadius: marks.length, getLineColor: marks.length },
        }),
      );
    }
    return layers;
  }

  private compositeCoord(id: string, groupId: string): [number, number] | undefined {
    for (const features of this.composites.get(groupId)?.values() ?? []) {
      const rf = features.get(id);
      if (rf) return representativePoint(rf.feature.geometry).coordinates as [number, number];
    }
    return undefined;
  }

  // ── Akıcı hareket ──────────────────────────────────────────────

  private applySmoothing(active: boolean): void {
    if (active === this.smoothing) return;
    this.smoothing = active;
    if (!active) {
      for (const { data } of this.groups.values()) data.snapToTargets(); // zıplama yok: hedefte dur
      this.dirty = true;
      this.flush();
    }
  }

  private startAnimation(): void {
    if (this.animating) return;
    this.animating = true;
    const tick = (time: number) => {
      if (this.destroyed) return;
      let moving = false;
      for (const { data } of this.groups.values()) moving = data.animate(time, this.options.durationMs) || moving;
      this.dirty = true;
      this.flush();
      if (moving && this.smoothing) this.requestFrame(tick);
      else this.animating = false;
    };
    this.requestFrame(tick);
  }

  /** AUTO: sayfa kare hızını ölçer, saniyede bir karar verir. */
  private startMeter(): void {
    if (this.meterRunning) return;
    this.meterRunning = true;
    this.fpsFrames = 0;
    this.fpsWindowStart = this.now();
    const tick = (time: number) => {
      if (this.destroyed || this.mode !== MOTION_MODE.AUTO) {
        this.meterRunning = false;
        return;
      }
      this.fpsFrames++;
      const elapsed = time - this.fpsWindowStart;
      if (elapsed >= 1000) {
        const fps = (this.fpsFrames * 1000) / elapsed;
        this.fpsFrames = 0;
        this.fpsWindowStart = time;
        if (this.governor.sample(fps, time)) this.applySmoothing(this.governor.isActive);
      }
      this.requestFrame(tick);
    };
    this.requestFrame(tick);
  }
}

/** Gerçek deck.gl modülleri (dinamik import: deck.gl kullanılmıyorsa hiç yüklenmez). */
export async function loadDeckModules(): Promise<DeckModules> {
  const [{ MapLibreOverlay }, { IconLayer, ScatterplotLayer }] = await Promise.all([
    import('@deck.gl/maplibre'),
    import('@deck.gl/layers'),
  ]);
  return {
    MapLibreOverlay: MapLibreOverlay as unknown as DeckModules['MapLibreOverlay'],
    IconLayer: IconLayer as unknown as DeckModules['IconLayer'],
    ScatterplotLayer: ScatterplotLayer as unknown as DeckModules['ScatterplotLayer'],
  };
}
