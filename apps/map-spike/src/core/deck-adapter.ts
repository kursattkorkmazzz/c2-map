// Çekirdeği deck.gl'e bağlayan ince adapter (spike; Faz 1.3'ün taslağı).
// Birlik başına sabit indeks (id → indeks), silmede son eleman boşluğa taşınır (swap-remove).
// Konum / boyut typed array'lerde; değişiklik = birkaç sayı yaz + sarmalayıcıyı yenile + sürüm artır.

import type { LayersList } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Map as MaplibreMap } from 'maplibre-gl';
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
  type LngLat,
  type MapAdapter,
  type MapCapabilities,
  type MapEventSink,
  type MountOptions,
  type RenderBatch,
} from '@c2/map-core';
import { shimMaplibre6Transform } from '../deck-renderer';
import { createMap } from '../map';
import type { SymbolCache } from '../symbology';

const UNITS_LAYER_ID = 'core-deck-units';
const INITIAL_CAPACITY = 1024;

type DeckIcon = { id: string; url: string; width: number; height: number };

const sidcOf = (f: Feature): string => (f.props as { sidc?: string } | undefined)?.sidc ?? '';

export class SpikeDeckAdapter implements MapAdapter<MaplibreMap> {
  readonly capabilities: MapCapabilities = {
    dimension: '2d',
    terrain: false,
    models3d: false,
    clustering: false,
    draw: false,
    featureState: true,
    supportedFeatureKinds: ['milsym'],
    supportedBasemapSources: [],
  };

  /** Son flush'ta değişen unsur sayısı (ölçüm paneli için). */
  lastSent = 0;
  smooth = true;
  durationMs = 1000;

  private map!: MaplibreMap;
  private events!: MapEventSink;
  private readonly overlay = new MapboxOverlay({ interleaved: true, layers: [] });

  // id ↔ indeks
  private readonly indexOf = new Map<string, number>();
  private ids: string[] = [];
  private n = 0;
  private capacity = 0;

  // Birlik başına diziler
  private pos = new Float64Array(0); // ekranda gösterilen [lon, lat]
  private fromPos = new Float64Array(0);
  private toPos = new Float64Array(0);
  private tStart = new Float64Array(0);
  private size = new Float32Array(0);
  private sidc: string[] = [];

  // deck.gl güncelleme sinyalleri
  private data = { length: 0, attributes: {} as Record<string, { value: Float64Array | Float32Array; size: number }> };
  private posVersion = 0;
  private iconVersion = 0;
  private readonly icons = new Map<string, DeckIcon>();

  // Görsel durum (MapSync'in state yamalarından)
  private readonly selected = new Set<string>();
  private hovered: string | null = null;

  constructor(
    private readonly symbols: SymbolCache,
    private readonly onRender: () => void = () => {},
  ) {
    this.grow(INITIAL_CAPACITY);
  }

  async mount(container: HTMLElement, options: MountOptions): Promise<void> {
    this.events = options.events;
    this.map = await createMap(container, this.symbols, { unitLayers: false });
    this.setView(options.initialView);
    shimMaplibre6Transform(this.map);
    this.map.addControl(this.overlay);
    this.wireEvents();
    this.push(true);
  }

  unmount(): void {
    this.map?.remove();
  }

  resize(): void {
    this.map.resize();
  }

  getEngine(): MaplibreMap {
    return this.map;
  }

  // ── Kamera ─────────────────────────────────────────────────────

  setView(view: CameraView): void {
    this.map.jumpTo({ center: [view.center[0], view.center[1]], zoom: view.zoom });
  }

  async flyTo(view: CameraView): Promise<void> {
    this.map.flyTo({ center: [view.center[0], view.center[1]], zoom: view.zoom });
  }

  fitBounds(bounds: Bounds): void {
    this.map.fitBounds([bounds.min[0], bounds.min[1], bounds.max[0], bounds.max[1]]);
  }

  getView(): CameraView {
    const c = this.map.getCenter();
    return { center: [c.lng, c.lat], zoom: this.map.getZoom() };
  }

  getBounds(): Bounds {
    const b = this.map.getBounds();
    return { min: [b.getWest(), b.getSouth()], max: [b.getEast(), b.getNorth()] };
  }

  project(coord: LngLat): { x: number; y: number } {
    return this.map.project([coord[0], coord[1]]);
  }

  unproject(point: { x: number; y: number }): LngLat {
    const ll = this.map.unproject([point.x, point.y]);
    return [ll.lng, ll.lat];
  }

  // ── Çizim ──────────────────────────────────────────────────────

  applyBatch(batch: RenderBatch): void {
    const now = performance.now();
    let structural = false; // birlik eklendi/çıktı → data uzunluğu değişti
    let iconChanged = false;
    let posChanged = false;

    for (const id of batch.features?.remove ?? []) {
      if (this.removeIndex(id)) structural = true;
    }

    for (const rf of batch.features?.upsert ?? []) {
      const { feature, changed } = rf;
      let i = this.indexOf.get(feature.id);
      const isNew = i === undefined;
      if (i === undefined) {
        i = this.appendIndex(feature.id);
        structural = true;
      }
      const all = isNew || changed === RENDER_CHANGE_ALL;

      if (all || changed & FEATURE_CHANGE.GEOMETRY) {
        const [lon, lat] = feature.geometry.kind === 'point' ? feature.geometry.coord : [0, 0];
        if (this.smooth && !isNew) {
          // Ekranda olduğu yerden yeni konuma kay
          this.fromPos[i * 2] = this.pos[i * 2]!;
          this.fromPos[i * 2 + 1] = this.pos[i * 2 + 1]!;
          this.tStart[i] = now;
        } else {
          this.pos[i * 2] = this.fromPos[i * 2] = lon;
          this.pos[i * 2 + 1] = this.fromPos[i * 2 + 1] = lat;
          this.tStart[i] = 0;
        }
        this.toPos[i * 2] = lon;
        this.toPos[i * 2 + 1] = lat;
        posChanged = true;
      }
      if (all || changed & FEATURE_CHANGE.PROPS) {
        const sidc = sidcOf(feature);
        this.sidc[i] = sidc;
        this.size[i] = this.symbols.get(sidc).height;
        iconChanged = true;
      }
    }

    let stateChanged = false;
    for (const patch of batch.state ?? []) {
      if (patch.state.selected === true) this.selected.add(patch.id);
      if (patch.state.selected === false) this.selected.delete(patch.id);
      if (patch.state.hovered === true) this.hovered = patch.id;
      if (patch.state.hovered === false && this.hovered === patch.id) this.hovered = null;
      stateChanged = true;
    }

    this.lastSent = (batch.features?.upsert.length ?? 0) + (batch.features?.remove.length ?? 0);
    if (posChanged || structural) this.posVersion++;
    if (iconChanged || structural) this.iconVersion++;
    if (posChanged || iconChanged || structural || stateChanged) this.push(structural);
  }

  /** Akıcı modda her karede çağrılır: tüm birlikleri ara konuma taşır. */
  animate(now: number): void {
    if (!this.smooth || this.n === 0) return;
    const { pos, fromPos, toPos, tStart, durationMs } = this;
    for (let i = 0; i < this.n; i++) {
      const t = Math.min(1, (now - tStart[i]!) / durationMs);
      pos[i * 2] = fromPos[i * 2]! + (toPos[i * 2]! - fromPos[i * 2]!) * t;
      pos[i * 2 + 1] = fromPos[i * 2 + 1]! + (toPos[i * 2 + 1]! - fromPos[i * 2 + 1]!) * t;
    }
    this.posVersion++;
    this.push(false);
  }

  registerRenderer(_kind: string, _renderer: AdapterRenderer<MaplibreMap>): void {}

  startDraw(): DrawSession {
    throw new Error('Spike adapter çizim desteklemiyor.');
  }

  editFeature(): EditSession {
    throw new Error('Spike adapter düzenleme desteklemiyor.');
  }

  // ── İndeks yönetimi ────────────────────────────────────────────

  private appendIndex(id: string): number {
    if (this.n === this.capacity) this.grow(this.capacity * 2);
    const i = this.n++;
    this.indexOf.set(id, i);
    this.ids[i] = id;
    return i;
  }

  /** Swap-remove: son eleman silinen yere taşınır; diziler sıkı kalır. */
  private removeIndex(id: string): boolean {
    const i = this.indexOf.get(id);
    if (i === undefined) return false;
    const last = --this.n;
    if (i !== last) {
      const movedId = this.ids[last]!;
      this.ids[i] = movedId;
      this.indexOf.set(movedId, i);
      for (const arr of [this.pos, this.fromPos, this.toPos]) {
        arr[i * 2] = arr[last * 2]!;
        arr[i * 2 + 1] = arr[last * 2 + 1]!;
      }
      this.tStart[i] = this.tStart[last]!;
      this.size[i] = this.size[last]!;
      this.sidc[i] = this.sidc[last]!;
    }
    this.indexOf.delete(id);
    this.ids.length = this.n;
    this.sidc.length = this.n;
    this.selected.delete(id);
    if (this.hovered === id) this.hovered = null;
    return true;
  }

  private grow(capacity: number): void {
    const copy64 = (src: Float64Array, len: number) => {
      const next = new Float64Array(len);
      next.set(src.subarray(0, Math.min(src.length, len)));
      return next;
    };
    this.pos = copy64(this.pos, capacity * 2);
    this.fromPos = copy64(this.fromPos, capacity * 2);
    this.toPos = copy64(this.toPos, capacity * 2);
    this.tStart = copy64(this.tStart, capacity);
    const size = new Float32Array(capacity);
    size.set(this.size.subarray(0, Math.min(this.size.length, capacity)));
    this.size = size;
    this.capacity = capacity;
  }

  // ── deck.gl ────────────────────────────────────────────────────

  private iconFor(sidc: string): DeckIcon {
    let icon = this.icons.get(sidc);
    if (!icon) {
      const img = this.symbols.get(sidc);
      icon = { id: sidc, url: this.symbols.dataUrl(sidc), width: img.canvas.width, height: img.canvas.height };
      this.icons.set(sidc, icon);
    }
    return icon;
  }

  private push(lengthChanged: boolean): void {
    if (lengthChanged) this.data = { length: this.n, attributes: {} };
    // Yeni sarmalayıcı nesne → deck.gl diziyi yeniden yükler (aynı referansta atlıyordu).
    this.data.attributes.getPosition = { value: this.pos.subarray(0, this.n * 2), size: 2 };
    this.data.attributes.getSize = { value: this.size.subarray(0, this.n), size: 1 };

    const layers: LayersList = [
      new IconLayer({
        id: UNITS_LAYER_ID,
        data: this.data,
        getIcon: (_: unknown, { index }: { index: number }) => this.iconFor(this.sidc[index]!),
        sizeUnits: 'pixels',
        pickable: true,
        updateTriggers: { getPosition: this.posVersion, getIcon: this.iconVersion, getSize: this.iconVersion },
      }),
    ];

    const marked = [...this.selected].map((id) => ({ id, ring: 24, color: [255, 255, 255, 255] }));
    if (this.hovered && !this.selected.has(this.hovered)) marked.push({ id: this.hovered, ring: 20, color: [154, 208, 255, 255] });
    const visible = marked.filter((m) => this.indexOf.has(m.id));
    if (visible.length > 0) {
      layers.push(
        new ScatterplotLayer({
          id: 'core-deck-marks',
          data: visible,
          getPosition: (m: { id: string }) => {
            const i = this.indexOf.get(m.id)!;
            return [this.pos[i * 2]!, this.pos[i * 2 + 1]!];
          },
          getRadius: (m: { ring: number }) => m.ring,
          getLineColor: (m: { color: number[] }) => m.color as [number, number, number, number],
          radiusUnits: 'pixels',
          stroked: true,
          filled: false,
          lineWidthMinPixels: 2,
          updateTriggers: { getPosition: this.posVersion },
        }),
      );
    }

    this.overlay.setProps({ layers });
  }

  // ── Etkileşim → EventRouter ────────────────────────────────────

  private wireEvents(): void {
    let hovered: string | null = null;
    let pending: { x: number; y: number } | null = null;

    const hit = (point: { x: number; y: number }): string | undefined => {
      const info = this.overlay.pickObject({ x: point.x, y: point.y, radius: 4, layerIds: [UNITS_LAYER_ID] });
      return info && info.index >= 0 ? this.ids[info.index] : undefined;
    };

    this.map.on('mousemove', (e) => {
      if (pending === null) {
        requestAnimationFrame(() => {
          const point = pending!;
          pending = null;
          const id = hit(point) ?? null;
          if (id === hovered) return;
          if (hovered) this.events.emit({ type: MAP_EVENT.POINTER_LEAVE, featureId: hovered });
          hovered = id;
          if (id) this.events.emit({ type: MAP_EVENT.POINTER_ENTER, featureId: id });
          this.map.getCanvas().style.cursor = id ? 'pointer' : '';
        });
      }
      pending = e.point;
    });

    this.map.on('click', (e) => {
      this.events.emit({ type: MAP_EVENT.CLICK, featureId: hit(e.point), coord: [e.lngLat.lng, e.lngLat.lat] });
    });

    this.map.on('moveend', () => this.events.emit({ type: MAP_EVENT.VIEW_CHANGE, view: this.getView() }));
    this.map.on('render', () => this.onRender());
  }
}
