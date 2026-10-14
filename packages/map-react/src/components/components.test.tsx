import { BASEMAP_SOURCE, GEOMETRY_KIND, type Feature } from '@c2/map-core';
import { act, render } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderMap, settle } from '../testing';
import { MapBasemap } from './map-basemap';
import { Circle, MapFeature, Marker, MilSymbol, Polygon, Polyline } from './map-feature';
import { MapLayer } from './map-layer';
import { MapOverlay } from './map-overlay';

const streamed = (id: string, layerId: string): Feature => ({
  id,
  layerId,
  kind: 'milsym',
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [32, 39] },
});

describe('<MapLayer>', () => {
  it('iç içe katmanlar ebeveynleriyle; unsurlar saran katmanda; hepsi TEK transaction', async () => {
    const h = await renderMap(null);
    const spy = vi.spyOn(h.store, 'transaction');
    h.rerender(
      <MapLayer id="harekat" name="Harekât" renderGroup>
        <MapLayer id="kontrol" name="Kontrol">
          <Polygon id="p1" rings={[[[0, 0], [1, 0], [1, 1], [0, 0]]]} />
          <Polygon id="p2" rings={[[[0, 0], [2, 0], [2, 2], [0, 0]]]} />
        </MapLayer>
      </MapLayer>,
    );
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.store.getLayer('harekat')).toEqual({
      id: 'harekat',
      name: 'Harekât',
      parentId: null,
      visible: true,
      opacity: 1,
      renderGroup: true,
    });
    expect(h.store.getLayer('kontrol')?.parentId).toBe('harekat');
    expect(h.store.getFeature('p1')?.layerId).toBe('kontrol');
    expect(h.store.getChildLayerIds(null)).toEqual(['harekat']);
  });

  it('prop değişimi yalnız değişen alanı yazar: LayerTree\'deki görünürlük kararı korunur', async () => {
    const h = await renderMap(<MapLayer id="l1" name="A" />);
    act(() => h.store.transaction((tx) => tx.patchLayer('l1', { visible: false }))); // kullanıcı kapattı
    h.rerender(<MapLayer id="l1" name="B" />);
    await settle();
    expect(h.store.getLayer('l1')).toMatchObject({ name: 'B', visible: false });

    h.rerender(<MapLayer id="l1" name="B" visible={false} />);
    await settle();
    h.rerender(<MapLayer id="l1" name="B" visible />); // prop değişti → yazılır
    await settle();
    expect(h.store.getLayer('l1')?.visible).toBe(true);
  });

  it('unmount: katman alt ağacıyla silinir', async () => {
    const h = await renderMap(
      <MapLayer id="l1">
        <MapLayer id="l2" />
      </MapLayer>,
    );
    h.rerender(null);
    await settle();
    expect(h.store.getLayer('l1')).toBeUndefined();
    expect(h.store.getLayer('l2')).toBeUndefined();
  });

  it('canlı katman: içi boş bileşen, unsurlar akıştan; bileşen yeniden render olunca akış unsurlarına dokunulmaz', async () => {
    const h = await renderMap(<MapLayer id="birlikler" renderGroup />);
    act(() => h.store.transaction((tx) => tx.upsertFeatures([streamed('u1', 'birlikler')])));
    h.rerender(<MapLayer id="birlikler" name="Birlikler" renderGroup />);
    await settle();
    expect(h.store.getFeature('u1')).toBeDefined();
  });
});

describe('<MapFeature> ve kısayollar', () => {
  it('kısayollar doğru kind / geometri / props üretir', async () => {
    const h = await renderMap(
      <MapLayer id="l1">
        <Polygon id="pg" rings={[[[0, 0], [1, 0], [1, 1], [0, 0]]]} style={{ fillColor: '#f00' }} />
        <Polyline id="pl" coords={[[0, 0], [1, 1]]} />
        <Circle id="c" center={[32, 39]} radiusM={500} />
        <Marker id="m" coord={[1, 2]} icon="pin" />
        <MilSymbol id="ms" coord={[3, 4]} sidc="10031000001211000000" meta={{ yakıt: 80 }} />
      </MapLayer>,
    );
    const f = (id: string) => h.store.getFeature(id)!;
    expect(f('pg')).toMatchObject({ kind: 'vector', geometry: { kind: 'polygon' }, style: { fillColor: '#f00' } });
    expect(f('pl')).toMatchObject({ kind: 'vector', geometry: { kind: 'line', coords: [[0, 0], [1, 1]] } });
    expect(f('c')).toMatchObject({ kind: 'vector', geometry: { kind: 'circle', radiusM: 500 } });
    expect(f('m')).toMatchObject({ kind: 'marker', geometry: { kind: 'point', coord: [1, 2] }, props: { icon: 'pin' } });
    expect(f('ms')).toMatchObject({ kind: 'milsym', props: { sidc: '10031000001211000000' }, meta: { yakıt: 80 } });
    expect('style' in f('pl')).toBe(false); // verilmeyen opsiyonel alan anahtar olarak da yok
  });

  it('geometri değişince haritaya gider; satır içi aynı içerik tekrar göndermez', async () => {
    const tree = (lon: number) => (
      <MapLayer id="l1">
        <Marker id="m" coord={[lon, 39]} />
      </MapLayer>
    );
    const h = await renderMap(tree(32));
    h.adapter.takeBatches();
    h.rerender(tree(32)); // yeni dizi referansı, aynı içerik
    await h.frame();
    expect(h.adapter.takeBatches()).toEqual([]);
    h.rerender(tree(33));
    await h.frame();
    expect(h.adapter.features.get('m')!.feature.geometry).toEqual({ kind: 'point', coord: [33, 39] });
  });

  it('unmount yalnız kendi id\'sini siler (aynı katmandaki akış unsurları kalır)', async () => {
    const h = await renderMap(
      <MapLayer id="l1">
        <Marker id="m" coord={[1, 2]} />
      </MapLayer>,
    );
    act(() => h.store.transaction((tx) => tx.upsertFeatures([streamed('u1', 'l1')])));
    h.rerender(<MapLayer id="l1" />);
    await settle();
    expect(h.store.getFeature('m')).toBeUndefined();
    expect(h.store.getFeature('u1')).toBeDefined();
  });

  it('id değişince eski silinir, yeni eklenir', async () => {
    const h = await renderMap(<MapLayer id="l1"><Marker id="a" coord={[1, 2]} /></MapLayer>);
    h.rerender(<MapLayer id="l1"><Marker id="b" coord={[1, 2]} /></MapLayer>);
    await settle();
    expect(h.store.getFeature('a')).toBeUndefined();
    expect(h.store.getFeature('b')).toBeDefined();
  });

  it('<MapLayer> dışında hata', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(renderMap(<Marker id="m" coord={[1, 2]} />)).rejects.toThrow(/<MapLayer> içinde/);
  });

  it('StrictMode: ekle → sil → ekle sonunda unsur ve katman store\'da', async () => {
    const h = await renderMap(
      <MapLayer id="l1">
        <Marker id="m" coord={[1, 2]} />
      </MapLayer>,
      {},
      (ui) => <StrictMode>{ui}</StrictMode>,
    );
    expect(h.store.getLayer('l1')).toBeDefined();
    expect(h.store.getFeature('m')).toBeDefined();
  });
});

describe('<MapBasemap>', () => {
  const xyz = { type: BASEMAP_SOURCE.XYZ, urlTemplate: 'https://t/{z}/{x}/{y}.png' } as const;

  it('ekler; exclusiveGroup ile store diğerini kapatır; prop değişimi yalnız o alanı yazar; unmount siler', async () => {
    const tree = (opacity: number) => (
      <>
        <MapBasemap id="a" source={xyz} exclusiveGroup="g" opacity={opacity} />
        <MapBasemap id="b" source={xyz} exclusiveGroup="g" visible={false} />
      </>
    );
    const h = await renderMap(tree(1));
    expect(h.store.getBasemap('a')).toMatchObject({ visible: true, opacity: 1, order: 0, name: 'a' });

    act(() => h.store.transaction((tx) => tx.patchBasemap('b', { visible: true }))); // panelden B seçildi
    expect(h.store.getBasemap('a')?.visible).toBe(false);
    h.rerender(tree(0.5));
    await settle();
    expect(h.store.getBasemap('a')).toMatchObject({ visible: false, opacity: 0.5 }); // görünürlük ezilmedi

    h.rerender(null);
    await settle();
    expect(h.store.getBasemaps()).toEqual([]);
  });
});

describe('<MapOverlay>', () => {
  it('konumu adapter.project ile DOM\'a yazar; anchor yoksa çizilmez', async () => {
    let frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    try {
      function Card() {
        const [anchor, setAnchor] = useState<[number, number] | null>([10, 20]);
        return (
          <MapOverlay anchor={anchor} offset={[5, -5]}>
            <button onClick={() => setAnchor(null)}>kart</button>
          </MapOverlay>
        );
      }
      const h = await renderMap(<Card />);
      const card = document.querySelector('button')!.parentElement!;
      expect(card.style.transform).toBe('translate(15px, 15px)'); // MockAdapter: ekran = koordinat
      expect(card.style.visibility).toBe('visible');

      await h.adapter.flyTo({ center: [0, 0] });
      h.adapter.project = () => ({ x: 100, y: 200 }); // kamera kaydı
      const run = frames;
      frames = [];
      act(() => run.forEach((cb) => cb(16)));
      expect(card.style.transform).toBe('translate(105px, 195px)');

      act(() => document.querySelector('button')!.click());
      expect(document.querySelector('button')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('align: kaydırma içeriğe değil kutunun kendisine (tıklanabilir alan = görünen alan)', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    try {
      await renderMap(
        <MapOverlay anchor={[10, 20]} align="bottom" offset={[0, -8]}>
          <span>balon</span>
        </MapOverlay>,
      );
      const box = document.querySelector('span')!.parentElement!;
      expect(box.style.transform).toBe('translate(10px, 12px) translate(-50%, -100%)');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('<Map> dışında hata', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<MapOverlay anchor={[0, 0]} />)).toThrow(/<Map> içinde/);
  });
});
