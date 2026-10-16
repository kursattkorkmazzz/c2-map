import { BASEMAP_SOURCE, BasemapProviderRegistry, type Basemap } from '@c2/map-core';
import {
  ImageryLayerCollection,
  UrlTemplateImageryProvider,
  WebMapServiceImageryProvider,
  WebMapTileServiceImageryProvider,
} from 'cesium';
import { describe, expect, it } from 'vitest';
import { CesiumBasemapController, toImageryProvider } from './basemaps';

const xyz = (id: string, order: number, over: Partial<Basemap> = {}): Basemap => ({
  id,
  name: id,
  source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: `https://${id}/{z}/{x}/{y}.png` },
  visible: true,
  opacity: 1,
  order,
  ...over,
});

describe('altlık → Cesium imagery', () => {
  it('kaynak tipleri', () => {
    expect(toImageryProvider(xyz('a', 0).source)).toBeInstanceOf(UrlTemplateImageryProvider);
    expect(toImageryProvider({ type: BASEMAP_SOURCE.WMS, url: 'https://w/wms', layers: 'L' })).toBeInstanceOf(WebMapServiceImageryProvider);
    expect(toImageryProvider({ type: BASEMAP_SOURCE.WMTS, url: 'https://w/wmts', layer: 'L', tileMatrixSet: 'GoogleMapsCompatible' })).toBeInstanceOf(
      WebMapTileServiceImageryProvider,
    );
    // REST şablonlu WMTS = XYZ
    expect(toImageryProvider({ type: BASEMAP_SOURCE.WMTS, url: 'https://w/{z}/{x}/{y}', layer: 'L', tileMatrixSet: 'x' })).toBeInstanceOf(
      UrlTemplateImageryProvider,
    );
    expect(toImageryProvider({ type: BASEMAP_SOURCE.VECTOR_STYLE, styleUrl: 'https://s' })).toBeNull();
  });

  it('auth: sağlayıcının dönüşümü şablona uygulanır', () => {
    const p = toImageryProvider(xyz('a', 0).source, {
      transform: (url) => ({ url: `${url}?token=T`, headers: { 'X-Key': 'K' } }),
    }) as UrlTemplateImageryProvider;
    expect(p.url).toContain('token=T');
  });

  it('denetleyici: sıra, yerinde opaklık / görünürlük, kaynak değişince yeni katman, desteklenmeyen sayılır', () => {
    const layers = new ImageryLayerCollection();
    const ctrl = new CesiumBasemapController(layers, new BasemapProviderRegistry());
    ctrl.upsert(xyz('ust', 10));
    ctrl.upsert(xyz('alt', 0));
    expect(layers.length).toBe(2);
    // `order` küçük olan altta (indeks 0)
    expect((layers.get(0).imageryProvider as UrlTemplateImageryProvider).url).toContain('alt');

    const before = layers.get(1);
    ctrl.upsert(xyz('ust', 10, { opacity: 0.4, visible: false }));
    expect(layers.get(1)).toBe(before); // aynı katman
    expect(before.alpha).toBe(0.4);
    expect(before.show).toBe(false);

    ctrl.upsert(xyz('ust', 10, { source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: 'https://yeni/{z}/{x}/{y}.png' } }));
    expect(layers.length).toBe(2);
    expect(layers.contains(before)).toBe(false);

    ctrl.upsert({ ...xyz('vektor', 5), source: { type: BASEMAP_SOURCE.VECTOR_STYLE, styleUrl: 'https://s' } });
    expect(ctrl.stats.skippedBasemaps).toBe(1);
    ctrl.remove('alt');
    expect(layers.length).toBe(1);
  });
});
