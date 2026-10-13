// Çekirdeği MapLibre GeoJSON kaynağına bağlayan ince adapter (spike; Faz 1.1'in taslağı).
// Unsur id'leri string ("u123") → kaynak `promoteId: 'id'` ile kurulur (Faz 1.5.4: string promoteId
// + updateData davranışının ilk denemesi).

import { Map as MaplibreMap, type GeoJSONSource } from 'maplibre-gl';
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
import { createMap } from '../map';
import type { SymbolCache } from '../symbology';

const SOURCE = 'core-units';
const ICON_LAYER = 'core-units-icon';
const HALO_LAYER = 'core-units-halo';

type GeoJSONFeatureDiff = NonNullable<Parameters<GeoJSONSource['updateData']>[0]['update']>[number];

const sidcOf = (f: Feature): string => (f.props as { sidc?: string } | undefined)?.sidc ?? '';

const toGeoJSON = (f: Feature): GeoJSON.Feature => ({
  type: 'Feature',
  geometry: toGeometry(f),
  properties: { id: f.id, icon: sidcOf(f) },
});

function toGeometry(f: Feature): GeoJSON.Point {
  if (f.geometry.kind !== 'point') throw new Error(`Spike yalnız nokta çizer (${f.id})`);
  return { type: 'Point', coordinates: [f.geometry.coord[0], f.geometry.coord[1]] };
}

export class SpikeMaplibreAdapter implements MapAdapter<MaplibreMap> {
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

  /** Son flush'ta haritaya gönderilen unsur sayısı (ölçüm paneli için). */
  lastSent = 0;

  private map!: MaplibreMap;
  private source!: GeoJSONSource;
  private events!: MapEventSink;
  private readonly inSource = new Set<string>();

  constructor(
    private readonly symbols: SymbolCache,
    private readonly onRender: () => void = () => {},
  ) {}

  async mount(container: HTMLElement, options: MountOptions): Promise<void> {
    this.events = options.events;
    this.map = await createMap(container, this.symbols, { unitLayers: false });
    this.setView(options.initialView);

    this.map.addSource(SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      promoteId: 'id', // string id → feature-state ve updateData için
    });
    this.map.addLayer({
      id: ICON_LAYER,
      type: 'symbol',
      source: SOURCE,
      layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    });
    this.map.addLayer({
      id: HALO_LAYER,
      type: 'circle',
      source: SOURCE,
      paint: {
        'circle-radius': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 24,
          ['boolean', ['feature-state', 'hovered'], false], 20,
          0,
        ],
        'circle-color': 'rgba(0,0,0,0)',
        // Yarıçap 0 olsa da çerçeve çizilir → seçili/hover dışındakilerde tamamen saydam yap.
        'circle-stroke-opacity': [
          'case',
          ['any', ['boolean', ['feature-state', 'selected'], false], ['boolean', ['feature-state', 'hovered'], false]], 1,
          0,
        ],
        'circle-stroke-width': 2,
        'circle-stroke-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ffffff', '#9ad0ff'],
      },
    });
    this.source = this.map.getSource<GeoJSONSource>(SOURCE)!;
    this.wireEvents();
  }

  unmount(): void {
    this.map?.remove();
    this.inSource.clear();
  }

  resize(): void {
    this.map.resize();
  }

  getEngine(): MaplibreMap {
    return this.map;
  }

  // ── Kamera ─────────────────────────────────────────────────────

  setView(view: CameraView): void {
    this.map.jumpTo({
      center: [view.center[0], view.center[1]],
      zoom: view.zoom,
      bearing: view.bearingDeg,
      pitch: view.pitchDeg,
    });
  }

  async flyTo(view: CameraView, options?: { durationMs?: number }): Promise<void> {
    this.map.flyTo({ center: [view.center[0], view.center[1]], zoom: view.zoom, duration: options?.durationMs });
  }

  fitBounds(bounds: Bounds, options?: { paddingPx?: number }): void {
    this.map.fitBounds([bounds.min[0], bounds.min[1], bounds.max[0], bounds.max[1]], { padding: options?.paddingPx });
  }

  getView(): CameraView {
    const c = this.map.getCenter();
    return { center: [c.lng, c.lat], zoom: this.map.getZoom(), bearingDeg: this.map.getBearing(), pitchDeg: this.map.getPitch() };
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
    const remove: string[] = [];
    const add: GeoJSON.Feature[] = [];
    const update: GeoJSONFeatureDiff[] = [];

    for (const id of batch.features?.remove ?? []) {
      if (this.inSource.delete(id)) remove.push(id);
    }
    for (const rf of batch.features?.upsert ?? []) {
      const { feature, changed } = rf;
      if (!this.inSource.has(feature.id)) {
        this.inSource.add(feature.id);
        add.push(toGeoJSON(feature));
        continue;
      }
      // Yalnız değişen alanlar: konum → newGeometry, sembol → icon özelliği.
      const all = changed === RENDER_CHANGE_ALL;
      const diff: GeoJSONFeatureDiff = { id: feature.id };
      if (all || changed & FEATURE_CHANGE.GEOMETRY) diff.newGeometry = toGeometry(feature);
      if (all || changed & FEATURE_CHANGE.PROPS) diff.addOrUpdateProperties = [{ key: 'icon', value: sidcOf(feature) }];
      if (diff.newGeometry || diff.addOrUpdateProperties) update.push(diff);
    }

    this.lastSent = add.length + update.length + remove.length;
    if (this.lastSent > 0) void this.source.updateData({ remove, add, update });

    for (const patch of batch.state ?? []) {
      if (this.inSource.has(patch.id)) this.map.setFeatureState({ source: SOURCE, id: patch.id }, patch.state);
    }
  }

  registerRenderer(_kind: string, _renderer: AdapterRenderer<MaplibreMap>): void {}

  startDraw(): DrawSession {
    throw new Error('Spike adapter çizim desteklemiyor.');
  }

  editFeature(): EditSession {
    throw new Error('Spike adapter düzenleme desteklemiyor.');
  }

  // ── Etkileşim → EventRouter ────────────────────────────────────

  private wireEvents(): void {
    let hovered: string | null = null;
    let pending: { x: number; y: number } | null = null;

    const hit = (point: { x: number; y: number }): string | undefined => {
      const top = this.map.queryRenderedFeatures([point.x, point.y], { layers: [ICON_LAYER] })[0];
      const id = top?.properties?.id;
      return typeof id === 'string' ? id : undefined;
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
