// ── CesiumAdapter ────────────────────────────────────────────────
// Tasarım: plan/design/05-adapter-and-events.md, plan/phases/phase-5-3d.md
//
// Aynı `MapAdapter` sözleşmesi, 3B küre + arazi. Çekirdek (store, MapSync, EventRouter, çizim /
// düzenleme denetleyicileri) ve React binding'i HİÇ değişmeden bu motorla çalışır.
//
//   applyBatch(batch)
//     altlıklar → ImageryLayer (basemaps.ts), `order`'a göre
//     unsurlar  → kind renderer'ı: create / update / remove (renderers/*); entity olayları batch
//                 boyunca askıda (tek seferde işlenir)
//     durum     → renderer.setState (seçim halkası, siluet, renk)
//   etkileşim  → scene.pick (en üstteki nesne → sahibi olan unsur) → MapSink (EventRouter)
//
// Cesium ion KULLANILMAZ: varsayılan ion görüntüsü kapalı (`baseLayer: false`), arazi ücretsiz
// Terrarium karolarından (terrain.ts), görüntü store'daki altlıklardan (ör. Esri uydu XYZ).

import {
  MAP_EVENT,
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
  type MapEventInput,
  type MapEventSink,
  type MountOptions,
  type RenderBatch,
  type RenderFeature,
  type RenderGroup,
} from '@c2/map-core';
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  CesiumWidget,
  Color,
  CustomDataSource,
  HeadingPitchRange,
  Math as CesiumMath,
  Matrix4,
  PerspectiveFrustum,
  PrimitiveCollection,
  Rectangle,
  SceneTransforms,
  type TerrainProvider,
} from 'cesium';
import { CesiumBasemapController, SUPPORTED_BASEMAP_SOURCES, type BasemapStats } from './basemaps';
import { fromCesiumPitch, fromHeading, rangeToZoom, toCesiumPitch, toHeading, zoomToRange } from './camera';
import { CesiumDrawPreview } from './draw-preview';
import { GroundHeightCache } from './ground-height';
import { EMPTY_STATE, type CesiumKindRenderer, type CesiumRenderContext, type FullVisualState } from './renderers/types';
import { vectorRenderer } from './renderers/vector';
import { terrariumTerrain } from './terrain';

/**
 * Görüntü kalitesi ↔ kare hızı. Ölçüm (Intel UHD, 1400×900, boş sahne): high 16 · balanced ~40 · fast ~58 FPS.
 *   high     Cesium varsayılanı: MSAA 4×, gökyüzü + zemin atmosferi, sis
 *   balanced MSAA yok + FXAA, gökyüzü atmosferi var; zemin atmosferi ve sis yok
 *   fast     balanced + gökyüzü / yıldızlar / güneş yok
 */
export const RENDER_QUALITY = { HIGH: 'high', BALANCED: 'balanced', FAST: 'fast' } as const;
export type RenderQuality = (typeof RENDER_QUALITY)[keyof typeof RENDER_QUALITY];

export type CesiumAdapterOptions = {
  /**
   * Cesium'un statik dosyalarının (Workers, Assets, ThirdParty) adresi → `CESIUM_BASE_URL`.
   * Uygulama bu klasörü sunmalı (`cesium/Build/Cesium`). Verilmezse global değer kullanılır.
   */
  baseUrl?: string;
  /** Arazi. Varsayılan: ücretsiz Terrarium (terrain.ts). `false` → düz elipsoit. */
  terrain?: TerrainProvider | false;
  /** Kind → renderer. Varsayılan: `vector`. Sonradan `registerRenderer` ile de eklenebilir. */
  renderers?: Record<string, CesiumKindRenderer<any>>;
  /** Yalnız değişiklikte çiz (güç tasarrufu). Canlı akışta her güncelleme zaten kare ister. Varsayılan `false`. */
  requestRenderMode?: boolean;
  /** Altlık yokken / karo gelene kadar kürenin rengi. */
  globeColor?: string;
  /** Sağ tıkta tarayıcının menüsünü bastır (varsayılan `true`). */
  suppressContextMenu?: boolean;
  /** Görüntü kalitesi (varsayılan `balanced`). Sonradan `setQuality`. */
  quality?: RenderQuality;
};

export type CesiumAdapterStats = BasemapStats & {
  /** Renderer'ı olmayan / fallback ile de çözülemeyen veya renderer'ın çizemediği unsur güncellemeleri. */
  readonly skippedUnsupported: number;
};

type FeatureRecord = {
  kind: string;
  renderer: CesiumKindRenderer<unknown>;
  handle: unknown;
  groupId: string;
};

/** Sürükleme (kamera döndürme) sonrası gelen tıklamayı yok saymak için eşik (px). */
const CLICK_TOLERANCE_PX = 5;

export class CesiumAdapter implements MapAdapter<CesiumWidget> {
  /** Son `applyBatch`'teki unsur işlemi sayısı (ölçüm için). */
  lastSent = 0;
  /** Geçerli görüntü kalitesi (`setQuality`). */
  quality: RenderQuality = RENDER_QUALITY.BALANCED;

  private widget: CesiumWidget | null = null;
  private ctx: CesiumRenderContext | null = null;
  private basemaps: CesiumBasemapController | null = null;
  private preview: CesiumDrawPreview | null = null;
  private events: MapEventSink | null = null;
  private kinds: FeatureKindRegistry | null = null;
  private drawMode = false;
  private readonly renderers = new Map<string, CesiumKindRenderer<unknown>>();
  private readonly initialized = new Set<CesiumKindRenderer<unknown>>();
  private readonly features = new Map<string, FeatureRecord>();
  private readonly states = new Map<string, FullVisualState>();
  private readonly groups = new Map<string, RenderGroup>();
  /** Motor nesnesi (entity / billboard …) → unsur id'si (hit-test). */
  private readonly owners = new WeakMap<object, string>();
  private readonly detachers: (() => void)[] = [];
  private readonly mutableStats = { skippedUnsupported: 0 };

  constructor(private readonly options: CesiumAdapterOptions = {}) {
    for (const [kind, renderer] of Object.entries(options.renderers ?? { vector: vectorRenderer })) {
      this.renderers.set(kind, renderer);
    }
  }

  get capabilities(): MapCapabilities {
    return {
      dimension: '3d',
      terrain: this.options.terrain !== false,
      models3d: true,
      clustering: false,
      draw: true,
      featureState: true,
      supportedFeatureKinds: [...this.renderers.keys()],
      supportedBasemapSources: SUPPORTED_BASEMAP_SOURCES,
    };
  }

  get stats(): CesiumAdapterStats {
    return { ...this.mutableStats, skippedBasemaps: this.basemaps?.stats.skippedBasemaps ?? 0 };
  }

  // ── Yaşam döngüsü ──────────────────────────────────────────────

  async mount(container: HTMLElement, options: MountOptions): Promise<void> {
    if (this.widget) throw new Error('CesiumAdapter zaten mount edilmiş.');
    if (this.options.baseUrl) (globalThis as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = this.options.baseUrl;
    this.events = options.events;
    this.kinds = options.kinds;

    const terrain = this.options.terrain === undefined ? terrariumTerrain() : this.options.terrain;
    const widget = new CesiumWidget(container, {
      baseLayer: false, // varsayılan = ion görüntüsü (Bing) → KAPALI; altlıklar store'dan
      ...(terrain ? { terrainProvider: terrain } : {}),
      requestRenderMode: this.options.requestRenderMode ?? false,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
    });
    this.widget = widget;
    const scene = widget.scene;
    scene.globe.baseColor = Color.fromCssColorString(this.options.globeColor ?? '#1d232b');
    // Tepe arkasında kalan çizgi / model görünmesin (semboller kendi `disableDepthTestDistance`'ıyla hep görünür).
    scene.globe.depthTestAgainstTerrain = true;

    const dataSource = new CustomDataSource('c2-features');
    await widget.dataSources.add(dataSource);
    this.preview = new CesiumDrawPreview();
    await widget.dataSources.add(this.preview.dataSource);
    const primitives = scene.primitives.add(new PrimitiveCollection()) as PrimitiveCollection;
    this.basemaps = new CesiumBasemapController(widget.imageryLayers, options.basemapProviders);

    // Kare sayacı: unsur güncellemeleri (DataSourceDisplay) çizimden ÖNCE çalışır → çizim sonunda artır.
    let frameNumber = 0;
    this.detachers.push(scene.postRender.addEventListener(() => frameNumber++));
    const ground = new GroundHeightCache((lon, lat) => scene.globe.getHeight(Cartographic.fromDegrees(lon, lat)));
    this.ctx = {
      scene,
      entities: dataSource.entities,
      primitives,
      dataSource,
      kinds: options.kinds,
      pixelRatio: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
      own: (target, featureId) => this.owners.set(target, featureId),
      disown: (target) => this.owners.delete(target),
      groundHeight: (coord) => ground.get(coord),
      frameNumber: () => frameNumber,
      requestRender: () => scene.requestRender(),
    };
    await Promise.all([...this.renderers.values()].map((renderer) => this.initRenderer(renderer)));

    this.setView(options.initialView);
    this.setQuality(this.options.quality ?? RENDER_QUALITY.BALANCED);
    this.wireEvents(widget);
  }

  /** Görüntü kalitesi ↔ kare hızı (`RENDER_QUALITY`). */
  setQuality(quality: RenderQuality): void {
    const scene = this.requireWidget().scene;
    const high = quality === RENDER_QUALITY.HIGH;
    const fast = quality === RENDER_QUALITY.FAST;
    scene.msaaSamples = high ? 4 : 1;
    scene.postProcessStages.fxaa.enabled = !high;
    scene.globe.showGroundAtmosphere = high;
    scene.fog.enabled = high;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = !fast;
    if (scene.skyBox) scene.skyBox.show = !fast;
    if (scene.sun) scene.sun.show = !fast;
    if (scene.moon) scene.moon.show = !fast;
    this.quality = quality;
    scene.requestRender();
  }

  unmount(): void {
    for (const detach of this.detachers.splice(0)) detach();
    if (this.ctx) {
      for (const [id, record] of this.features) {
        record.renderer.remove(record.handle, this.ctx);
        this.features.delete(id);
      }
      for (const renderer of this.initialized) renderer.destroy?.(this.ctx);
    }
    this.initialized.clear();
    this.basemaps?.destroy();
    this.widget?.destroy();
    this.widget = null;
    this.ctx = null;
    this.basemaps = null;
    this.preview = null;
    this.events = null;
    this.states.clear();
    this.groups.clear();
  }

  resize(): void {
    this.requireWidget().resize();
  }

  getEngine(): CesiumWidget {
    return this.requireWidget();
  }

  // ── Kamera ─────────────────────────────────────────────────────

  setView(view: CameraView, options?: { animate?: boolean }): void {
    if (options?.animate) {
      void this.flyTo(view);
      return;
    }
    const { center, offset } = this.cameraTarget(view);
    const camera = this.requireWidget().camera;
    camera.lookAt(center, offset);
    camera.lookAtTransform(Matrix4.IDENTITY); // hedefe kilitli kalmasın: kullanıcı serbestçe gezsin
  }

  flyTo(view: CameraView, options?: { durationMs?: number }): Promise<void> {
    const { center, offset } = this.cameraTarget(view);
    const camera = this.requireWidget().camera;
    return new Promise((resolve) => {
      camera.flyToBoundingSphere(new BoundingSphere(center, 0), {
        offset,
        ...(options?.durationMs !== undefined ? { duration: options.durationMs / 1000 } : {}),
        complete: () => resolve(),
        cancel: () => resolve(),
      });
    });
  }

  fitBounds(bounds: Bounds, options?: { paddingPx?: number }): void {
    const widget = this.requireWidget();
    // Kenar boşluğu: ekran yüksekliğine oranla dikdörtgeni büyüt (yaklaşık).
    const pad = (options?.paddingPx ?? 0) / Math.max(widget.canvas.clientHeight, 1);
    const dLon = (bounds.max[0] - bounds.min[0]) * pad;
    const dLat = (bounds.max[1] - bounds.min[1]) * pad;
    widget.camera.setView({
      destination: Rectangle.fromDegrees(bounds.min[0] - dLon, bounds.min[1] - dLat, bounds.max[0] + dLon, bounds.max[1] + dLat),
    });
  }

  getView(): CameraView {
    const widget = this.requireWidget();
    const camera = widget.camera;
    const canvas = widget.canvas;
    const target = this.pickGlobe(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
    const position = Cartographic.fromCartesian(camera.positionWC);
    const centerCarto = target ? Cartographic.fromCartesian(target) : position;
    const range = target ? Cartesian3.distance(camera.positionWC, target) : position.height;
    const latDeg = CesiumMath.toDegrees(centerCarto.latitude);
    return {
      center: [CesiumMath.toDegrees(centerCarto.longitude), latDeg],
      zoom: rangeToZoom(range, latDeg, canvas.clientHeight, this.fovy()),
      bearingDeg: fromHeading(camera.heading),
      pitchDeg: fromCesiumPitch(camera.pitch),
    };
  }

  getBounds(): Bounds {
    const rect = this.requireWidget().camera.computeViewRectangle();
    if (!rect) return { min: [-180, -90], max: [180, 90] };
    return {
      min: [CesiumMath.toDegrees(rect.west), CesiumMath.toDegrees(rect.south)],
      max: [CesiumMath.toDegrees(rect.east), CesiumMath.toDegrees(rect.north)],
    };
  }

  project(coord: LngLat): { x: number; y: number } | null {
    const widget = this.requireWidget();
    const height = coord[2] ?? this.ctx?.groundHeight(coord) ?? 0;
    const p = SceneTransforms.worldToWindowCoordinates(widget.scene, Cartesian3.fromDegrees(coord[0], coord[1], height));
    return p ? { x: p.x, y: p.y } : null;
  }

  unproject(point: { x: number; y: number }): LngLat | null {
    const hit = this.pickGlobe(new Cartesian2(point.x, point.y));
    if (!hit) return null;
    const c = Cartographic.fromCartesian(hit);
    return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
  }

  // ── Çizim ──────────────────────────────────────────────────────

  applyBatch(batch: RenderBatch): void {
    const ctx = this.requireCtx();

    for (const id of batch.basemaps?.remove ?? []) this.basemaps!.remove(id);
    for (const basemap of batch.basemaps?.upsert ?? []) this.basemaps!.upsert(basemap);

    // 3B'de gruplar ayrı kaynak açmaz: yalnız kayıt (sıra zIndex ile unsura iner).
    for (const group of batch.groups?.upsert ?? []) this.groups.set(group.id, group);

    let sent = 0;
    // Entity eklemek / silmek görselleştiricileri tetikler: batch boyunca biriktir, sonda tek sefer.
    ctx.entities.suspendEvents();
    try {
      for (const id of batch.features?.remove ?? []) {
        this.removeFeature(id);
        sent++;
      }
      for (const rf of batch.features?.upsert ?? []) {
        this.upsertFeature(rf);
        sent++;
      }
    } finally {
      ctx.entities.resumeEvents();
    }
    this.lastSent = sent;

    for (const id of batch.groups?.remove ?? []) this.groups.delete(id);
    for (const patch of batch.state ?? []) this.applyState(patch);
    ctx.requestRender();
  }

  setDrawMode(active: boolean): void {
    this.drawMode = active;
    this.requireWidget().canvas.style.cursor = active ? 'crosshair' : '';
  }

  setDrawPreview(preview: DrawPreview | null): void {
    this.preview?.set(preview);
    this.ctx?.requestRender();
  }

  registerRenderer(kind: string, renderer: AdapterRenderer<CesiumWidget>): void {
    const candidate = renderer as Partial<CesiumKindRenderer<unknown>>;
    if (typeof candidate.create !== 'function' || typeof candidate.update !== 'function' || typeof candidate.remove !== 'function') {
      throw new Error(`"${kind}" için geçersiz renderer: create(), update() ve remove() gerekli.`);
    }
    for (const record of this.features.values()) {
      if (record.kind === kind) throw new Error(`"${kind}" renderer'ı kullanımdayken değiştirilemez.`);
    }
    this.renderers.set(kind, candidate as CesiumKindRenderer<unknown>);
    if (this.ctx) void this.initRenderer(candidate as CesiumKindRenderer<unknown>);
  }

  // ── Unsurlar ───────────────────────────────────────────────────

  private async initRenderer(renderer: CesiumKindRenderer<unknown>): Promise<void> {
    if (this.initialized.has(renderer) || !this.ctx) return;
    this.initialized.add(renderer);
    await renderer.init?.(this.ctx);
  }

  private upsertFeature(rf: RenderFeature): void {
    const ctx = this.requireCtx();
    const id = rf.feature.id;
    const resolved = this.resolveRenderer(rf.feature);
    let record = this.features.get(id);
    if (!resolved) {
      this.mutableStats.skippedUnsupported++;
      if (record) this.removeFeature(id);
      return;
    }
    if (record && record.kind !== resolved.kind) {
      this.removeFeature(id);
      record = undefined;
    }
    const drawRf = resolved.feature === rf.feature ? rf : { ...rf, feature: resolved.feature };
    const state = this.states.get(id) ?? EMPTY_STATE;

    if (!record) {
      const handle = resolved.renderer.create(drawRf, ctx, state);
      if (handle === null) {
        this.mutableStats.skippedUnsupported++;
        return;
      }
      this.features.set(id, { kind: resolved.kind, renderer: resolved.renderer, handle, groupId: rf.groupId });
      return;
    }
    const next = resolved.renderer.update(record.handle, drawRf, ctx, state);
    if (next === null) {
      this.removeFeature(id);
      this.mutableStats.skippedUnsupported++;
    } else if (next !== undefined) {
      record.handle = next;
    }
    record.groupId = rf.groupId;
  }

  private removeFeature(id: string): void {
    const record = this.features.get(id);
    if (!record) return;
    record.renderer.remove(record.handle, this.requireCtx());
    this.features.delete(id);
    this.states.delete(id); // yeniden görünürse MapSync durumu tekrar gönderir
  }

  private applyState(patch: FeatureStatePatch): void {
    const state = { ...(this.states.get(patch.id) ?? EMPTY_STATE), ...patch.state };
    this.states.set(patch.id, state);
    const record = this.features.get(patch.id);
    if (record) record.renderer.setState?.(record.handle, state, this.requireCtx());
  }

  /** Kind'ın renderer'ı; yoksa çekirdeğin fallback zinciriyle desteklenen bir kind'a çevrilir. */
  private resolveRenderer(feature: Feature): { kind: string; renderer: CesiumKindRenderer<unknown>; feature: Feature } | null {
    const direct = this.renderers.get(feature.kind);
    if (direct) return { kind: feature.kind, renderer: direct, feature };
    const resolved = this.kinds?.resolveFor(feature, (kind) => this.renderers.has(kind));
    const renderer = resolved && this.renderers.get(resolved.kind);
    return resolved && renderer ? { kind: resolved.kind, renderer, feature: resolved } : null;
  }

  // ── Kamera yardımcıları ────────────────────────────────────────

  /** CameraView → bakılacak nokta + (heading, pitch, mesafe). Verilmeyen alanlar mevcut görünümden. */
  private cameraTarget(view: CameraView): { center: Cartesian3; offset: HeadingPitchRange } {
    const widget = this.requireWidget();
    const partial = view.zoom === undefined || view.bearingDeg === undefined || view.pitchDeg === undefined;
    const current = partial ? this.safeView() : null;
    const [lon, lat] = view.center;
    const zoom = view.zoom ?? current?.zoom ?? 3;
    const bearing = view.bearingDeg ?? current?.bearingDeg ?? 0;
    const pitch = view.pitchDeg ?? current?.pitchDeg ?? 0;
    // Merkezde yükseklik verildiyse (ör. İHA'nın irtifası) oraya, yoksa zemine bakılır.
    const ground = view.center[2] ?? this.ctx?.groundHeight(view.center) ?? 0;
    const range = zoomToRange(zoom, lat, widget.canvas.clientHeight, this.fovy());
    return {
      center: Cartesian3.fromDegrees(lon, lat, ground),
      offset: new HeadingPitchRange(toHeading(bearing), toCesiumPitch(pitch), range),
    };
  }

  /** Mount sırasında (ilk görünüm) kamera henüz anlamlı değil: hata vermeden `null`. */
  private safeView(): CameraView | null {
    try {
      return this.getView();
    } catch {
      return null;
    }
  }

  private fovy(): number {
    const frustum = this.requireWidget().camera.frustum;
    return frustum instanceof PerspectiveFrustum && frustum.fovy !== undefined ? frustum.fovy : CesiumMath.toRadians(60);
  }

  /** Ekran noktasının arazideki (yoksa elipsoitteki) karşılığı. */
  private pickGlobe(point: Cartesian2): Cartesian3 | undefined {
    const { scene, camera } = this.requireWidget();
    const ray = camera.getPickRay(point);
    return (ray && scene.globe.pick(ray, scene)) ?? camera.pickEllipsoid(point, scene.globe.ellipsoid);
  }

  // ── Etkileşim → EventRouter ────────────────────────────────────

  private wireEvents(widget: CesiumWidget): void {
    const canvas = widget.canvas;
    const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (e: HTMLElementEventMap[K]) => void) => {
      canvas.addEventListener(type, listener);
      this.detachers.push(() => canvas.removeEventListener(type, listener));
    };
    const emit = (input: MapEventInput) => this.events?.emit(input);
    const pointOf = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const pointerOf = (e: MouseEvent) => {
      const screen = pointOf(e);
      const coord = this.unproject(screen);
      return {
        ...(coord ? { coord } : {}),
        screen,
        modifiers: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
        originalEvent: e,
      };
    };

    // Cesium sürükleyerek döndürür / yakınlaştırır: basıp sürüklenen tuş "tıklama" sayılmaz.
    const downAt = new Map<number, { x: number; y: number }>();
    on('pointerdown', (e) => downAt.set(e.button, pointOf(e)));
    const isClick = (e: MouseEvent) => {
      const down = downAt.get(e.button);
      if (!down) return true;
      const p = pointOf(e);
      return Math.hypot(p.x - down.x, p.y - down.y) <= CLICK_TOLERANCE_PX;
    };

    on('click', (e) => {
      if (!isClick(e)) return;
      emit({ type: MAP_EVENT.CLICK, featureId: this.hitTest(pointOf(e)), ...pointerOf(e) });
    });
    on('dblclick', (e) => {
      if (!isClick(e)) return;
      emit({ type: MAP_EVENT.DBLCLICK, featureId: this.hitTest(pointOf(e)), ...pointerOf(e) });
    });
    on('contextmenu', (e) => {
      if (this.options.suppressContextMenu !== false) e.preventDefault();
      if (!isClick(e)) return; // sağ tuşla sürükleme = yakınlaştırma
      emit({ type: MAP_EVENT.CONTEXT_MENU, featureId: this.hitTest(pointOf(e)), ...pointerOf(e) });
    });
    const moveEnd = widget.camera.moveEnd.addEventListener(() => emit({ type: MAP_EVENT.VIEW_CHANGE, view: this.getView() }));
    this.detachers.push(moveEnd);

    // Hover: fare olayları kare başına bire indirilir (scene.pick pahalı); enter/leave yalnız unsur değişince.
    let hovered: string | undefined;
    let pending: PointerEvent | null = null;
    const setHovered = (next: string | undefined) => {
      if (next === hovered) return;
      if (hovered !== undefined) emit({ type: MAP_EVENT.POINTER_LEAVE, featureId: hovered });
      hovered = next;
      if (next !== undefined) emit({ type: MAP_EVENT.POINTER_ENTER, featureId: next });
      if (!this.drawMode) canvas.style.cursor = next === undefined ? '' : 'pointer';
    };
    on('pointermove', (e) => {
      if (pending === null) {
        requestAnimationFrame(() => {
          const event = pending;
          pending = null;
          if (!this.widget || !event) return;
          // Sürükleme sırasında (kamera hareketi) hover / hit-test yapılmaz.
          if (event.buttons === 0) setHovered(this.hitTest(pointOf(event)));
          emit({ type: MAP_EVENT.POINTER_MOVE, ...pointerOf(event) });
        });
      }
      pending = e;
    });
    on('pointerleave', () => setHovered(undefined));
  }

  /** En üstteki seçilebilir motor nesnesinin sahibi olan unsur. */
  private hitTest(point: { x: number; y: number }): string | undefined {
    const widget = this.widget;
    if (!widget) return undefined;
    const picked = widget.scene.pick(new Cartesian2(point.x, point.y)) as { id?: unknown; primitive?: unknown } | undefined;
    if (!picked) return undefined;
    const owner = (key: unknown) => (key !== null && typeof key === 'object' ? this.owners.get(key) : undefined);
    const fid = owner(picked.id) ?? owner(picked.primitive);
    if (fid !== undefined) return fid;
    // Billboard'ların id'si doğrudan unsur id'si (ör. seçim halkası)
    return typeof picked.id === 'string' && this.features.has(picked.id) ? picked.id : undefined;
  }

  private requireWidget(): CesiumWidget {
    if (!this.widget) throw new Error('CesiumAdapter mount edilmedi.');
    return this.widget;
  }

  private requireCtx(): CesiumRenderContext {
    if (!this.ctx) throw new Error('CesiumAdapter mount edilmedi.');
    return this.ctx;
  }
}

export function createCesiumAdapter(options?: CesiumAdapterOptions): CesiumAdapter {
  return new CesiumAdapter(options);
}
