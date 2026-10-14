import {
  BasemapProviderRegistry,
  createManualScheduler,
  createMapStore,
  EventRouter,
  FEATURE_CHANGE,
  FeatureKindRegistry,
  GEOMETRY_KIND,
  MAP_EVENT,
  MapSync,
  RENDER_CHANGE,
  RENDER_CHANGE_ALL,
  SymbologyRegistry,
  type Feature,
  type MapEvent,
  type MapEventSink,
  type RenderFeature,
} from '@c2/map-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASEMAP_ANCHOR_LAYER, MaplibreAdapter } from './adapter';
import { DRAW_PREVIEW_LAYERS } from './draw-preview';
import { FakeMap } from './testing/fake-map';

const DRAW_LAYERS = DRAW_PREVIEW_LAYERS.map((l) => l.id);

const container = {} as HTMLElement;

const polygon = (id: string, over: Partial<Feature> = {}): Feature => ({
  id,
  layerId: 'kontrol',
  kind: 'vector',
  geometry: { kind: GEOMETRY_KIND.POLYGON, rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  style: { fillColor: '#ff0000' },
  ...over,
});

const marker = (id: string, lon: number, icon?: string): Feature => ({
  id,
  layerId: 'birlikler',
  kind: 'marker',
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [lon, 39] },
  props: icon ? { icon } : undefined,
});

const rf = (feature: Feature, over: Partial<RenderFeature> = {}): RenderFeature => ({
  feature,
  groupId: 'g1',
  opacity: 1,
  zIndex: 10_000,
  changed: RENDER_CHANGE_ALL,
  ...over,
});

let map: FakeMap;
let adapter: MaplibreAdapter;
let kinds: FeatureKindRegistry;
let events: MapEventSink & { received: Parameters<MapEventSink['emit']>[0][] };

async function mount(options: ConstructorParameters<typeof MaplibreAdapter>[0] = {}) {
  map = new FakeMap();
  kinds = new FeatureKindRegistry();
  events = { received: [], emit: (e) => events.received.push(e) };
  adapter = new MaplibreAdapter({ ...options, createMap: async () => map });
  await adapter.mount(container, {
    initialView: { center: [32.85, 39.9], zoom: 7 },
    events,
    kinds,
    symbology: new SymbologyRegistry(),
    basemapProviders: new BasemapProviderRegistry(),
  });
}

const source = (groupId = 'g1') => map.getSource(`c2-src-${groupId}`)!;

beforeEach(async () => {
  await mount();
});

describe('mount', () => {
  it('altlık çapası eklenir; başlangıç görünümü harita üreticisine gider', async () => {
    expect(map.layerOrder()).toEqual([BASEMAP_ANCHOR_LAYER, ...DRAW_LAYERS]);
    const createMap = vi.fn(async () => new FakeMap());
    const a = new MaplibreAdapter({ createMap, workerUrl: '/w.mjs' });
    await a.mount(container, {
      initialView: { center: [1, 2], zoom: 5 },
      events,
      kinds,
      symbology: new SymbologyRegistry(),
      basemapProviders: new BasemapProviderRegistry(),
    });
    expect(createMap).toHaveBeenCalledWith(container, expect.objectContaining({ center: [1, 2], zoom: 5, workerUrl: '/w.mjs' }));
  });

  it('iki kez mount → hata; mount olmadan applyBatch → hata', async () => {
    await expect(adapter.mount(container, {} as never)).rejects.toThrow(/zaten/);
    expect(() => new MaplibreAdapter().applyBatch({})).toThrow(/mount/);
  });

  it('yetenekler kayıtlı renderer\'lardan', () => {
    expect(adapter.capabilities.supportedFeatureKinds).toEqual(['vector', 'marker']);
  });
});

describe('gruplar ve katmanlar', () => {
  it('grup → promoteId\'li GeoJSON kaynağı; kind ilk kez görününce katmanları eklenir', () => {
    adapter.applyBatch({ groups: { upsert: [{ id: 'g1', layerId: 'g1', order: 0 }], remove: [] } });
    expect(source().spec).toMatchObject({ type: 'geojson', promoteId: '_id' });
    expect(map.layerOrder()).toEqual([BASEMAP_ANCHOR_LAYER, ...DRAW_LAYERS]); // henüz kind yok

    adapter.applyBatch({ features: { upsert: [rf(polygon('p1'))], remove: [] } });
    expect(map.layerOrder()).toEqual([BASEMAP_ANCHOR_LAYER, 'c2-g1-vector-fill', 'c2-g1-vector-line', 'c2-g1-vector-point', ...DRAW_LAYERS]);
  });

  it('gruplar sırayla dizilir; alttaki gruba sonradan eklenen kind üstteki grubun altına girer', () => {
    adapter.applyBatch({
      groups: {
        upsert: [
          { id: 'alt', layerId: 'alt', order: 0 },
          { id: 'ust', layerId: 'ust', order: 1 },
        ],
        remove: [],
      },
      features: { upsert: [rf(polygon('p1'), { groupId: 'ust' }), rf(polygon('p2'), { groupId: 'alt' })], remove: [] },
    });
    adapter.applyBatch({ features: { upsert: [rf(marker('m1', 1), { groupId: 'alt' })], remove: [] } });

    const order = map.layerOrder();
    const lastAlt = Math.max(...order.map((id, i) => (id.startsWith('c2-alt-') ? i : -1)));
    const firstUst = order.findIndex((id) => id.startsWith('c2-ust-'));
    expect(lastAlt).toBeLessThan(firstUst);
    expect(order).toContain('c2-alt-marker-icon');
  });

  it('grup sırası değişince katmanlar yeniden dizilir', () => {
    adapter.applyBatch({
      groups: { upsert: [{ id: 'a', layerId: 'a', order: 0 }, { id: 'b', layerId: 'b', order: 1 }], remove: [] },
      features: { upsert: [rf(polygon('p1'), { groupId: 'a' }), rf(polygon('p2'), { groupId: 'b' })], remove: [] },
    });
    adapter.applyBatch({ groups: { upsert: [{ id: 'a', layerId: 'a', order: 2 }], remove: [] } });
    const order = map.layerOrder();
    expect(order.findIndex((id) => id.startsWith('c2-b-'))).toBeLessThan(order.findIndex((id) => id.startsWith('c2-a-')));
  });

  it('grup kaldırılınca katmanları ve kaynağı silinir', () => {
    adapter.applyBatch({
      groups: { upsert: [{ id: 'g1', layerId: 'g1', order: 0 }], remove: [] },
      features: { upsert: [rf(polygon('p1'))], remove: [] },
    });
    adapter.applyBatch({ features: { upsert: [], remove: ['p1'] }, groups: { upsert: [], remove: ['g1'] } });
    expect(map.layerOrder()).toEqual([BASEMAP_ANCHOR_LAYER, ...DRAW_LAYERS]);
    expect(map.getSource('c2-src-g1')).toBeUndefined();
  });
});

describe('encode ve fark', () => {
  beforeEach(() => adapter.applyBatch({ groups: { upsert: [{ id: 'g1', layerId: 'g1', order: 0 }], remove: [] } }));

  it('yeni unsur → add; standart alanlar eklenir', () => {
    adapter.applyBatch({ features: { upsert: [rf(polygon('p1'), { opacity: 0.5, zIndex: 7 })], remove: [] } });
    expect(source().features.get('p1')?.properties).toMatchObject({
      _id: 'p1',
      _fid: 'p1',
      _op: 0.5,
      _z: 7,
      _kind: 'vector',
      _fc: '#ff0000',
    });
  });

  it('yalnız konum değişti → updateData yalnız newGeometry içerir', () => {
    adapter.applyBatch({ features: { upsert: [rf(marker('m1', 1))], remove: [] } });
    adapter.applyBatch({ features: { upsert: [rf(marker('m1', 2), { changed: FEATURE_CHANGE.GEOMETRY })], remove: [] } });
    expect(source().diffs.at(-1)).toEqual({
      update: [{ id: 'm1', newGeometry: { type: 'Point', coordinates: [2, 39] } }],
    });
  });

  it('yalnız opaklık değişti → yalnız _op özelliği', () => {
    adapter.applyBatch({ features: { upsert: [rf(polygon('p1'))], remove: [] } });
    adapter.applyBatch({ features: { upsert: [rf(polygon('p1'), { opacity: 0.3, changed: RENDER_CHANGE.OPACITY })], remove: [] } });
    expect(source().diffs.at(-1)).toEqual({ update: [{ id: 'p1', addOrUpdateProperties: [{ key: '_op', value: 0.3 }] }] });
  });

  it('bir batch\'teki tüm değişiklikler kaynak başına TEK updateData', () => {
    adapter.applyBatch({
      features: { upsert: [rf(marker('m1', 1)), rf(marker('m2', 2)), rf(polygon('p1'))], remove: [] },
    });
    expect(source().diffs).toHaveLength(1);
    expect(adapter.lastSent).toBe(3);
  });

  it('kaldırma → remove; değişiklik yoksa updateData çağrılmaz', () => {
    adapter.applyBatch({ features: { upsert: [rf(polygon('p1'))], remove: [] } });
    adapter.applyBatch({ features: { upsert: [rf(polygon('p1'), { changed: 0 })], remove: [] } });
    expect(source().diffs).toHaveLength(1);
    adapter.applyBatch({ features: { upsert: [], remove: ['p1'] } });
    expect(source().features.size).toBe(0);
  });

  it('başka gruba geçen unsur eski kaynaktan silinip yenisine eklenir', () => {
    adapter.applyBatch({
      groups: { upsert: [{ id: 'g2', layerId: 'g2', order: 1 }], remove: [] },
      features: { upsert: [rf(polygon('p1'))], remove: [] },
    });
    adapter.applyBatch({ features: { upsert: [rf(polygon('p1'), { groupId: 'g2', changed: RENDER_CHANGE.GROUP })], remove: [] } });
    expect(source('g1').features.has('p1')).toBe(false);
    expect(source('g2').features.has('p1')).toBe(true);
  });

  it('marker: ikonlu ve ikonsuz; ikon kaldırılınca değer boş olur', () => {
    adapter.applyBatch({ features: { upsert: [rf(marker('m1', 1, 'tank'))], remove: [] } });
    expect(source().features.get('m1')?.properties._icon).toBe('tank');
    adapter.applyBatch({ features: { upsert: [rf(marker('m1', 1), { changed: FEATURE_CHANGE.PROPS })], remove: [] } });
    expect(source().features.get('m1')?.properties._icon).toBe('');
  });
});

describe('performans kuralları (tarayıcı ölçümünden)', () => {
  it('marker ikon katmanında icon-size veri güdümlü DEĞİL (10k birlikte FPS\'i 1–2\'ye düşürüyordu)', () => {
    adapter.applyBatch({
      groups: { upsert: [{ id: 'g1', layerId: 'g1', order: 0 }], remove: [] },
      features: { upsert: [rf(marker('m1', 1, 'tank'))], remove: [] },
    });
    const icon = map.getLayer('c2-g1-marker-icon') as { layout: Record<string, unknown> };
    expect(typeof icon.layout['icon-size']).toBe('number');
  });
});

describe('desteklenmeyen kind', () => {
  beforeEach(() => adapter.applyBatch({ groups: { upsert: [{ id: 'g1', layerId: 'g1', order: 0 }], remove: [] } }));

  it('renderer yok ve fallback yok → çizilmez, sayılır', () => {
    adapter.applyBatch({ features: { upsert: [rf({ ...polygon('x'), kind: 'model3d' })], remove: [] } });
    expect(source().features.size).toBe(0);
    expect(adapter.stats.skippedUnsupported).toBe(1);
  });

  it('çekirdeğin fallback zinciri: model3d → marker olarak çizilir (_kind = marker)', () => {
    kinds.register({ kind: 'model3d', fallback: (f) => ({ ...f, kind: 'marker' }) });
    adapter.applyBatch({ features: { upsert: [rf({ ...marker('t1', 5), kind: 'model3d' })], remove: [] } });
    expect(source().features.get('t1')?.properties._kind).toBe('marker');
  });

  it('kullanımdaki kind\'ın renderer\'ı değiştirilemez; geçersiz renderer reddedilir', () => {
    adapter.applyBatch({ features: { upsert: [rf(polygon('p1'))], remove: [] } });
    expect(() => adapter.registerRenderer('vector', { layers: () => [], encode: () => [] })).toThrow(/kullanımda/);
    expect(() => adapter.registerRenderer('yeni', {})).toThrow(/geçersiz/);
  });
});

describe('feature-state', () => {
  it('ekrandaki unsurun parçalarına uygulanır; ekranda olmayan yok sayılır', () => {
    adapter.applyBatch({
      groups: { upsert: [{ id: 'g1', layerId: 'g1', order: 0 }], remove: [] },
      features: { upsert: [rf(polygon('p1'))], remove: [] },
      state: [
        { id: 'p1', state: { selected: true } },
        { id: 'yok', state: { selected: true } },
      ],
    });
    expect(map.featureStates.get('c2-src-g1/p1')).toEqual({ selected: true });
    expect(map.featureStates.size).toBe(1);
  });
});

describe('etkileşim → olaylar', () => {
  beforeEach(() =>
    adapter.applyBatch({
      groups: { upsert: [{ id: 'g1', layerId: 'g1', order: 0 }], remove: [] },
      features: { upsert: [rf(marker('m1', 1, 'tank'))], remove: [] },
    }),
  );

  const mouse = { point: { x: 10, y: 20 }, lngLat: { lng: 32, lat: 39 } };

  it('tıklama: hit-test sonucu unsur id\'si; etkileşimsiz (halo) katman sorgulanmaz', () => {
    map.hits = [{ layer: 'c2-g1-marker-icon', fid: 'm1' }];
    map.fire('click', mouse);
    expect(events.received.at(-1)).toMatchObject({ type: MAP_EVENT.CLICK, featureId: 'm1', coord: [32, 39] });
    expect(map.lastQueryLayers).not.toContain('c2-g1-marker-halo');
  });

  it('değiştirici tuşlar olaya taşınır (çoklu seçim için)', () => {
    map.fire('click', { ...mouse, originalEvent: { shiftKey: true, ctrlKey: false, altKey: false, metaKey: true } });
    expect(events.received.at(-1)?.modifiers).toEqual({ shift: true, ctrl: false, alt: false, meta: true });
  });

  it('sağ tık: CONTEXT_MENU + tarayıcı menüsü bastırılır (seçenekle kapatılabilir)', async () => {
    const preventDefault = vi.fn();
    map.hits = [{ layer: 'c2-g1-marker-icon', fid: 'm1' }];
    map.fire('contextmenu', { ...mouse, originalEvent: { preventDefault } });
    expect(events.received.at(-1)).toMatchObject({ type: MAP_EVENT.CONTEXT_MENU, featureId: 'm1', screen: { x: 10, y: 20 } });
    expect(preventDefault).toHaveBeenCalled();

    await mount({ suppressContextMenu: false });
    const allow = vi.fn();
    map.fire('contextmenu', { ...mouse, originalEvent: { preventDefault: allow } });
    expect(allow).not.toHaveBeenCalled();
  });

  it('boşluğa tıklama: featureId yok', () => {
    map.fire('click', mouse);
    expect(events.received.at(-1)).toMatchObject({ type: MAP_EVENT.CLICK, featureId: undefined });
  });

  it('hover: enter / leave yalnız değişince; imleç', async () => {
    map.hits = [{ layer: 'c2-g1-marker-icon', fid: 'm1' }];
    map.fire('mousemove', mouse);
    map.fire('mousemove', mouse); // aynı karede birleşir
    await new Promise((r) => setTimeout(r, 30));
    const types = () => events.received.map((e) => e.type);
    expect(types().filter((t) => t === MAP_EVENT.POINTER_ENTER)).toHaveLength(1);
    expect(map.canvas.style.cursor).toBe('pointer');

    map.fire('mouseout');
    expect(events.received.at(-1)).toMatchObject({ type: MAP_EVENT.POINTER_LEAVE, featureId: 'm1' });
    expect(map.canvas.style.cursor).toBe('');
  });

  it('kamera durunca VIEW_CHANGE', () => {
    map.jumpTo({ center: [30, 40], zoom: 9 });
    map.fire('moveend');
    expect(events.received.at(-1)).toMatchObject({ type: MAP_EVENT.VIEW_CHANGE, view: { center: [30, 40], zoom: 9 } });
  });

  it('unmount: dinleyiciler çıkarılır, harita kaldırılır', () => {
    adapter.unmount();
    expect(map.listenerCount()).toBe(0);
    expect(map.removed).toBe(true);
  });
});

describe('ikon çözümleyici', () => {
  it('eksik ikon istenince resolveImage ile üretilip eklenir', async () => {
    const image = { width: 1, height: 1, data: new Uint8Array(4) };
    await mount({ resolveImage: (id) => (id === 'tank' ? { image, pixelRatio: 2 } : null) });
    await map.imageResolver!('tank');
    await map.imageResolver!('yok');
    expect(map.images.get('tank')).toBe(image);
    expect(map.hasImage('yok')).toBe(false);
  });
});

describe('uçtan uca: store → MapSync → MaplibreAdapter → kaynak', () => {
  it('store yazımı kaynağa yansır; tıklama EventRouter ile store seçimine döner', async () => {
    const store = createMapStore();
    const router = new EventRouter(store);
    map = new FakeMap();
    const real = new MaplibreAdapter({ createMap: async () => map });
    await real.mount(container, {
      initialView: { center: [0, 0], zoom: 5 },
      events: router,
      kinds: new FeatureKindRegistry(),
      symbology: new SymbologyRegistry(),
      basemapProviders: new BasemapProviderRegistry(),
    });
    const scheduler = createManualScheduler();
    new MapSync({ store, adapter: real, scheduler }).start();
    router.on(MAP_EVENT.CLICK, (e: MapEvent) => store.transaction((tx) => (e.featureId ? tx.select([e.featureId]) : undefined)));

    store.transaction((tx) => {
      tx.upsertLayers([{ id: 'kontrol', name: 'Kontrol', parentId: null, visible: true, opacity: 0.5 }]);
      tx.upsertFeatures([polygon('fh-altin')]);
    });
    scheduler.run();
    const src = map.getSource('c2-src-kontrol')!;
    expect(src.features.get('fh-altin')?.properties).toMatchObject({ _op: 0.5, _fc: '#ff0000' });

    map.hits = [{ layer: 'c2-kontrol-vector-fill', fid: 'fh-altin' }];
    map.fire('click', { point: { x: 1, y: 1 }, lngLat: { lng: 0, lat: 0 } });
    scheduler.run();
    expect(store.getSelection().has('fh-altin')).toBe(true);
    expect(map.featureStates.get('c2-src-kontrol/fh-altin')).toEqual({ selected: true });

    store.transaction((tx) => tx.patchLayer('kontrol', { visible: false }));
    scheduler.run();
    expect(src.features.size).toBe(0);
  });
});

describe('çizim: mod + önizleme (araçlar çekirdekte)', () => {
  it('mod: çift tık zoom kapanır, imleç artı; hover imleci ezmez; kapatınca geri gelir', async () => {
    adapter.applyBatch({
      groups: { upsert: [{ id: 'g1', layerId: 'g1', order: 0 }], remove: [] },
      features: { upsert: [rf(marker('m1', 1))], remove: [] },
    });
    adapter.setDrawMode(true);
    expect(map.doubleClickZoom.isEnabled()).toBe(false);
    expect(map.canvas.style.cursor).toBe('crosshair');
    map.hits = [{ layer: 'c2-g1-marker-dot', fid: 'm1' }];
    map.fire('mousemove', { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 39 } });
    await new Promise((r) => setTimeout(r, 30));
    expect(map.canvas.style.cursor).toBe('crosshair');
    adapter.setDrawMode(false);
    expect(map.doubleClickZoom.isEnabled()).toBe(true);
    expect(map.canvas.style.cursor).toBe('');
  });

  it('önizleme: şekil + yardımcı çizgi + köşeler tek kaynağa; null → boş', () => {
    adapter.setDrawPreview({
      shape: { kind: GEOMETRY_KIND.CIRCLE, center: [32, 39], radiusM: 1000 },
      vertices: [[32, 39]],
      guides: [[[32, 39], [32.01, 39]]],
    });
    const data = map.getSource('c2-draw-preview')!.data!;
    expect(data.features.map((f) => [f.properties!.role, f.geometry.type])).toEqual([
      ['shape', 'Polygon'],
      ['guide', 'LineString'],
      ['vertex', 'Point'],
    ]);
    adapter.setDrawPreview(null);
    expect(map.getSource('c2-draw-preview')!.data!.features).toEqual([]);
  });

  it('önizleme katmanları hep en üstte: sonradan eklenen grup / yeniden dizme altına girer; hit-test\'e girmez', () => {
    adapter.applyBatch({
      groups: { upsert: [{ id: 'g1', layerId: 'g1', order: 5 }], remove: [] },
      features: { upsert: [rf(polygon('p1'))], remove: [] },
    });
    adapter.applyBatch({ groups: { upsert: [{ id: 'g1', layerId: 'g1', order: 0 }, { id: 'g2', layerId: 'g2', order: 9 }], remove: [] } });
    adapter.applyBatch({ features: { upsert: [rf(polygon('p2'), { groupId: 'g2' })], remove: [] } });
    expect(map.layerOrder().slice(-DRAW_LAYERS.length)).toEqual(DRAW_LAYERS);
    map.fire('click', { point: { x: 1, y: 1 }, lngLat: { lng: 0, lat: 0 } });
    expect(map.lastQueryLayers.some((id) => id.startsWith('c2-draw-'))).toBe(false);
  });
});
