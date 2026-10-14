import {
  BasemapProviderRegistry,
  FeatureKindRegistry,
  GEOMETRY_KIND,
  MAP_EVENT,
  RENDER_CHANGE_ALL,
  SymbologyRegistry,
  type Feature,
  type MapEventSink,
  type RenderFeature,
} from '@c2/map-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MaplibreAdapter } from '../adapter';
import { createFakeDeck, FakeLayer, type FakeOverlay } from '../testing/fake-deck';
import { FakeMap } from '../testing/fake-map';
import type { DeckLayersRenderer } from './deck-controller';
import { uavRenderer, type UavProps } from './uav-renderer';

const uav = (id: string, lon: number, props: Partial<UavProps> = {}): Feature => ({
  id,
  layerId: 'ihalar',
  kind: 'uav',
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [lon, 39] },
  props: { headingDeg: 45, altitudeM: 3000, ...props },
});

const rf = (feature: Feature, over: Partial<RenderFeature> = {}): RenderFeature => ({
  feature,
  groupId: 'g',
  opacity: 1,
  zIndex: 0,
  changed: RENDER_CHANGE_ALL,
  ...over,
});

describe('katman renderer\'ı (composite) — DeckController', () => {
  let map: FakeMap;
  let overlay: FakeOverlay;
  let adapter: MaplibreAdapter;
  let events: MapEventSink & { received: Parameters<MapEventSink['emit']>[0][] };
  const load = vi.fn(async () => {});
  const fake: DeckLayersRenderer = {
    type: 'layers',
    load,
    layers: (features, ctx) => [
      new FakeLayer('body', {
        id: `${ctx.idPrefix}-body`,
        beforeId: ctx.beforeId,
        data: features.map((f) => ({ featureId: f.feature.id })),
      }),
    ],
  };

  beforeEach(async () => {
    map = new FakeMap();
    const deck = createFakeDeck();
    events = { received: [], emit: (e) => events.received.push(e) };
    adapter = new MaplibreAdapter({ deckRenderers: { uav: fake }, loadDeck: async () => deck.modules, createMap: async () => map });
    await adapter.mount({} as HTMLElement, {
      initialView: { center: [0, 0] },
      events,
      kinds: new FeatureKindRegistry(),
      symbology: new SymbologyRegistry(),
      basemapProviders: new BasemapProviderRegistry(),
    });
    overlay = deck.overlay();
  });

  const body = () => overlay.layers.find((l) => l.id.endsWith('-body'));

  it('mount\'ta load() beklenir; unsurlar renderer\'a gruplanarak verilir; beforeId grup sırasından', () => {
    expect(load).toHaveBeenCalledTimes(1);
    adapter.applyBatch({ features: { upsert: [rf(uav('a', 32)), rf(uav('b', 33))], remove: [] } });
    expect(body()!.props.data).toEqual([{ featureId: 'a' }, { featureId: 'b' }]);
    expect(body()!.props.beforeId).toBe('c2-draw-fill');
  });

  it('silinince renderer\'a gitmez; hepsi silinince katman yok', () => {
    adapter.applyBatch({ features: { upsert: [rf(uav('a', 32)), rf(uav('b', 33))], remove: [] } });
    adapter.applyBatch({ features: { upsert: [], remove: ['a'] } });
    expect(body()!.props.data).toEqual([{ featureId: 'b' }]);
    adapter.applyBatch({ features: { upsert: [], remove: ['b'] } });
    expect(body()).toBeUndefined();
  });

  it('seçim: veri nesnesindeki featureId; seçim halkası unsurun konumunda', () => {
    adapter.applyBatch({ features: { upsert: [rf(uav('a', 32))], remove: [] } });
    overlay.hit = { layerId: body()!.id, index: 0 };
    overlay.pickObject = (params) => {
      overlay.lastPick = params;
      return params.layerIds?.includes(body()!.id) ? { index: 0, layer: { id: body()!.id }, object: { featureId: 'a' } } : null;
    };
    map.fire('click', { point: { x: 1, y: 1 }, lngLat: { lng: 32, lat: 39 } });
    expect(events.received.at(-1)).toMatchObject({ type: MAP_EVENT.CLICK, featureId: 'a' });

    adapter.applyBatch({ state: [{ id: 'a', state: { selected: true } }] });
    expect(overlay.layer('c2-deck-marks')!.props.data[0].coord).toEqual([32, 39]);
  });
});

// İlk import (mesh-layers + loaders.gl) Node'da birkaç saniye sürebilir.
describe('uavRenderer (gerçek deck.gl sınıfları, WebGL yok)', { timeout: 30_000 }, () => {
  it('model + koni (4 üçgen, 3B) + iz + çizgiler + etiket; yön / irtifa', async () => {
    const renderer = uavRenderer({ modelUrl: '/models/predator.glb', modelScale: 8 });
    await renderer.load!();
    const layers = renderer.layers(
      [rf(uav('iha-1', 32, { headingDeg: 90, altitudeM: 2500, callsign: 'ANKA-1', sensor: { panDeg: 0, tiltDeg: 45, hfovDeg: 20, vfovDeg: 15 } }))],
      { groupId: 'g', idPrefix: 'p', beforeId: 'x' },
    ) as { id: string; props: Record<string, any> }[];
    const byId = Object.fromEntries(layers.map((l) => [l.id, l]));
    expect(Object.keys(byId)).toEqual(['p-footprint', 'p-cone', 'p-lines', 'p-model', 'p-label']);

    const model = byId['p-model']!.props;
    const d = model.data[0];
    expect(model.getPosition(d)).toEqual([32, 39, 2500]);
    expect(model.getOrientation(d)).toEqual([0, 90, 90]); // 180 − yön (burun +Z)
    expect(model.beforeId).toBe('x');
    expect(d.featureId).toBe('iha-1');

    const cone = byId['p-cone']!.props;
    expect(cone.data).toHaveLength(4);
    expect(cone._full3d).toBe(true);
    expect(cone.data[0].polygon[0]).toEqual([32, 39, 2500]); // tepe İHA'da
    expect(byId['p-footprint']!.props.data[0].polygon).toHaveLength(4);
    expect(byId['p-label']!.props.getText(d)).toBe('ANKA-1\n2500 m');
  });

  it('sensör yoksa koni / iz boş; geçersiz props çizilmez', async () => {
    const renderer = uavRenderer({ modelUrl: 'm.glb' });
    await renderer.load!();
    const layers = renderer.layers([rf(uav('a', 32)), rf({ ...uav('bad', 33), props: {} })], { groupId: 'g', idPrefix: 'p', beforeId: undefined }) as {
      id: string;
      props: Record<string, any>;
    }[];
    const byId = Object.fromEntries(layers.map((l) => [l.id, l]));
    expect(byId['p-cone']!.props.data).toEqual([]);
    expect(byId['p-model']!.props.data.map((x: { featureId: string }) => x.featureId)).toEqual(['a']);
  });
});
