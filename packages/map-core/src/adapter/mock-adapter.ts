// ── MockAdapter ──────────────────────────────────────────────────
// Motorsuz test adapter'ı: gelen batch'leri sırayla kaydeder ve "ekranda ne var" durumunu
// bellekte tutar. MapSync / görünürlük / birleştirme mantığı gerçek motor olmadan test edilir.

import type { Basemap } from "../model/basemap";
import type { Bounds, CameraView } from "../model/camera";
import type { DrawPreview } from "../draw/types";
import type { LngLat } from "../model/geometry";
import type { MapEventInput, MapEventSink } from "../events/event-router";
import type {
  AdapterRenderer,
  EditSession,
  FeatureVisualState,
  MapAdapter,
  MapCapabilities,
  MountOptions,
  RenderBatch,
  RenderFeature,
  RenderGroup,
} from "./types";

export const MOCK_CAPABILITIES: MapCapabilities = {
  dimension: "2d",
  terrain: false,
  models3d: false,
  clustering: false,
  draw: true,
  featureState: true,
  supportedFeatureKinds: ["vector", "marker", "milsym", "composite"],
  supportedBasemapSources: ["xyz", "wmts", "wms", "tilejson", "vector-style", "image"],
};

export class MockAdapter implements MapAdapter<null> {
  readonly capabilities: MapCapabilities;

  /** Alınan tüm batch'ler (sırayla). */
  readonly batches: RenderBatch[] = [];
  /** "Ekranda" olanlar: batch'ler uygulandıktan sonraki durum. */
  readonly features = new Map<string, RenderFeature>();
  readonly groups = new Map<string, RenderGroup>();
  readonly basemaps = new Map<string, Basemap>();
  readonly states = new Map<string, Partial<FeatureVisualState>>();
  readonly renderers = new Map<string, AdapterRenderer<null>>();

  private sink: MapEventSink | null = null;
  private view: CameraView = { center: [0, 0], zoom: 0 };

  constructor(capabilities: Partial<MapCapabilities> = {}) {
    this.capabilities = { ...MOCK_CAPABILITIES, ...capabilities };
  }

  get mounted(): boolean {
    return this.sink !== null;
  }

  // ── Yaşam döngüsü ──────────────────────────────────────────────

  async mount(_container: HTMLElement, options: MountOptions): Promise<void> {
    this.sink = options.events;
    this.view = options.initialView;
  }

  unmount(): void {
    this.sink = null;
    this.features.clear();
    this.groups.clear();
    this.basemaps.clear();
    this.states.clear();
  }

  resize(): void {}

  getEngine(): null {
    return null;
  }

  // ── Kamera ─────────────────────────────────────────────────────

  setView(view: CameraView): void {
    this.view = { ...this.view, ...view };
  }

  async flyTo(view: CameraView): Promise<void> {
    this.setView(view);
  }

  fitBounds(bounds: Bounds): void {
    const center: LngLat = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2];
    this.setView({ center });
  }

  getView(): CameraView {
    return this.view;
  }

  getBounds(): Bounds {
    const [lon, lat] = this.view.center;
    return { min: [lon - 1, lat - 1], max: [lon + 1, lat + 1] };
  }

  /** Basit özdeşlik projeksiyonu (testlerde ekran = coğrafi). */
  project(coord: LngLat): { x: number; y: number } {
    return { x: coord[0], y: coord[1] };
  }

  unproject(point: { x: number; y: number }): LngLat {
    return [point.x, point.y];
  }

  // ── Çizim ──────────────────────────────────────────────────────

  applyBatch(batch: RenderBatch): void {
    this.batches.push(batch);

    for (const id of batch.basemaps?.remove ?? []) this.basemaps.delete(id);
    for (const b of batch.basemaps?.upsert ?? []) this.basemaps.set(b.id, b);

    for (const id of batch.groups?.remove ?? []) this.groups.delete(id);
    for (const g of batch.groups?.upsert ?? []) this.groups.set(g.id, g);

    for (const id of batch.features?.remove ?? []) this.features.delete(id);
    for (const rf of batch.features?.upsert ?? []) this.features.set(rf.feature.id, rf);

    for (const patch of batch.state ?? []) {
      this.states.set(patch.id, { ...this.states.get(patch.id), ...patch.state });
    }
  }

  registerRenderer(kind: string, renderer: AdapterRenderer<null>): void {
    this.renderers.set(kind, renderer);
  }

  /** Çizim modu açık mı (test gözlemi). */
  drawMode = false;
  /** Son önizleme (test gözlemi); `null` = temiz. */
  drawPreview: DrawPreview | null = null;

  setDrawMode(active: boolean): void {
    this.drawMode = active;
  }

  setDrawPreview(preview: DrawPreview | null): void {
    this.drawPreview = preview;
  }

  editFeature(_id: string): EditSession {
    throw new Error("MockAdapter düzenleme desteklemiyor.");
  }

  // ── Test yardımcıları ──────────────────────────────────────────

  /** Sahte etkileşim: gerçek adapter'ın hit-test sonrası yaptığı gibi olayı router'a basar. */
  emit(event: MapEventInput): void {
    if (!this.sink) throw new Error("MockAdapter mount edilmeden olay basılamaz.");
    this.sink.emit(event);
  }

  /** Kaydedilen batch'leri döner ve listeyi temizler ("son flush'tan beri ne geldi?"). */
  takeBatches(): RenderBatch[] {
    return this.batches.splice(0, this.batches.length);
  }
}
