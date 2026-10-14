// ── Sahte MapLibre haritası (yalnız testler) ──────────────────────
// `MapLike`'ı bellekte uygular: kaynaklara gelen `updateData` farklarını gerçekten işler
// (içerik sorgulanabilir), katman sırasını tutar, feature-state'i saklar, olay basabilir.

import type { FeatureIdentifier, GeoJSONSourceDiff, LayerSpecification, SourceSpecification } from 'maplibre-gl';
import type { MapImage, MapLike } from '../map-like';

type StoredFeature = { geometry: GeoJSON.Geometry; properties: Record<string, unknown> };

export class FakeSource {
  readonly features = new Map<string, StoredFeature>();
  readonly diffs: GeoJSONSourceDiff[] = [];

  constructor(readonly spec: SourceSpecification) {}

  /** Son `setData` içeriği (önizleme kaynağı). */
  data: GeoJSON.FeatureCollection | null = null;

  setData(data: GeoJSON.FeatureCollection): void {
    this.data = data;
  }

  updateData(diff: GeoJSONSourceDiff): void {
    this.diffs.push(diff);
    // MapLibre sırası: remove → add → update
    for (const id of diff.remove ?? []) this.features.delete(String(id));
    for (const f of diff.add ?? []) {
      const id = String((f.properties as Record<string, unknown>)._id);
      this.features.set(id, { geometry: f.geometry, properties: { ...f.properties } });
    }
    for (const u of diff.update ?? []) {
      const stored = this.features.get(String(u.id));
      if (!stored) continue;
      if (u.newGeometry) stored.geometry = u.newGeometry;
      for (const key of u.removeProperties ?? []) delete stored.properties[key];
      for (const { key, value } of u.addOrUpdateProperties ?? []) stored.properties[key] = value;
    }
  }
}

export class FakeMap implements MapLike {
  readonly sources = new Map<string, FakeSource>();
  /** Çizim sırası: dizinin sonu en üstte. */
  readonly layers: LayerSpecification[] = [];
  readonly featureStates = new Map<string, Record<string, unknown>>();
  readonly images = new Map<string, MapImage>();
  imageResolver: ((id: string) => void | Promise<void>) | null = null;
  removed = false;
  readonly canvas = { style: { cursor: '' } };

  /** `queryRenderedFeatures` sonucu: test, ekrandaki "isabetleri" (katman + unsur id'si) belirler. */
  hits: { layer: string; fid: string }[] = [];
  /** Son sorguda istenen katmanlar (hit-test'in hangi katmanlara baktığını doğrulamak için). */
  lastQueryLayers: string[] = [];

  private center = { lng: 0, lat: 0 };
  private zoom = 0;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  // ── Kaynak / katman ────────────────────────────────────────────

  addSource(id: string, source: SourceSpecification): void {
    if (this.sources.has(id)) throw new Error(`Kaynak zaten var: ${id}`);
    this.sources.set(id, new FakeSource(source));
  }

  getSource(id: string): FakeSource | undefined {
    return this.sources.get(id);
  }

  removeSource(id: string): void {
    if (this.layers.some((l) => 'source' in l && l.source === id)) throw new Error(`Kaynak kullanımda: ${id}`);
    this.sources.delete(id);
  }

  addLayer(layer: LayerSpecification, beforeId?: string): void {
    if (this.layerIndex(layer.id) >= 0) throw new Error(`Katman zaten var: ${layer.id}`);
    if ('source' in layer && typeof layer.source === 'string' && !this.sources.has(layer.source)) {
      throw new Error(`Kaynak yok: ${layer.source}`);
    }
    const at = beforeId === undefined ? -1 : this.layerIndex(beforeId);
    if (beforeId !== undefined && at < 0) throw new Error(`beforeId yok: ${beforeId}`);
    if (at < 0) this.layers.push(layer);
    else this.layers.splice(at, 0, layer);
  }

  getLayer(id: string): LayerSpecification | undefined {
    return this.layers[this.layerIndex(id)];
  }

  moveLayer(id: string, beforeId?: string): void {
    const from = this.layerIndex(id);
    if (from < 0) throw new Error(`Katman yok: ${id}`);
    const [layer] = this.layers.splice(from, 1);
    const at = beforeId === undefined ? -1 : this.layerIndex(beforeId);
    if (at < 0) this.layers.push(layer!);
    else this.layers.splice(at, 0, layer!);
  }

  removeLayer(id: string): void {
    const at = this.layerIndex(id);
    if (at >= 0) this.layers.splice(at, 1);
  }

  setPaintProperty(layerId: string, name: string, value: unknown): void {
    const layer = this.requireLayer(layerId) as { paint?: Record<string, unknown> };
    layer.paint = { ...layer.paint, [name]: value };
  }

  setLayoutProperty(layerId: string, name: string, value: unknown): void {
    const layer = this.requireLayer(layerId) as { layout?: Record<string, unknown> };
    layer.layout = { ...layer.layout, [name]: value };
  }

  private requireLayer(id: string): LayerSpecification {
    const layer = this.getLayer(id);
    if (!layer) throw new Error(`Katman yok: ${id}`);
    return layer;
  }

  /** Katman id'leri çizim sırasıyla (alttan üste). */
  layerOrder(): string[] {
    return this.layers.map((l) => l.id);
  }

  private layerIndex(id: string): number {
    return this.layers.findIndex((l) => l.id === id);
  }

  // ── Durum / sorgu ──────────────────────────────────────────────

  setFeatureState(feature: FeatureIdentifier, state: Record<string, unknown>): void {
    const key = `${feature.source}/${feature.id}`;
    this.featureStates.set(key, { ...this.featureStates.get(key), ...state });
  }

  queryRenderedFeatures(_point: [number, number], options: { layers: string[] }) {
    this.lastQueryLayers = options.layers;
    return this.hits
      .filter((h) => options.layers.includes(h.layer))
      .map((h) => ({ properties: { _fid: h.fid } as Record<string, unknown> }));
  }

  // ── Görüntüler ─────────────────────────────────────────────────

  addImage(id: string, image: MapImage): void {
    this.images.set(id, image);
  }

  hasImage(id: string): boolean {
    return this.images.has(id);
  }

  removeImage(id: string): void {
    this.images.delete(id);
  }

  setMissingStyleImageResolver(resolver: ((id: string) => void | Promise<void>) | null): void {
    this.imageResolver = resolver;
  }

  // ── Olaylar ────────────────────────────────────────────────────

  on(type: string, listener: (event: any) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  off(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Olay bas (test). Fare olayları için `point` ve `lngLat` verilmeli. */
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  // ── Kamera ─────────────────────────────────────────────────────

  jumpTo(options: { center?: unknown; zoom?: number }): void {
    if (Array.isArray(options.center)) this.center = { lng: options.center[0], lat: options.center[1] };
    if (options.zoom !== undefined) this.zoom = options.zoom;
  }

  flyTo(options: { center?: unknown; zoom?: number }): void {
    this.jumpTo(options);
  }

  fitBounds(bounds: [number, number, number, number]): void {
    this.center = { lng: (bounds[0] + bounds[2]) / 2, lat: (bounds[1] + bounds[3]) / 2 };
  }

  getCenter() {
    return this.center;
  }

  getZoom() {
    return this.zoom;
  }

  getBearing() {
    return 0;
  }

  getPitch() {
    return 0;
  }

  getBounds() {
    const { lng, lat } = this.center;
    return { getWest: () => lng - 1, getSouth: () => lat - 1, getEast: () => lng + 1, getNorth: () => lat + 1 };
  }

  project(lngLat: [number, number]) {
    return { x: lngLat[0], y: lngLat[1] };
  }

  unproject(point: [number, number]) {
    return { lng: point[0], lat: point[1] };
  }

  // ── Yaşam döngüsü ──────────────────────────────────────────────

  resize(): void {}

  remove(): void {
    this.removed = true;
  }

  getCanvas() {
    return this.canvas;
  }

  readonly doubleClickZoom = {
    enabled: true,
    enable() {
      this.enabled = true;
    },
    disable() {
      this.enabled = false;
    },
    isEnabled() {
      return this.enabled;
    },
  };

  readonly controls: unknown[] = [];

  addControl(control: { onAdd?(map: FakeMap): unknown }): void {
    this.controls.push(control);
    control.onAdd?.(this);
  }

  removeControl(control: { onRemove?(map: FakeMap): unknown }): void {
    const i = this.controls.indexOf(control);
    if (i >= 0) this.controls.splice(i, 1);
    control.onRemove?.(this);
  }
}
