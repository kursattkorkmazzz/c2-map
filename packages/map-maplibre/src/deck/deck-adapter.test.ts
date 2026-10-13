import {
  BasemapProviderRegistry,
  FEATURE_CHANGE,
  FeatureKindRegistry,
  GEOMETRY_KIND,
  MAP_EVENT,
  RENDER_CHANGE,
  RENDER_CHANGE_ALL,
  SymbologyRegistry,
  type Feature,
  type MapEventSink,
  type RenderFeature,
} from '@c2/map-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MaplibreAdapter, type MaplibreAdapterOptions } from '../adapter';
import { vectorRenderer } from '../renderers/vector';
import { createFakeDeck, type FakeOverlay } from '../testing/fake-deck';
import { FakeMap } from '../testing/fake-map';
import type { DeckKindRenderer } from './deck-controller';
import { MOTION_MODE } from './motion';

const container = {} as HTMLElement;

const unit = (id: string, lon: number, sidc = 'S1'): Feature => ({
  id,
  layerId: 'birlikler',
  kind: 'milsym',
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [lon, 39] },
  props: { sidc },
});

const polygon = (id: string): Feature => ({
  id,
  layerId: 'kontrol',
  kind: 'vector',
  geometry: { kind: GEOMETRY_KIND.POLYGON, rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
});

const rf = (feature: Feature, over: Partial<RenderFeature> = {}): RenderFeature => ({
  feature,
  groupId: 'units',
  opacity: 1,
  zIndex: 10_000,
  changed: RENDER_CHANGE_ALL,
  ...over,
});

const milsym: DeckKindRenderer = {
  icon: (f) => {
    const sidc = (f.props as { sidc?: string } | undefined)?.sidc;
    return sidc ? { id: sidc, url: `data:${sidc}`, width: 40, height: 30 } : undefined;
  },
};

/** Elle ilerletilen saat ve kare kuyruğu. */
function manualClock() {
  let now = 0;
  let queue: ((t: number) => void)[] = [];
  return {
    timing: { now: () => now, requestFrame: (cb: (t: number) => void) => queue.push(cb) },
    /** `ms` ilerletir ve bekleyen kareleri çalıştırır. */
    frame(ms: number) {
      now += ms;
      const run = queue;
      queue = [];
      for (const cb of run) cb(now);
    },
    get pending() {
      return queue.length;
    },
  };
}

let map: FakeMap;
let adapter: MaplibreAdapter;
let overlay: FakeOverlay;
let events: MapEventSink & { received: Parameters<MapEventSink['emit']>[0][] };

async function mount(options: MaplibreAdapterOptions = {}) {
  map = new FakeMap();
  const deck = createFakeDeck();
  events = { received: [], emit: (e) => events.received.push(e) };
  adapter = new MaplibreAdapter({
    deckRenderers: { milsym },
    loadDeck: async () => deck.modules,
    ...options,
    createMap: async () => map,
  });
  await adapter.mount(container, {
    initialView: { center: [32.85, 39.9], zoom: 7 },
    events,
    kinds: new FeatureKindRegistry(),
    symbology: new SymbologyRegistry(),
    basemapProviders: new BasemapProviderRegistry(),
  });
  if (deck.created()) overlay = deck.overlay();
}

const iconLayer = (groupId = 'units') => overlay.layer(`c2-deck-${groupId}`)!;
const attr = (name: string, groupId = 'units') => iconLayer(groupId).props.data.attributes[name];

beforeEach(async () => {
  await mount();
});

describe('deck.gl yolu: kurulum', () => {
  it('deckRenderers verilince MapLibreOverlay interleaved olarak haritaya eklenir', () => {
    expect(overlay.props.interleaved).toBe(true);
    expect(map.controls).toContain(overlay);
    expect(adapter.capabilities.supportedFeatureKinds).toEqual(expect.arrayContaining(['vector', 'marker', 'milsym']));
  });

  it('deckRenderers yoksa deck.gl yüklenmez', async () => {
    let loaded = false;
    await mount({ deckRenderers: undefined, loadDeck: async () => ((loaded = true), createFakeDeck().modules) });
    expect(loaded).toBe(false);
  });

  it('unmount overlay\'i kaldırır ve sonlandırır', () => {
    adapter.unmount();
    expect(overlay.finalized).toBe(true);
    expect(map.controls).not.toContain(overlay);
  });
});

describe('deck.gl yolu: unsurlar', () => {
  it('deck kind\'ı GeoJSON kaynağına gitmez; grup başına bir IconLayer, typed array öznitelikleri', () => {
    adapter.applyBatch({
      groups: { remove: [], upsert: [{ id: 'units', layerId: 'birlikler', order: 1 }] },
      features: { remove: [], upsert: [rf(unit('a', 32)), rf(unit('b', 33), { opacity: 0.5 })] },
    });
    expect(map.getSource('c2-src-units')!.features.size).toBe(0);
    const layer = iconLayer();
    expect(layer.kind).toBe('icon');
    expect(layer.props.data.length).toBe(2);
    expect(layer.props.pickable).toBe(true);
    expect(layer.props.sizeUnits).toBe('pixels');
    expect([...attr('getPosition').value]).toEqual([32, 39, 33, 39]);
    expect(attr('getPosition').size).toBe(2);
    expect([...attr('getSize').value]).toEqual([30, 30]); // varsayılan: ikon yüksekliği
    expect([...attr('getColor').value]).toEqual([255, 255, 255, 255, 255, 255, 255, 128]);
    expect(layer.props.getIcon(null, { index: 1 })).toEqual({ id: 'S1', url: 'data:S1', width: 40, height: 30 });
  });

  it('konum güncellemesi: aynı data nesnesi, YENİ sarmalayıcı ve artan updateTrigger', () => {
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32))] } });
    const before = iconLayer();
    const oldWrapper = attr('getPosition');
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 34), { changed: FEATURE_CHANGE.GEOMETRY })] } });
    const after = iconLayer();
    expect(after.props.data).toBe(before.props.data); // uzunluk aynı: getIcon yeniden hesaplanmaz
    expect(attr('getPosition')).not.toBe(oldWrapper); // aynı referansı deck.gl atlar
    expect([...attr('getPosition').value]).toEqual([34, 39]);
    expect(after.props.updateTriggers.getPosition).toBeGreaterThan(before.props.updateTriggers.getPosition);
    expect(after.props.updateTriggers.getIcon).toBe(before.props.updateTriggers.getIcon);
  });

  it('ekleme/silme data nesnesini yeniler (deck.gl tam kurulum)', () => {
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32)), rf(unit('b', 33))] } });
    const data = iconLayer().props.data;
    adapter.applyBatch({ features: { upsert: [], remove: ['a'] } });
    expect(iconLayer().props.data).not.toBe(data);
    expect(iconLayer().props.data.length).toBe(1);
    expect([...attr('getPosition').value]).toEqual([33, 39]);
  });

  it('props değişince ikon yeniden seçilir; ikonsuz unsur çizilmez ve sayılır', () => {
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32))] } });
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32, 'S2'), { changed: FEATURE_CHANGE.PROPS })] } });
    expect(iconLayer().props.getIcon(null, { index: 0 }).id).toBe('S2');

    const noIcon: Feature = { ...unit('a', 32), props: {} };
    adapter.applyBatch({ features: { remove: [], upsert: [rf(noIcon, { changed: FEATURE_CHANGE.PROPS })] } });
    expect(iconLayer().props.data.length).toBe(0);
    expect(adapter.stats.skippedNoIcon).toBe(1);
  });

  it('opaklık değişimi yalnız renk özniteliğine yansır', () => {
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32))] } });
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32), { opacity: 0.2, changed: RENDER_CHANGE.OPACITY })] } });
    expect(attr('getColor').value[3]).toBe(51);
  });

  it('değişiklik yoksa setProps çağrılmaz', () => {
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32))] } });
    const calls = overlay.setPropsCalls;
    adapter.applyBatch({});
    expect(overlay.setPropsCalls).toBe(calls);
  });

  it('kind değişince motor değişir: deck → MapLibre', () => {
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32))] } });
    const asMarker: Feature = { ...unit('a', 32), kind: 'marker' };
    adapter.applyBatch({ features: { remove: [], upsert: [rf(asMarker, { changed: FEATURE_CHANGE.STYLE })] } });
    expect(iconLayer().props.data.length).toBe(0);
    expect(map.getSource('c2-src-units')!.features.has('a')).toBe(true);
  });

  it('grup değişince eski gruptan çıkar, yenisine eklenir', () => {
    adapter.applyBatch({
      groups: { remove: [], upsert: [{ id: 'units', layerId: 'birlikler', order: 1 }, { id: 'other', layerId: 'x', order: 2 }] },
      features: { remove: [], upsert: [rf(unit('a', 32))] },
    });
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32), { groupId: 'other', changed: RENDER_CHANGE.GROUP })] } });
    expect(iconLayer('units').props.data.length).toBe(0);
    expect(iconLayer('other').props.data.length).toBe(1);
  });

  it('grup silinince deck katmanı da gider', () => {
    adapter.applyBatch({
      groups: { remove: [], upsert: [{ id: 'units', layerId: 'birlikler', order: 1 }] },
      features: { remove: [], upsert: [rf(unit('a', 32))] },
    });
    adapter.applyBatch({ features: { upsert: [], remove: ['a'] }, groups: { upsert: [], remove: ['units'] } });
    expect(overlay.layer('c2-deck-units')).toBeUndefined();
  });
});

describe('deck.gl yolu: sıra (MapLibre yığınında)', () => {
  const groups = [
    { id: 'below', layerId: 'below', order: 1 },
    { id: 'units', layerId: 'birlikler', order: 2 },
    { id: 'above', layerId: 'above', order: 3 },
  ];
  const operational = () => map.layerOrder().filter((id) => id !== 'c2-basemap-top');

  it('deck katmanı alt grubun üstüne, üst grubun altına girer', () => {
    adapter.applyBatch({
      groups: { remove: [], upsert: groups },
      features: {
        upsert: [rf(polygon('p1'), { groupId: 'below' }), rf(unit('a', 32)), rf(polygon('p2'), { groupId: 'above' })],
        remove: [],
      },
    });
    const order = operational();
    const deckCarrier = order.findIndex((id) => id.startsWith('deck-maplibre-layer-group'));
    expect(deckCarrier).toBeGreaterThan(order.lastIndexOf('c2-below-vector-point'));
    expect(deckCarrier).toBeLessThan(order.indexOf('c2-above-vector-fill'));
    expect(iconLayer().props.beforeId).toBe('c2-above-vector-fill');
  });

  it('üst grubun katmanları sonradan eklenince deck katmanının üstünde kalır', () => {
    adapter.applyBatch({ groups: { remove: [], upsert: groups }, features: { remove: [], upsert: [rf(unit('a', 32))] } });
    adapter.applyBatch({ features: { remove: [], upsert: [rf(polygon('p2'), { groupId: 'above' })] } });
    const order = operational();
    expect(order.indexOf('deck-maplibre-layer-group-before:c2-above-vector-fill')).toBe(order.indexOf('c2-above-vector-fill') - 1);
  });

  it('alt grubun katmanları sonradan eklenince deck katmanının altına girer', () => {
    adapter.applyBatch({ groups: { remove: [], upsert: groups }, features: { remove: [], upsert: [rf(unit('a', 32))] } });
    adapter.applyBatch({ features: { remove: [], upsert: [rf(polygon('p1'), { groupId: 'below' })] } });
    const order = operational();
    expect(order.at(-1)).toBe('deck-maplibre-layer-group-last');
    expect(order.indexOf('c2-below-vector-fill')).toBe(0);
  });

  it('grup sırası değişince deck katmanı yeniden yerleşir', () => {
    adapter.applyBatch({
      groups: { remove: [], upsert: groups },
      features: { remove: [], upsert: [rf(polygon('p1'), { groupId: 'below' }), rf(unit('a', 32))] },
    });
    adapter.applyBatch({ groups: { remove: [], upsert: [{ id: 'units', layerId: 'birlikler', order: 0 }] } });
    const order = operational();
    expect(iconLayer().props.beforeId).toBe('c2-below-vector-fill');
    expect(order.indexOf('deck-maplibre-layer-group-before:c2-below-vector-fill')).toBe(0);
  });

  it('birden çok deck grubu order sırasıyla dizilir', () => {
    adapter.applyBatch({
      groups: { remove: [], upsert: [{ id: 'u2', layerId: 'u2', order: 5 }, { id: 'u1', layerId: 'u1', order: 4 }] },
      features: { remove: [], upsert: [rf(unit('a', 32), { groupId: 'u2' }), rf(unit('b', 32), { groupId: 'u1' })] },
    });
    expect(overlay.layers.map((l) => l.id)).toEqual(['c2-deck-u1', 'c2-deck-u2']);
  });
});

describe('deck.gl yolu: seçim / hover / hit-test', () => {
  it('seçim ve hover halkası ayrı bir ScatterplotLayer ile çizilir', () => {
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32)), rf(unit('b', 33))] } });
    adapter.applyBatch({ state: [{ id: 'a', state: { selected: true } }, { id: 'b', state: { hovered: true } }] });
    const marks = overlay.layer('c2-deck-marks')!;
    expect(marks.kind).toBe('scatterplot');
    expect(marks.props.data.map((m: any) => m.coord)).toEqual([[32, 39], [33, 39]]);
    expect(marks.props.getRadius(marks.props.data[0])).toBeGreaterThan(marks.props.getRadius(marks.props.data[1]));

    adapter.applyBatch({ state: [{ id: 'a', state: { selected: false } }, { id: 'b', state: { hovered: false } }] });
    expect(overlay.layer('c2-deck-marks')).toBeUndefined();
  });

  it('halka birliği takip eder; birlik silinince halka da gider', () => {
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32))] }, state: [{ id: 'a', state: { selected: true } }] });
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 35), { changed: FEATURE_CHANGE.GEOMETRY })] } });
    expect(overlay.layer('c2-deck-marks')!.props.data[0].coord).toEqual([35, 39]);
    adapter.applyBatch({ features: { upsert: [], remove: ['a'] } });
    expect(overlay.layer('c2-deck-marks')).toBeUndefined();
  });

  it('tıklama: pickObject → indeks → unsur id\'si (swap-remove sonrası da doğru)', () => {
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32)), rf(unit('b', 33)), rf(unit('c', 34))] } });
    adapter.applyBatch({ features: { upsert: [], remove: ['a'] } }); // c → indeks 0
    overlay.hit = { layerId: 'c2-deck-units', index: 0 };
    map.fire('click', { point: { x: 5, y: 6 }, lngLat: { lng: 34, lat: 39 } });
    expect(events.received.at(-1)).toMatchObject({ type: MAP_EVENT.CLICK, featureId: 'c' });
    expect(overlay.lastPick).toMatchObject({ x: 5, y: 6, layerIds: ['c2-deck-units'] });
  });

  it('deck isabeti yoksa MapLibre katmanlarına bakılır', () => {
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32)), rf(polygon('p1'))] } });
    map.hits = [{ layer: 'c2-units-vector-fill', fid: 'p1' }];
    map.fire('click', { point: { x: 1, y: 1 }, lngLat: { lng: 0, lat: 0 } });
    expect(events.received.at(-1)).toMatchObject({ featureId: 'p1' });
  });
});

describe('deck.gl yolu: akıcı hareket', () => {
  it('OFF (varsayılan): konum hemen yazılır, kare döngüsü yok', async () => {
    const clock = manualClock();
    await mount({ deckTiming: clock.timing });
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 32))] } });
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 34), { changed: FEATURE_CHANGE.GEOMETRY })] } });
    expect([...attr('getPosition').value]).toEqual([34, 39]);
    expect(clock.pending).toBe(0);
    expect(adapter.motion).toEqual({ mode: MOTION_MODE.OFF, active: false });
  });

  it('ON: süre boyunca ara konumlar; bitince döngü durur', async () => {
    const clock = manualClock();
    await mount({ motion: MOTION_MODE.ON, motionDurationMs: 1000, deckTiming: clock.timing });
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 30))] } }); // yeni: kaymaz
    expect([...attr('getPosition').value]).toEqual([30, 39]);

    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 40), { changed: FEATURE_CHANGE.GEOMETRY })] } });
    expect([...attr('getPosition').value]).toEqual([30, 39]);
    clock.frame(500);
    expect([...attr('getPosition').value]).toEqual([35, 39]);
    clock.frame(600);
    expect([...attr('getPosition').value]).toEqual([40, 39]);
    expect(clock.pending).toBe(0);
  });

  it('ON → OFF: kayan birlikler hedefe atlar', async () => {
    const clock = manualClock();
    await mount({ motion: MOTION_MODE.ON, deckTiming: clock.timing });
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 30))] } });
    adapter.applyBatch({ features: { remove: [], upsert: [rf(unit('a', 40), { changed: FEATURE_CHANGE.GEOMETRY })] } });
    clock.frame(100);
    adapter.setMotionMode(MOTION_MODE.OFF);
    expect([...attr('getPosition').value]).toEqual([40, 39]);
  });

  it('varsayılan zamanlayıcı requestAnimationFrame\'i bağsız çağırmaz (tarayıcı: "Illegal invocation")', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', function (this: unknown, cb: FrameRequestCallback) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      frames.push(cb);
      return frames.length;
    });
    try {
      await mount({ motion: MOTION_MODE.AUTO });
      expect(frames.length).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('AUTO: kare hızı düşük kalınca kapanır, yükselince açılır', async () => {
    const clock = manualClock();
    await mount({ motion: MOTION_MODE.AUTO, motionAuto: { lowFps: 25, highFps: 50, holdMs: 2000 }, deckTiming: clock.timing });
    expect(adapter.motion).toEqual({ mode: MOTION_MODE.AUTO, active: true });

    for (let t = 0; t < 4000; t += 100) clock.frame(100); // 10 fps
    expect(adapter.motion.active).toBe(false);

    for (let t = 0; t < 8000; t += 10) clock.frame(10); // 100 fps; bekleme 4000'e çıktı
    expect(adapter.motion.active).toBe(true);

    adapter.setMotionMode(MOTION_MODE.ON);
    clock.frame(10);
    expect(clock.pending).toBe(0); // AUTO dışında ölçüm döngüsü durur
  });
});
