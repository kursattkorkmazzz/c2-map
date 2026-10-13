import {
  BASEMAP_SOURCE,
  BasemapProviderRegistry,
  createManualScheduler,
  createMapStore,
  EventRouter,
  FeatureKindRegistry,
  GEOMETRY_KIND,
  MapSync,
  SymbologyRegistry,
  type Basemap,
} from '@c2/map-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASEMAP_ANCHOR_LAYER, MaplibreAdapter, type MapInit } from './adapter';
import { toSourceSpec, urlPrefix } from './basemaps';
import { FakeMap } from './testing/fake-map';

const xyz = (id: string, over: Partial<Basemap> = {}): Basemap => ({
  id,
  name: id,
  source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: `https://${id}.example/{z}/{x}/{y}.png` },
  visible: true,
  opacity: 1,
  order: 0,
  ...over,
});

let map: FakeMap;
let adapter: MaplibreAdapter;
let providers: BasemapProviderRegistry;
let init: MapInit;

beforeEach(async () => {
  map = new FakeMap();
  providers = new BasemapProviderRegistry();
  adapter = new MaplibreAdapter({
    createMap: async (_c, i) => {
      init = i;
      return map;
    },
  });
  await adapter.mount({} as HTMLElement, {
    initialView: { center: [0, 0], zoom: 5 },
    events: { emit: () => {} },
    kinds: new FeatureKindRegistry(),
    symbology: new SymbologyRegistry(),
    basemapProviders: providers,
  });
});

const basemapLayers = () => map.layerOrder().filter((id) => id.startsWith('c2-bm-'));
const layer = (id: string) => map.getLayer(`c2-bm-${id}`) as { paint: Record<string, unknown>; layout: Record<string, unknown> };

describe('toSourceSpec', () => {
  it('XYZ → raster tiles (+ zoom aralığı, attribution)', () => {
    expect(
      toSourceSpec({ type: BASEMAP_SOURCE.XYZ, urlTemplate: 'https://t/{z}/{x}/{y}.png', tileSize: 512, maxZoom: 18 }, '© OSM'),
    ).toEqual({ type: 'raster', tiles: ['https://t/{z}/{x}/{y}.png'], tileSize: 512, maxzoom: 18, attribution: '© OSM' });
  });

  it('WMS → GetMap şablonu, EPSG:3857, {bbox-epsg-3857} yer tutucusu kodlanmadan', () => {
    const spec = toSourceSpec({
      type: BASEMAP_SOURCE.WMS,
      url: 'https://wms.example/service',
      layers: 'uydu,yollar',
      params: { TIME: '2026' },
    }) as { tiles: string[] };
    const url = spec.tiles[0]!;
    expect(url.startsWith('https://wms.example/service?')).toBe(true);
    expect(url).toContain('REQUEST=GetMap');
    expect(url).toContain('LAYERS=uydu%2Cyollar');
    expect(url).toContain('CRS=EPSG%3A3857');
    expect(url).toContain('TIME=2026');
    expect(url.endsWith('&BBOX={bbox-epsg-3857}')).toBe(true);
  });

  it('WMTS: KVP şablonu; REST şablonu ({z} içeren URL) aynen', () => {
    const kvp = toSourceSpec({ type: BASEMAP_SOURCE.WMTS, url: 'https://wmts/x?token=1', layer: 'uydu', tileMatrixSet: 'GoogleMapsCompatible' }) as { tiles: string[] };
    expect(kvp.tiles[0]).toContain('https://wmts/x?token=1&');
    expect(kvp.tiles[0]).toContain('TILEMATRIX={z}&TILEROW={y}&TILECOL={x}');
    const rest = toSourceSpec({ type: BASEMAP_SOURCE.WMTS, url: 'https://wmts/{z}/{y}/{x}.jpg', layer: 'l', tileMatrixSet: 's' }) as { tiles: string[] };
    expect(rest.tiles[0]).toBe('https://wmts/{z}/{y}/{x}.jpg');
  });

  it('TILEJSON → url; IMAGE → image kaynağı (köşeler TL, TR, BR, BL)', () => {
    expect(toSourceSpec({ type: BASEMAP_SOURCE.TILEJSON, url: 'https://tj.json' })).toMatchObject({ type: 'raster', url: 'https://tj.json' });
    expect(
      toSourceSpec({ type: BASEMAP_SOURCE.IMAGE, url: 'ortofoto.png', corners: [[0, 1], [1, 1], [1, 0], [0, 0]] }),
    ).toEqual({ type: 'image', url: 'ortofoto.png', coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
  });

  it('VECTOR_STYLE (Faz 4) ve çözülmemiş custom → null', () => {
    expect(toSourceSpec({ type: BASEMAP_SOURCE.VECTOR_STYLE, styleUrl: 's.json' })).toBeNull();
    expect(toSourceSpec({ type: 'custom:x', config: {} })).toBeNull();
  });

  it('urlPrefix: ilk yer tutucu / sorgu öncesi', () => {
    expect(urlPrefix('https://a.example/tiles/{z}/{x}/{y}.png')).toBe('https://a.example/tiles/');
    expect(urlPrefix('https://wms/service?SERVICE=WMS')).toBe('https://wms/service');
  });
});

describe('altlık katmanları', () => {
  it('çapanın ALTINA, order\'a göre (küçük alta) eklenir; ekleme sırası önemsiz', () => {
    adapter.applyBatch({ basemaps: { upsert: [xyz('ust', { order: 2 }), xyz('alt', { order: 0 }), xyz('orta', { order: 1 })], remove: [] } });
    expect(map.layerOrder()).toEqual(['c2-bm-alt', 'c2-bm-orta', 'c2-bm-ust', BASEMAP_ANCHOR_LAYER]);
  });

  it('operasyonel katmanlar her zaman altlıkların üstünde', () => {
    adapter.applyBatch({
      groups: { upsert: [{ id: 'g', layerId: 'g', order: 0 }], remove: [] },
      features: {
        upsert: [{
          feature: { id: 'p', layerId: 'g', kind: 'vector', geometry: { kind: GEOMETRY_KIND.POINT, coord: [0, 0] } },
          groupId: 'g', opacity: 1, zIndex: 0, changed: 0x7ff,
        }],
        remove: [],
      },
    });
    adapter.applyBatch({ basemaps: { upsert: [xyz('osm')], remove: [] } });
    const order = map.layerOrder();
    expect(order.indexOf('c2-bm-osm')).toBeLessThan(order.indexOf(BASEMAP_ANCHOR_LAYER));
    expect(order.indexOf(BASEMAP_ANCHOR_LAYER)).toBeLessThan(order.indexOf('c2-g-vector-fill'));
  });

  it('opaklık / görünürlük yerinde güncellenir (kaynak baştan kurulmaz)', () => {
    const osm = xyz('osm');
    adapter.applyBatch({ basemaps: { upsert: [osm], remove: [] } });
    const source = map.getSource('c2-bm-src-osm');

    adapter.applyBatch({ basemaps: { upsert: [{ ...osm, opacity: 0.4, visible: false }], remove: [] } });
    expect(layer('osm').paint['raster-opacity']).toBe(0.4);
    expect(layer('osm').layout.visibility).toBe('none');
    expect(map.getSource('c2-bm-src-osm')).toBe(source);
  });

  it('sıra değişince katman taşınır', () => {
    const a = xyz('a', { order: 0 });
    adapter.applyBatch({ basemaps: { upsert: [a, xyz('b', { order: 1 })], remove: [] } });
    adapter.applyBatch({ basemaps: { upsert: [{ ...a, order: 5 }], remove: [] } });
    expect(basemapLayers()).toEqual(['c2-bm-b', 'c2-bm-a']);
  });

  it('kaynak değişince kaynak + katman baştan kurulur, sırası korunur', () => {
    const a = xyz('a', { order: 0 });
    adapter.applyBatch({ basemaps: { upsert: [a, xyz('b', { order: 1 })], remove: [] } });
    const before = map.getSource('c2-bm-src-a');
    adapter.applyBatch({
      basemaps: { upsert: [{ ...a, source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: 'https://yeni/{z}/{x}/{y}' } }], remove: [] },
    });
    expect(map.getSource('c2-bm-src-a')).not.toBe(before);
    expect(basemapLayers()).toEqual(['c2-bm-a', 'c2-bm-b']);
  });

  it('kaldırma: katman ve kaynak silinir', () => {
    adapter.applyBatch({ basemaps: { upsert: [xyz('osm')], remove: [] } });
    adapter.applyBatch({ basemaps: { upsert: [], remove: ['osm'] } });
    expect(basemapLayers()).toEqual([]);
    expect(map.getSource('c2-bm-src-osm')).toBeUndefined();
  });

  it('desteklenmeyen tip çizilmez, sayılır; desteklenen tipe geçince çizilir', () => {
    const v = xyz('v', { source: { type: BASEMAP_SOURCE.VECTOR_STYLE, styleUrl: 's.json' } });
    adapter.applyBatch({ basemaps: { upsert: [v], remove: [] } });
    expect(basemapLayers()).toEqual([]);
    expect(adapter.stats.skippedBasemaps).toBe(1);

    adapter.applyBatch({ basemaps: { upsert: [{ ...v, source: xyz('x').source }], remove: [] } });
    expect(basemapLayers()).toEqual(['c2-bm-v']);
  });
});

describe('sağlayıcılar (BasemapProviderRegistry)', () => {
  it('custom:* kaynak sağlayıcının resolve\'u ile çizilir', () => {
    providers.register({
      id: 'firma-a',
      resolve: () => ({ type: BASEMAP_SOURCE.XYZ, urlTemplate: 'https://firma-a.example/{z}/{x}/{y}.jpg' }),
    });
    adapter.applyBatch({ basemaps: { upsert: [xyz('uydu', { source: { type: 'custom:firma-a', config: {} } })], remove: [] } });
    expect(map.getSource('c2-bm-src-uydu')?.spec).toMatchObject({ tiles: ['https://firma-a.example/{z}/{x}/{y}.jpg'] });
  });

  it('istek dönüştürme: URL hangi altlığa aitse onun sağlayıcısı (auth header)', () => {
    providers.register({
      id: 'firma-a',
      transformRequest: (url) => ({ url, headers: { Authorization: 'Bearer gizli' } }),
    });
    adapter.applyBatch({
      basemaps: { upsert: [xyz('a', { provider: 'firma-a' }), xyz('osm')], remove: [] },
    });
    expect(init.transformRequest('https://a.example/5/10/12.png')).toEqual({
      url: 'https://a.example/5/10/12.png',
      headers: { Authorization: 'Bearer gizli' },
    });
    expect(init.transformRequest('https://osm.example/5/10/12.png')).toBeUndefined(); // sağlayıcısı yok
    expect(init.transformRequest('https://baska.example/x.png')).toBeUndefined();
  });
});

describe('uçtan uca: store altlıkları → MapSync → adapter', () => {
  it('exclusiveGroup ile birini açınca diğeri haritada gizlenir; opaklık yansır', async () => {
    const store = createMapStore();
    map = new FakeMap();
    const real = new MaplibreAdapter({ createMap: async () => map });
    await real.mount({} as HTMLElement, {
      initialView: { center: [0, 0], zoom: 5 },
      events: new EventRouter(store),
      kinds: new FeatureKindRegistry(),
      symbology: new SymbologyRegistry(),
      basemapProviders: new BasemapProviderRegistry(),
    });
    const scheduler = createManualScheduler();
    new MapSync({ store, adapter: real, scheduler }).start();

    store.transaction((tx) =>
      tx.upsertBasemaps([
        xyz('uydu-a', { exclusiveGroup: 'uydu', order: 0 }),
        xyz('uydu-b', { exclusiveGroup: 'uydu', order: 1, visible: false }),
      ]),
    );
    scheduler.run();
    expect(layer('uydu-a').layout.visibility).toBe('visible');

    store.transaction((tx) => tx.patchBasemap('uydu-b', { visible: true, opacity: 0.7 }));
    scheduler.run();
    expect(layer('uydu-a').layout.visibility).toBe('none');
    expect(layer('uydu-b').layout.visibility).toBe('visible');
    expect(layer('uydu-b').paint['raster-opacity']).toBe(0.7);
  });
});
