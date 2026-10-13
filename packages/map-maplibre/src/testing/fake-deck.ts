// ── Sahte deck.gl (testler için; WebGL yok) ──────────────────────
// `MapLibreOverlay` interleaved davranışının adapter'ı ilgilendiren kısmını taklit eder: deck katmanları
// `beforeId`'ye göre MapLibre yığınında taşıyıcı katmanlarda toplanır (@deck.gl/maplibre 9.4
// resolve-layer-groups.js ile aynı kural). Katmanlar yalnız props tutar.

import type { LayerSpecification } from 'maplibre-gl';
import type { DeckModules, DeckOverlayLike } from '../deck/deck-controller';
import type { FakeMap } from './fake-map';

export class FakeLayer {
  constructor(
    readonly kind: string,
    readonly props: Record<string, any>,
  ) {}

  get id(): string {
    return this.props.id;
  }
}

const carrierOf = (layer: FakeLayer) =>
  layer.props.beforeId ? `deck-maplibre-layer-group-before:${layer.props.beforeId}` : 'deck-maplibre-layer-group-last';

export class FakeOverlay implements DeckOverlayLike {
  map: FakeMap | null = null;
  layers: FakeLayer[] = [];
  setPropsCalls = 0;
  finalized = false;
  /** `pickObject` sonucu: test belirler (katman id + indeks). */
  hit: { layerId: string; index: number } | null = null;
  lastPick: { x: number; y: number; layerIds?: string[] } | null = null;
  private carriers = new Map<string, string | undefined>(); // taşıyıcı id → beforeId

  constructor(readonly props: { interleaved: boolean }) {}

  onAdd(map: FakeMap): void {
    this.map = map;
  }

  onRemove(): void {
    for (const id of this.carriers.keys()) this.map?.removeLayer(id);
    this.carriers.clear();
    this.map = null;
  }

  setProps(props: { layers: unknown[] }): void {
    this.setPropsCalls++;
    this.layers = props.layers as FakeLayer[];
    const map = this.map;
    if (!map) return;
    const wanted = new Map(this.layers.map((l) => [carrierOf(l), l.props.beforeId as string | undefined]));
    for (const id of this.carriers.keys()) {
      if (!wanted.has(id)) {
        map.removeLayer(id);
        this.carriers.delete(id);
      }
    }
    for (const [id, beforeId] of wanted) {
      if (!this.carriers.has(id)) {
        map.addLayer({ id, type: 'custom' } as unknown as LayerSpecification, beforeId);
        this.carriers.set(id, beforeId);
      }
    }
    for (const [id, beforeId] of this.carriers) {
      const order = map.layerOrder();
      const expected = beforeId ? order.indexOf(beforeId) : order.length;
      if (expected >= 0 && order.indexOf(id) !== expected - 1) map.moveLayer(id, beforeId);
    }
  }

  pickObject(params: { x: number; y: number; layerIds?: string[] }) {
    this.lastPick = params;
    if (!this.hit || (params.layerIds && !params.layerIds.includes(this.hit.layerId))) return null;
    return { index: this.hit.index, layer: { id: this.hit.layerId } };
  }

  finalize(): void {
    this.finalized = true;
    this.map?.removeControl(this);
  }

  layer(id: string): FakeLayer | undefined {
    return this.layers.find((l) => l.id === id);
  }
}

/** Sahte modüller + oluşturulan overlay'e erişim. */
export function createFakeDeck(): { modules: DeckModules; overlay(): FakeOverlay; created(): boolean } {
  let overlay: FakeOverlay | null = null;
  const modules: DeckModules = {
    MapLibreOverlay: class extends FakeOverlay {
      constructor(props: { interleaved: boolean }) {
        super(props);
        overlay = this;
      }
    },
    IconLayer: class extends FakeLayer {
      constructor(props: Record<string, unknown>) {
        super('icon', props);
      }
    },
    ScatterplotLayer: class extends FakeLayer {
      constructor(props: Record<string, unknown>) {
        super('scatterplot', props);
      }
    },
  };
  return {
    modules,
    created: () => overlay !== null,
    overlay: () => {
      if (!overlay) throw new Error('Overlay oluşturulmadı.');
      return overlay;
    },
  };
}
