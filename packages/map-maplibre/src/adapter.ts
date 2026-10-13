// ── MaplibreAdapter ──────────────────────────────────────────────
// Tasarım: plan/design/04-sync-and-rendering.md#maplibre-render-group, plan/design/05-adapter-and-events.md
//
//   applyBatch(batch)
//     altlıklar → kaynak + raster katmanı, çapanın altında `order`'a göre (basemaps.ts)
//     gruplar   → render group başına bir GeoJSON kaynağı (promoteId: '_id'); gruplar arası sıra korunur
//     unsurlar  → kind renderer'ı encode eder → önceki encode ile fark → kaynak başına TEK updateData
//     durum     → setFeatureState (veriye dokunmaz)
//   etkileşim → hit-test (yalnız etkileşimli katmanlar) → MapEventSink (EventRouter)
//
// Statik / seyrek değişen kind'ler içindir (kontrol tedbirleri, çizimler; ~10k'ya kadar).
// Canlı birlikler deck.gl renderer'ı ile çizilir (Faz 1.3).

import {
  FEATURE_CHANGE,
  MAP_EVENT,
  RENDER_CHANGE_ALL,
  type AdapterRenderer,
  type Bounds,
  type CameraView,
  type DrawSession,
  type EditSession,
  type Feature,
  type FeatureKindRegistry,
  type FeatureStatePatch,
  type LngLat,
  type MapAdapter,
  type MapCapabilities,
  type MapEventSink,
  type MountOptions,
  type RenderBatch,
  type RenderFeature,
  type RenderGroup,
} from '@c2/map-core';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { BasemapController, SUPPORTED_BASEMAP_SOURCES, type BasemapStats } from './basemaps';
import { partId, SourceDiffBuilder, STANDARD_PROPS, diffPart, type StoredPart } from './encode';
import type { MapImage, MapLike, GeoJSONSourceLike } from './map-like';
import { defaultMarkerRenderer } from './renderers/marker';
import type { MaplibreEncodeContext, MaplibreKindRenderer, MaplibreLayerContext } from './renderers/types';
import { vectorRenderer } from './renderers/vector';

/** Altlık katmanları bunun ALTINA, operasyonel katmanlar ÜSTÜNE eklenir (boş, görünmez katman). */
export const BASEMAP_ANCHOR_LAYER = 'c2-basemap-top';

export type ResolvedImage = { image: MapImage; pixelRatio?: number };

export type MapInit = {
  style: StyleSpecification | string;
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  workerUrl?: string;
  /** Her ağ isteği için (tile, stil…): altlık sağlayıcısının auth header / imzalı URL dönüşümü. */
  transformRequest: (url: string) => { url: string; headers?: Record<string, string> } | undefined;
};

export type MaplibreAdapterOptions = {
  /** Başlangıç stili. Varsayılan: koyu düz arka plan (altlıklar store'dan gelir — Faz 1.2). */
  style?: StyleSpecification | string;
  /**
   * MapLibre worker dosyasının URL'si. Paketleyici worker'ın yolunu bozuyorsa verilmeli
   * (Vite: `import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'`).
   */
  workerUrl?: string;
  /** Stilde adı geçen ama eklenmemiş ikonu üretir (tembel; ekranda görünmeyen ikon üretilmez). */
  resolveImage?: (id: string) => Promise<ResolvedImage | null> | ResolvedImage | null;
  /** Kind → renderer. Varsayılan: `vector` ve `marker`. Sonradan `registerRenderer` ile de eklenebilir. */
  renderers?: Record<string, MaplibreKindRenderer>;
  /** Harita üretici (test için sahte harita verilir). Varsayılan: `maplibre-gl` dinamik import. */
  createMap?: (container: HTMLElement, init: MapInit) => Promise<MapLike>;
};

export type MaplibreAdapterStats = BasemapStats & {
  /** Renderer'ı olmayan ve fallback ile de çözülemeyen (çizilmeyen) unsur güncellemeleri. */
  readonly skippedUnsupported: number;
};

const DEFAULT_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'c2-background', type: 'background', paint: { 'background-color': '#1d232b' } }],
};

type GroupState = {
  group: RenderGroup;
  sourceId: string;
  /** Bu grubun stil katmanları, eklendikleri (çizim) sırasıyla. */
  layerIds: string[];
  interactiveLayerIds: string[];
  kinds: Set<string>;
};

type FeatureRecord = {
  groupId: string;
  /** Çizen renderer'ın kind'ı (fallback'te unsurunkinden farklı olabilir). */
  kind: string;
  parts: Map<string, StoredPart>;
};

const sourceIdOf = (groupId: string) => `c2-src-${groupId}`;

export class MaplibreAdapter implements MapAdapter<MapLike> {
  /** Son `applyBatch`'te kaynaklara gönderilen parça işlemi sayısı (ölçüm için). */
  lastSent = 0;

  private map: MapLike | null = null;
  private basemaps: BasemapController | null = null;
  private events: MapEventSink | null = null;
  private kinds: FeatureKindRegistry | null = null;
  private pixelRatio = 1;
  private readonly renderers = new Map<string, MaplibreKindRenderer>();
  private readonly groups = new Map<string, GroupState>();
  private readonly features = new Map<string, FeatureRecord>();
  private readonly detachers: (() => void)[] = [];
  private readonly mutableStats = { skippedUnsupported: 0 };

  constructor(private readonly options: MaplibreAdapterOptions = {}) {
    const renderers = options.renderers ?? { vector: vectorRenderer, marker: defaultMarkerRenderer };
    for (const [kind, renderer] of Object.entries(renderers)) this.renderers.set(kind, renderer);
  }

  get capabilities(): MapCapabilities {
    return {
      dimension: '2d',
      terrain: false,
      models3d: false,
      clustering: false,
      draw: false,
      featureState: true,
      supportedFeatureKinds: [...this.renderers.keys()],
      supportedBasemapSources: SUPPORTED_BASEMAP_SOURCES,
    };
  }

  get stats(): MaplibreAdapterStats {
    return { ...this.mutableStats, skippedBasemaps: this.basemaps?.stats.skippedBasemaps ?? 0 };
  }

  // ── Yaşam döngüsü ──────────────────────────────────────────────

  async mount(container: HTMLElement, options: MountOptions): Promise<void> {
    if (this.map) throw new Error('MaplibreAdapter zaten mount edilmiş.');
    this.events = options.events;
    this.kinds = options.kinds;
    this.pixelRatio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;

    const view = options.initialView;
    const createMap = this.options.createMap ?? createDefaultMap;
    const map = await createMap(container, {
      style: this.options.style ?? DEFAULT_STYLE,
      center: [view.center[0], view.center[1]],
      zoom: view.zoom ?? 0,
      bearing: view.bearingDeg ?? 0,
      pitch: view.pitchDeg ?? 0,
      workerUrl: this.options.workerUrl,
      // Harita kurulurken verilir ama altlıklar sonradan gelir → o anki altlık listesine bakar.
      transformRequest: (url) => this.basemaps?.transformRequest(url),
    });
    this.map = map;

    map.addLayer({ id: BASEMAP_ANCHOR_LAYER, type: 'background', layout: { visibility: 'none' } });
    this.basemaps = new BasemapController(map, options.basemapProviders, BASEMAP_ANCHOR_LAYER);

    const resolveImage = this.options.resolveImage;
    if (resolveImage) {
      const add = (id: string, resolved: ResolvedImage | null) => {
        if (resolved && !map.hasImage(id)) map.addImage(id, resolved.image, { pixelRatio: resolved.pixelRatio });
      };
      // Senkron sonuç senkron eklenir: Promise döndürmek MapLibre'nin görüntüyü beklemeye almasına
      // (ve karoları yeniden kurmasına) yol açar. Yalnız gerçekten asenkron çözümleyiciler beklenir.
      map.setMissingStyleImageResolver((id) => {
        const result = resolveImage(id);
        if (result instanceof Promise) return result.then((resolved) => add(id, resolved));
        add(id, result);
      });
    }

    this.wireEvents(map);
  }

  unmount(): void {
    for (const detach of this.detachers.splice(0)) detach();
    this.map?.remove();
    this.map = null;
    this.basemaps = null;
    this.events = null;
    this.groups.clear();
    this.features.clear();
  }

  resize(): void {
    this.requireMap().resize();
  }

  getEngine(): MapLike {
    return this.requireMap();
  }

  // ── Kamera ─────────────────────────────────────────────────────

  setView(view: CameraView, options?: { animate?: boolean }): void {
    const target = {
      center: [view.center[0], view.center[1]] as [number, number],
      zoom: view.zoom,
      bearing: view.bearingDeg,
      pitch: view.pitchDeg,
    };
    if (options?.animate) this.requireMap().flyTo(target);
    else this.requireMap().jumpTo(target);
  }

  async flyTo(view: CameraView, options?: { durationMs?: number }): Promise<void> {
    this.requireMap().flyTo({
      center: [view.center[0], view.center[1]],
      zoom: view.zoom,
      bearing: view.bearingDeg,
      pitch: view.pitchDeg,
      duration: options?.durationMs,
    });
  }

  fitBounds(bounds: Bounds, options?: { paddingPx?: number }): void {
    this.requireMap().fitBounds([bounds.min[0], bounds.min[1], bounds.max[0], bounds.max[1]], {
      padding: options?.paddingPx,
    });
  }

  getView(): CameraView {
    const map = this.requireMap();
    const c = map.getCenter();
    return { center: [c.lng, c.lat], zoom: map.getZoom(), bearingDeg: map.getBearing(), pitchDeg: map.getPitch() };
  }

  getBounds(): Bounds {
    const b = this.requireMap().getBounds();
    return { min: [b.getWest(), b.getSouth()], max: [b.getEast(), b.getNorth()] };
  }

  project(coord: LngLat): { x: number; y: number } | null {
    const p = this.requireMap().project([coord[0], coord[1]]);
    return { x: p.x, y: p.y };
  }

  unproject(point: { x: number; y: number }): LngLat | null {
    const ll = this.requireMap().unproject([point.x, point.y]);
    return [ll.lng, ll.lat];
  }

  // ── Çizim ──────────────────────────────────────────────────────

  applyBatch(batch: RenderBatch): void {
    const map = this.requireMap();

    // 0) Altlıklar (çapanın altında; operasyonel katmanlardan bağımsız)
    for (const id of batch.basemaps?.remove ?? []) this.basemaps!.remove(id);
    for (const basemap of batch.basemaps?.upsert ?? []) this.basemaps!.upsert(basemap);

    // 1) Gruplar (önce: unsurlar gruplarının kaynağına yazılacak)
    let reorder = false;
    for (const group of batch.groups?.upsert ?? []) reorder = this.upsertGroup(group) || reorder;
    if (reorder) this.restack();

    // 2) Unsurlar → kaynak başına fark
    const diffs = new Map<string, SourceDiffBuilder>();
    const diffFor = (sourceId: string): SourceDiffBuilder => {
      let diff = diffs.get(sourceId);
      if (!diff) diffs.set(sourceId, (diff = new SourceDiffBuilder()));
      return diff;
    };
    for (const id of batch.features?.remove ?? []) this.removeFeature(id, diffFor);
    for (const rf of batch.features?.upsert ?? []) this.upsertFeature(rf, diffFor);

    let sent = 0;
    for (const [sourceId, diff] of diffs) {
      if (diff.isEmpty) continue;
      (map.getSource(sourceId) as GeoJSONSourceLike).updateData(diff.toDiff());
      sent += diff.add.length + diff.update.length + diff.remove.length;
    }
    this.lastSent = sent;

    // 3) Kaldırılan gruplar (unsurları yukarıda silinmiş olmalı)
    for (const id of batch.groups?.remove ?? []) this.removeGroup(id);

    // 4) Görsel durum
    for (const patch of batch.state ?? []) this.applyState(patch);
  }

  registerRenderer(kind: string, renderer: AdapterRenderer<MapLike>): void {
    const candidate = renderer as Partial<MaplibreKindRenderer>;
    if (typeof candidate.layers !== 'function' || typeof candidate.encode !== 'function') {
      throw new Error(`"${kind}" için geçersiz renderer: layers() ve encode() gerekli.`);
    }
    for (const state of this.groups.values()) {
      if (state.kinds.has(kind)) throw new Error(`"${kind}" renderer'ı kullanımdayken değiştirilemez.`);
    }
    this.renderers.set(kind, candidate as MaplibreKindRenderer);
  }

  startDraw(): DrawSession {
    throw new Error('Çizim Faz 2\'de eklenecek.');
  }

  editFeature(): EditSession {
    throw new Error('Düzenleme Faz 2\'de eklenecek.');
  }

  // ── Gruplar ────────────────────────────────────────────────────

  /** Grubu oluşturur veya günceller. Sıra değiştiyse `true` (yeniden dizilmeli). */
  private upsertGroup(group: RenderGroup): boolean {
    const existing = this.groups.get(group.id);
    if (existing) {
      const reorder = existing.group.order !== group.order;
      existing.group = group;
      return reorder;
    }
    const sourceId = sourceIdOf(group.id);
    this.requireMap().addSource(sourceId, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      promoteId: STANDARD_PROPS.ID,
    });
    this.groups.set(group.id, { group, sourceId, layerIds: [], interactiveLayerIds: [], kinds: new Set() });
    return false;
  }

  /** Grupların katmanlarını `order`'a göre baştan dizer (en üstteki en son). Grup sayısı azdır. */
  private restack(): void {
    const map = this.requireMap();
    const ordered = [...this.groups.values()].sort((a, b) => a.group.order - b.group.order);
    for (const state of ordered) for (const layerId of state.layerIds) map.moveLayer(layerId);
  }

  private removeGroup(id: string): void {
    const state = this.groups.get(id);
    if (!state) return;
    const map = this.requireMap();
    for (const layerId of state.layerIds) map.removeLayer(layerId);
    map.removeSource(state.sourceId);
    this.groups.delete(id);
    for (const [featureId, record] of this.features) if (record.groupId === id) this.features.delete(featureId);
  }

  /** Kind'ın katmanlarını grupta ilk kez ekler: grubun mevcut katmanlarının hemen üstüne. */
  private ensureKindLayers(state: GroupState, kind: string, renderer: MaplibreKindRenderer): void {
    if (state.kinds.has(kind)) return;
    const ctx: MaplibreLayerContext = {
      kind,
      groupId: state.group.id,
      sourceId: state.sourceId,
      layerId: (suffix) => `c2-${state.group.id}-${kind}-${suffix}`,
    };
    const beforeId = this.firstLayerAbove(state.group.order);
    for (const spec of renderer.layers(ctx)) {
      this.requireMap().addLayer(spec, beforeId);
      state.layerIds.push(spec.id);
      if (!isNonInteractive(spec)) state.interactiveLayerIds.push(spec.id);
    }
    state.kinds.add(kind);
  }

  /** `order`'dan büyük en yakın grubun ilk katmanı (yeni katmanlar onun altına girer). */
  private firstLayerAbove(order: number): string | undefined {
    let best: GroupState | undefined;
    for (const state of this.groups.values()) {
      if (state.group.order <= order || state.layerIds.length === 0) continue;
      if (!best || state.group.order < best.group.order) best = state;
    }
    return best?.layerIds[0];
  }

  // ── Unsurlar ───────────────────────────────────────────────────

  private upsertFeature(rf: RenderFeature, diffFor: (sourceId: string) => SourceDiffBuilder): void {
    const id = rf.feature.id;
    let record = this.features.get(id);
    const resolved = this.resolveRenderer(rf.feature);
    if (!resolved) {
      this.mutableStats.skippedUnsupported++;
      if (record) this.removeFeature(id, diffFor);
      return;
    }

    // Grup MapSync'ten gelmemişse (beklenmez) varsayılan sırayla oluştur.
    if (!this.groups.has(rf.groupId)) this.upsertGroup({ id: rf.groupId, layerId: rf.groupId, order: 0 });
    const state = this.groups.get(rf.groupId)!;
    this.ensureKindLayers(state, resolved.kind, resolved.renderer);

    // Grup veya çizen kind değiştiyse eski parçalar eski kaynaktan kalkar, yenileri baştan eklenir.
    if (record && (record.groupId !== rf.groupId || record.kind !== resolved.kind)) {
      this.removeFeature(id, diffFor);
      record = undefined;
    }

    const encodeRf = resolved.feature === rf.feature ? rf : { ...rf, feature: resolved.feature };
    const parts = resolved.renderer.encode(encodeRf, this.encodeContext());
    const geometryChanged = rf.changed === RENDER_CHANGE_ALL || (rf.changed & FEATURE_CHANGE.GEOMETRY) !== 0;
    const diff = diffFor(state.sourceId);
    const nextParts = new Map<string, StoredPart>();

    for (const part of parts) {
      const pid = partId(id, part.part);
      const properties = {
        ...part.properties,
        [STANDARD_PROPS.ID]: pid,
        [STANDARD_PROPS.FEATURE_ID]: id,
        [STANDARD_PROPS.OPACITY]: rf.opacity,
        [STANDARD_PROPS.Z]: rf.zIndex,
        [STANDARD_PROPS.KIND]: resolved.kind,
      };
      const previous = record?.parts.get(pid);
      if (!previous) {
        diff.add.push({ type: 'Feature', geometry: part.geometry, properties });
      } else {
        const update = diffPart(pid, previous, { geometry: part.geometry, properties }, geometryChanged);
        if (update) diff.update.push(update);
      }
      nextParts.set(pid, { properties });
    }
    if (record) for (const pid of record.parts.keys()) if (!nextParts.has(pid)) diff.remove.push(pid);

    this.features.set(id, { groupId: rf.groupId, kind: resolved.kind, parts: nextParts });
  }

  private removeFeature(id: string, diffFor: (sourceId: string) => SourceDiffBuilder): void {
    const record = this.features.get(id);
    if (!record) return;
    const state = this.groups.get(record.groupId);
    if (state) {
      const diff = diffFor(state.sourceId);
      for (const pid of record.parts.keys()) diff.remove.push(pid);
    }
    this.features.delete(id);
  }

  private applyState(patch: FeatureStatePatch): void {
    const record = this.features.get(patch.id);
    const state = record && this.groups.get(record.groupId);
    if (!record || !state) return; // ekranda değil: yeniden görünürse MapSync durumu tekrar gönderir
    for (const pid of record.parts.keys()) {
      this.requireMap().setFeatureState({ source: state.sourceId, id: pid }, patch.state);
    }
  }

  /** Kind'ın renderer'ı; yoksa çekirdeğin fallback zinciriyle desteklenen bir kind'a çevrilir. */
  private resolveRenderer(feature: Feature): { kind: string; renderer: MaplibreKindRenderer; feature: Feature } | null {
    const direct = this.renderers.get(feature.kind);
    if (direct) return { kind: feature.kind, renderer: direct, feature };
    const resolved = this.kinds?.resolveFor(feature, (kind) => this.renderers.has(kind));
    if (!resolved) return null;
    return { kind: resolved.kind, renderer: this.renderers.get(resolved.kind)!, feature: resolved };
  }

  private encodeContext(): MaplibreEncodeContext {
    return { kinds: this.kinds!, pixelRatio: this.pixelRatio };
  }

  // ── Etkileşim → EventRouter ────────────────────────────────────

  private wireEvents(map: MapLike): void {
    const on = (type: string, listener: (event: any) => void) => {
      map.on(type, listener);
      this.detachers.push(() => map.off(type, listener));
    };
    const emit = (input: Parameters<MapEventSink['emit']>[0]) => this.events?.emit(input);
    const pointerOf = (e: any) => ({
      coord: [e.lngLat.lng, e.lngLat.lat] as LngLat,
      screen: { x: e.point.x, y: e.point.y },
      originalEvent: e.originalEvent,
    });

    on('click', (e) => emit({ type: MAP_EVENT.CLICK, featureId: this.hitTest(e.point), ...pointerOf(e) }));
    on('dblclick', (e) => emit({ type: MAP_EVENT.DBLCLICK, featureId: this.hitTest(e.point), ...pointerOf(e) }));
    on('contextmenu', (e) =>
      emit({ type: MAP_EVENT.CONTEXT_MENU, featureId: this.hitTest(e.point), ...pointerOf(e) }),
    );
    on('moveend', () => emit({ type: MAP_EVENT.VIEW_CHANGE, view: this.getView() }));

    // Hover: fare olayları kare başına bire indirilir; enter/leave yalnız unsur değişince.
    let hovered: string | undefined;
    let pending: any = null;
    const raf =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
    const setHovered = (next: string | undefined) => {
      if (next === hovered) return;
      if (hovered !== undefined) emit({ type: MAP_EVENT.POINTER_LEAVE, featureId: hovered });
      hovered = next;
      if (next !== undefined) emit({ type: MAP_EVENT.POINTER_ENTER, featureId: next });
      map.getCanvas().style.cursor = next === undefined ? '' : 'pointer';
    };
    on('mousemove', (e) => {
      if (pending === null) {
        raf(() => {
          const event = pending;
          pending = null;
          if (!this.map || !event) return;
          setHovered(this.hitTest(event.point));
          emit({ type: MAP_EVENT.POINTER_MOVE, ...pointerOf(event) });
        });
      }
      pending = e;
    });
    on('mouseout', () => setHovered(undefined));
  }

  /** En üstteki etkileşimli parçanın unsur id'si. */
  private hitTest(point: { x: number; y: number }): string | undefined {
    const map = this.map;
    if (!map) return undefined;
    const layers: string[] = [];
    for (const state of this.groups.values()) {
      for (const id of state.interactiveLayerIds) if (map.getLayer(id)) layers.push(id);
    }
    if (layers.length === 0) return undefined;
    const fid = map.queryRenderedFeatures([point.x, point.y], { layers })[0]?.properties?.[STANDARD_PROPS.FEATURE_ID];
    return typeof fid === 'string' ? fid : undefined;
  }

  private requireMap(): MapLike {
    if (!this.map) throw new Error('MaplibreAdapter mount edilmedi.');
    return this.map;
  }
}

export function createMaplibreAdapter(options?: MaplibreAdapterOptions): MaplibreAdapter {
  return new MaplibreAdapter(options);
}

function isNonInteractive(spec: LayerSpecification): boolean {
  const metadata = (spec as { metadata?: Record<string, unknown> }).metadata;
  return metadata?.['c2:interactive'] === false;
}

/** Gerçek MapLibre haritası. Dinamik import: Node testleri MapLibre'yi (WebGL) hiç yüklemez. */
async function createDefaultMap(container: HTMLElement, init: MapInit): Promise<MapLike> {
  const maplibre = await import('maplibre-gl');
  if (init.workerUrl) maplibre.setWorkerUrl(init.workerUrl);
  const map = new maplibre.Map({
    container,
    style: init.style,
    center: init.center,
    zoom: init.zoom,
    bearing: init.bearing,
    pitch: init.pitch,
    transformRequest: (url) => init.transformRequest(url),
  });
  await new Promise<void>((resolve) => map.once('load', () => resolve()));
  return map as unknown as MapLike;
}
