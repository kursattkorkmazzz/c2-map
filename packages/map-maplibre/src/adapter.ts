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
// MapLibre katmanları statik / seyrek değişen kind'ler içindir (kontrol tedbirleri, çizimler; ~10k'ya kadar).
// Canlı birlikler `deckRenderers` ile deck.gl'e yönlendirilir (deck/deck-controller.ts): aynı harita,
// aynı render group sırası; deck katmanları MapLibre yığınına `beforeId` ile girer (interleaved).

import {
  FEATURE_CHANGE,
  MAP_EVENT,
  RENDER_CHANGE_ALL,
  type AdapterRenderer,
  type Bounds,
  type CameraView,
  type DrawPreview,
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
import {
  DeckController,
  isLayersRenderer,
  loadDeckModules,
  type DeckModules,
  type DeckRenderer,
  type DeckTiming,
} from './deck/deck-controller';
import { MOTION_MODE, type MotionAutoOptions, type MotionMode } from './deck/motion';
import { DRAW_ANCHOR_LAYER, DRAW_PREVIEW_LAYERS, DRAW_PREVIEW_SOURCE, EMPTY_COLLECTION, previewToGeoJSON } from './draw-preview';
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
  /**
   * deck.gl ile çizilecek kind'ler (canlı, yoğun unsurlar: birlikler). Aynı kind `renderers`'ta da
   * varsa deck.gl önceliklidir. Boşsa deck.gl hiç yüklenmez.
   */
  deckRenderers?: Record<string, DeckRenderer>;
  /** Akıcı hareket: `off` (varsayılan) / `on` / `auto` (kare hızına göre). Sonradan `setMotionMode`. */
  motion?: MotionMode;
  /** Akıcı harekette iki konum arası kayma süresi (ms) ≈ mesaj aralığı. Varsayılan 1000. */
  motionDurationMs?: number;
  motionAuto?: MotionAutoOptions;
  /** deck.gl modülleri (test için sahte verilir). Varsayılan: `@deck.gl/*` dinamik import. */
  loadDeck?: () => Promise<DeckModules>;
  /** Saat / kare zamanlayıcı (test için). */
  deckTiming?: DeckTiming;
  /** Sağ tıkta tarayıcının kendi menüsünü bastır (varsayılan `true`; uygulama `CONTEXT_MENU` ile kendi menüsünü açar). */
  suppressContextMenu?: boolean;
};

export type MaplibreAdapterStats = BasemapStats & {
  /** Renderer'ı olmayan ve fallback ile de çözülemeyen (çizilmeyen) unsur güncellemeleri. */
  readonly skippedUnsupported: number;
  /** deck.gl kind'ı olup ikonu üretilemediği için çizilmeyen unsur güncellemeleri. */
  readonly skippedNoIcon: number;
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
  engine: Engine;
  /** MapLibre kaynağındaki parçalar (deck.gl unsurlarında boş). */
  parts: Map<string, StoredPart>;
};

type Engine = 'maplibre' | 'deck';

type ResolvedRenderer =
  | { engine: 'maplibre'; kind: string; renderer: MaplibreKindRenderer; feature: Feature }
  | { engine: 'deck'; kind: string; renderer: DeckRenderer; feature: Feature };

const sourceIdOf = (groupId: string) => `c2-src-${groupId}`;

export class MaplibreAdapter implements MapAdapter<MapLike> {
  /** Son `applyBatch`'te kaynaklara gönderilen parça işlemi + deck.gl unsur işlemi sayısı (ölçüm için). */
  lastSent = 0;
  private deckSent = 0;

  private map: MapLike | null = null;
  private deck: DeckController | null = null;
  private drawMode = false;
  private basemaps: BasemapController | null = null;
  private events: MapEventSink | null = null;
  private kinds: FeatureKindRegistry | null = null;
  private pixelRatio = 1;
  private readonly renderers = new Map<string, MaplibreKindRenderer>();
  private readonly deckRenderers: Map<string, DeckRenderer>;
  private readonly groups = new Map<string, GroupState>();
  private readonly features = new Map<string, FeatureRecord>();
  private readonly detachers: (() => void)[] = [];
  private readonly mutableStats = { skippedUnsupported: 0 };

  constructor(private readonly options: MaplibreAdapterOptions = {}) {
    const renderers = options.renderers ?? { vector: vectorRenderer, marker: defaultMarkerRenderer };
    for (const [kind, renderer] of Object.entries(renderers)) this.renderers.set(kind, renderer);
    this.deckRenderers = new Map(Object.entries(options.deckRenderers ?? {}));
  }

  get capabilities(): MapCapabilities {
    return {
      dimension: '2d',
      terrain: false,
      models3d: false,
      clustering: false,
      draw: true,
      featureState: true,
      supportedFeatureKinds: [...new Set([...this.renderers.keys(), ...this.deckRenderers.keys()])],
      supportedBasemapSources: SUPPORTED_BASEMAP_SOURCES,
    };
  }

  get stats(): MaplibreAdapterStats {
    return {
      ...this.mutableStats,
      skippedNoIcon: this.deck?.stats.skippedNoIcon ?? 0,
      skippedBasemaps: this.basemaps?.stats.skippedBasemaps ?? 0,
    };
  }

  /** Akıcı hareketin modu ve şu an açık olup olmadığı (AUTO'da kare hızına göre değişir). */
  get motion(): { mode: MotionMode; active: boolean } {
    return this.deck?.motion ?? { mode: this.options.motion ?? MOTION_MODE.OFF, active: false };
  }

  setMotionMode(mode: MotionMode): void {
    this.deck?.setMotionMode(mode);
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
    // Çizim önizlemesi en üstte, kalıcı; ilk katmanı operasyonel katmanların üst çapası.
    map.addSource(DRAW_PREVIEW_SOURCE, { type: 'geojson', data: EMPTY_COLLECTION });
    for (const layer of DRAW_PREVIEW_LAYERS) map.addLayer(layer);
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

    if (this.deckRenderers.size > 0) {
      const modules = await (this.options.loadDeck ?? loadDeckModules)();
      // Katman renderer'ları (composite: 3B model …) kendi bağımlılıklarını yükler.
      await Promise.all([...this.deckRenderers.values()].filter(isLayersRenderer).map((r) => r.load?.()));
      this.deck = new DeckController(map, modules, {
        motion: this.options.motion ?? MOTION_MODE.OFF,
        durationMs: this.options.motionDurationMs ?? 1000,
        auto: this.options.motionAuto,
        timing: this.options.deckTiming,
        // deck katmanı grubun MapLibre katmanlarının üstüne, üst grubunkilerin altına girer.
        beforeIdFor: (groupId) => this.firstLayerAbove(this.groups.get(groupId)?.group.order ?? 0, false),
        orderOf: (groupId) => this.groups.get(groupId)?.group.order ?? 0,
      });
    }

    this.wireEvents(map);
  }

  unmount(): void {
    for (const detach of this.detachers.splice(0)) detach();
    this.deck?.destroy();
    this.deck = null;
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
    if (reorder) {
      this.restack();
      this.deck?.invalidateOrder();
    }

    // 2) Unsurlar → kaynak başına fark
    const diffs = new Map<string, SourceDiffBuilder>();
    const diffFor = (sourceId: string): SourceDiffBuilder => {
      let diff = diffs.get(sourceId);
      if (!diff) diffs.set(sourceId, (diff = new SourceDiffBuilder()));
      return diff;
    };
    this.deckSent = 0;
    for (const id of batch.features?.remove ?? []) this.removeFeature(id, diffFor);
    for (const rf of batch.features?.upsert ?? []) this.upsertFeature(rf, diffFor);

    let sent = this.deckSent;
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

    // 5) deck.gl: tüm değişiklikler tek setProps ile
    this.deck?.flush();
  }

  // ── Çizim (araçlar çekirdekte; burada yalnız mod + önizleme) ──

  setDrawMode(active: boolean): void {
    const map = this.requireMap();
    this.drawMode = active;
    if (active) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    map.getCanvas().style.cursor = active ? 'crosshair' : '';
  }

  setDrawPreview(preview: DrawPreview | null): void {
    (this.requireMap().getSource(DRAW_PREVIEW_SOURCE) as GeoJSONSourceLike).setData(previewToGeoJSON(preview));
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
    for (const state of ordered) for (const layerId of state.layerIds) map.moveLayer(layerId, DRAW_ANCHOR_LAYER);
  }

  private removeGroup(id: string): void {
    const state = this.groups.get(id);
    if (!state) return;
    const map = this.requireMap();
    for (const layerId of state.layerIds) map.removeLayer(layerId);
    map.removeSource(state.sourceId);
    this.groups.delete(id);
    this.deck?.removeGroup(id);
    this.deck?.invalidateOrder();
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
    const beforeId = this.firstLayerAbove(state.group.order, true);
    for (const spec of renderer.layers(ctx)) {
      this.requireMap().addLayer(spec, beforeId);
      state.layerIds.push(spec.id);
      if (!isNonInteractive(spec)) state.interactiveLayerIds.push(spec.id);
    }
    state.kinds.add(kind);
    this.deck?.invalidateOrder(); // alt grubun deck katmanı artık bu katmanların altına girmeli
  }

  /**
   * `order`'dan büyük en yakın grubun en alttaki katmanı (yeni katmanlar onun altına girer); yoksa
   * çizim önizlemesinin çapası (operasyonel katmanlar hep önizlemenin altında).
   * `withDeck`: üst grubun yalnız deck.gl katmanı varsa onun MapLibre'deki taşıyıcısı da sayılır. deck
   * katmanlarının kendi `beforeId`'si yalnız MapLibre katmanlarına bakar: deck.gl aynı `beforeId`'li
   * katmanları tek taşıyıcıda topladığından, taşıyıcıya göre konumlanmak döngüsel olurdu.
   */
  private firstLayerAbove(order: number, withDeck: boolean): string {
    const map = this.requireMap();
    let best: { order: number; id: string } | undefined;
    for (const state of this.groups.values()) {
      if (state.group.order <= order || (best && state.group.order >= best.order)) continue;
      let id = state.layerIds[0];
      if (id === undefined && withDeck) {
        const deckLayer = this.deck?.mapLayerIdOf(state.group.id);
        if (deckLayer && map.getLayer(deckLayer)) id = deckLayer;
      }
      if (id !== undefined) best = { order: state.group.order, id };
    }
    return best?.id ?? DRAW_ANCHOR_LAYER;
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

    // Grup veya çizen kind değiştiyse eski parçalar eski kaynaktan kalkar, yenileri baştan eklenir.
    if (record && (record.groupId !== rf.groupId || record.kind !== resolved.kind)) {
      this.removeFeature(id, diffFor);
      record = undefined;
    }

    const encodeRf = resolved.feature === rf.feature ? rf : { ...rf, feature: resolved.feature };
    if (resolved.engine === 'deck') {
      this.deckSent++;
      if (this.deck!.upsert(encodeRf, resolved.renderer)) {
        this.features.set(id, { groupId: rf.groupId, kind: resolved.kind, engine: 'deck', parts: new Map() });
      } else {
        this.features.delete(id); // ikonsuz: denetleyici zaten kaldırdı
      }
      return;
    }

    this.ensureKindLayers(state, resolved.kind, resolved.renderer);
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

    this.features.set(id, { groupId: rf.groupId, kind: resolved.kind, engine: 'maplibre', parts: nextParts });
  }

  private removeFeature(id: string, diffFor: (sourceId: string) => SourceDiffBuilder): void {
    const record = this.features.get(id);
    if (!record) return;
    if (record.engine === 'deck') {
      this.deckSent++;
      this.deck?.remove(id, record.groupId);
      this.features.delete(id);
      return;
    }
    const state = this.groups.get(record.groupId);
    if (state) {
      const diff = diffFor(state.sourceId);
      for (const pid of record.parts.keys()) diff.remove.push(pid);
    }
    this.features.delete(id);
  }

  private applyState(patch: FeatureStatePatch): void {
    const record = this.features.get(patch.id);
    if (record?.engine === 'deck') {
      this.deck?.setState(patch.id, record.groupId, patch.state);
      return;
    }
    const state = record && this.groups.get(record.groupId);
    if (!record || !state) return; // ekranda değil: yeniden görünürse MapSync durumu tekrar gönderir
    for (const pid of record.parts.keys()) {
      this.requireMap().setFeatureState({ source: state.sourceId, id: pid }, patch.state);
    }
  }

  /** Kind'ın renderer'ı; yoksa çekirdeğin fallback zinciriyle desteklenen bir kind'a çevrilir. */
  private resolveRenderer(feature: Feature): ResolvedRenderer | null {
    const direct = this.rendererFor(feature.kind, feature);
    if (direct) return direct;
    const resolved = this.kinds?.resolveFor(feature, (kind) => this.deckRenderers.has(kind) || this.renderers.has(kind));
    return resolved ? this.rendererFor(resolved.kind, resolved) : null;
  }

  private rendererFor(kind: string, feature: Feature): ResolvedRenderer | null {
    const deck = this.deckRenderers.get(kind);
    if (deck) return { engine: 'deck', kind, renderer: deck, feature };
    const renderer = this.renderers.get(kind);
    return renderer ? { engine: 'maplibre', kind, renderer, feature } : null;
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
    const pointerOf = (e: any) => {
      const original = e.originalEvent as Partial<MouseEvent> | undefined;
      return {
        coord: [e.lngLat.lng, e.lngLat.lat] as LngLat,
        screen: { x: e.point.x, y: e.point.y },
        modifiers: {
          shift: original?.shiftKey ?? false,
          ctrl: original?.ctrlKey ?? false,
          alt: original?.altKey ?? false,
          meta: original?.metaKey ?? false,
        },
        originalEvent: e.originalEvent,
      };
    };

    on('click', (e) => emit({ type: MAP_EVENT.CLICK, featureId: this.hitTest(e.point), ...pointerOf(e) }));
    on('dblclick', (e) => emit({ type: MAP_EVENT.DBLCLICK, featureId: this.hitTest(e.point), ...pointerOf(e) }));
    on('contextmenu', (e) => {
      // Uygulama kendi menüsünü açar; tarayıcınınki üstüne çıkmasın.
      if (this.options.suppressContextMenu !== false) (e.originalEvent as Event | undefined)?.preventDefault?.();
      emit({ type: MAP_EVENT.CONTEXT_MENU, featureId: this.hitTest(e.point), ...pointerOf(e) });
    });
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
      if (!this.drawMode) map.getCanvas().style.cursor = next === undefined ? '' : 'pointer';
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

  /** En üstteki etkileşimli unsurun id'si. Önce deck.gl (birlikler genelde en üstte), sonra MapLibre. */
  private hitTest(point: { x: number; y: number }): string | undefined {
    const map = this.map;
    if (!map) return undefined;
    const deckHit = this.deck?.pick(point);
    if (deckHit !== undefined) return deckHit;
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
