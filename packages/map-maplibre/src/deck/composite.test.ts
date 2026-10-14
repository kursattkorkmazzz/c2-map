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

describe('composite akıcı hareket', () => {
  function manualClock() {
    let now = 1000;
    let queue: ((t: number) => void)[] = [];
    return {
      timing: { now: () => now, requestFrame: (cb: (t: number) => void) => queue.push(cb) },
      frame(ms: number) {
        now += ms;
        const run = queue;
        queue = [];
        for (const cb of run) cb(now);
      },
      advance(ms: number) {
        now += ms;
      },
      get pending() {
        return queue.length;
      },
    };
  }

  const lon = (f: Feature) => (f.geometry as unknown as { coord: number[] }).coord[0]!;
  const glidingRenderer: DeckLayersRenderer = {
    type: 'layers',
    layers: (features, ctx) => [new FakeLayer('body', { id: `${ctx.idPrefix}-body`, data: features.map((f) => ({ featureId: f.feature.id, x: lon(f.feature) })) })],
    interpolate: (from, to, t) => ({ ...to, geometry: { kind: 'point', coord: [lon(from) + (lon(to) - lon(from)) * t, 39] } }),
  };

  async function mountWith(motion: 'on' | 'off') {
    const map = new FakeMap();
    const deck = createFakeDeck();
    const clock = manualClock();
    const adapter = new MaplibreAdapter({
      deckRenderers: { uav: glidingRenderer },
      loadDeck: async () => deck.modules,
      createMap: async () => map,
      motion,
      deckTiming: clock.timing,
    });
    await adapter.mount({} as HTMLElement, {
      initialView: { center: [0, 0] },
      events: { emit: () => {} },
      kinds: new FeatureKindRegistry(),
      symbology: new SymbologyRegistry(),
      basemapProviders: new BasemapProviderRegistry(),
    });
    const x = () => deck.overlay().layers.find((l) => l.id.endsWith('-body'))!.props.data[0].x;
    const send = (lon: number, changed = 1) => adapter.applyBatch({ features: { upsert: [rf(uav('a', lon), { changed })], remove: [] } });
    return { clock, x, send };
  }

  it('ON: mesaj aralığı kadar sürede ekrandaki hâlden yenisine kayar; bitince döngü durur', async () => {
    const { clock, x, send } = await mountWith('on');
    send(30, RENDER_CHANGE_ALL); // ilk: kaymaz
    clock.advance(200); // mesaj aralığı 200 ms
    send(40);
    expect(x()).toBe(30);
    clock.frame(100);
    expect(x()).toBeCloseTo(35, 6);
    clock.frame(120);
    expect(x()).toBe(40);
    expect(clock.pending).toBe(0);
  });

  it('yolun ortasında yeni mesaj: ekrandaki konumdan devam (zıplama yok)', async () => {
    const { clock, x, send } = await mountWith('on');
    send(0, RENDER_CHANGE_ALL);
    clock.advance(200);
    send(10);
    clock.frame(100); // x = 5
    send(20); // yeni hedef; süre = 100 ms (son aralık)
    expect(x()).toBeCloseTo(5, 6);
    clock.frame(50);
    expect(x()).toBeCloseTo(12.5, 6);
  });

  it('OFF: hemen yeni konum', async () => {
    const { clock, x, send } = await mountWith('off');
    send(30, RENDER_CHANGE_ALL);
    clock.advance(200);
    send(40);
    expect(x()).toBe(40);
    expect(clock.pending).toBe(0);
  });
});

describe('interpolateUav', () => {
  it('konum / irtifa doğrusal; yön ve pan en kısa açıdan', async () => {
    const { interpolateUav } = await import('./uav-renderer');
    const a = uav('a', 32, { headingDeg: 350, altitudeM: 1000, sensor: { panDeg: -170, tiltDeg: 40, hfovDeg: 20, vfovDeg: 10 } });
    const b = uav('a', 33, { headingDeg: 10, altitudeM: 2000, sensor: { panDeg: 170, tiltDeg: 60, hfovDeg: 20, vfovDeg: 10 } });
    const mid = interpolateUav(a, b, 0.5);
    const p = mid.props as UavProps;
    expect((mid.geometry as unknown as { coord: number[] }).coord).toEqual([32.5, 39]);
    expect(p.altitudeM).toBe(1500);
    expect(p.headingDeg).toBeCloseTo(0, 9);
    expect(Math.abs(p.sensor!.panDeg)).toBeCloseTo(180, 9);
    expect(p.sensor!.tiltDeg).toBe(50);
    expect(interpolateUav(a, b, 1).props).toMatchObject({ headingDeg: 10, altitudeM: 2000 });
  });
});
