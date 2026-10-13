import { createMapStore, GEOMETRY_KIND, MAP_EVENT, SELECT_MODE, type Feature, type MapEvent } from '@c2/map-core';
import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MapLayer } from '../components/map-layer';
import { MapStoreProvider } from '../map';
import { renderMap } from '../testing';
import { useFeatureEvent, useLayerEvent, useMapEvent } from './event-hooks';
import {
  useBasemaps,
  useFeature,
  useHovered,
  useLayerVisibility,
  useMap,
  useMapReady,
  useMapStore,
  useSelection,
} from './store-hooks';

const unit = (id: string, meta: Record<string, unknown> = {}, layerId = 'birlikler'): Feature => ({
  id,
  layerId,
  kind: 'milsym',
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [32, 39] },
  meta,
});

describe('useFeature', () => {
  it('yalnız izlenen unsur değişince render olur (diğer binlerce birlik değil)', async () => {
    const renders = vi.fn();
    function Card() {
      const f = useFeature('u1');
      renders();
      return <div data-testid="card">{String(f?.meta?.yakıt ?? '-')}</div>;
    }
    const store = createMapStore();
    store.transaction((tx) => tx.upsertFeatures([unit('u1', { yakıt: 80 }), unit('u2')]));
    render(
      <MapStoreProvider store={store}>
        <Card />
      </MapStoreProvider>,
    );
    expect(screen.getByTestId('card').textContent).toBe('80');
    renders.mockClear();

    act(() => store.transaction((tx) => tx.patchFeatures([{ id: 'u2', meta: { yakıt: 10 } }])));
    expect(renders).not.toHaveBeenCalled();

    act(() => store.transaction((tx) => tx.patchFeatures([{ id: 'u1', meta: { yakıt: 60 } }])));
    expect(screen.getByTestId('card').textContent).toBe('60');
    expect(renders).toHaveBeenCalledTimes(1);

    act(() => store.transaction((tx) => tx.removeFeatures(['u1'])));
    expect(screen.getByTestId('card').textContent).toBe('-');
  });

  it('seçici: seçilen değer değişmedikçe render yok (satır içi seçici olabilir)', async () => {
    const renders = vi.fn();
    function Fuel() {
      const fuel = useFeature('u1', (f) => f?.meta?.yakıt);
      renders();
      return <div data-testid="fuel">{String(fuel)}</div>;
    }
    const store = createMapStore();
    store.transaction((tx) => tx.upsertFeatures([unit('u1', { yakıt: 80, durum: 'a' })]));
    render(
      <MapStoreProvider store={store}>
        <Fuel />
      </MapStoreProvider>,
    );
    renders.mockClear();
    act(() => store.transaction((tx) => tx.patchFeatures([{ id: 'u1', geometry: { kind: 'point', coord: [33, 39] } }])));
    expect(renders).not.toHaveBeenCalled(); // konum değişti, yakıt aynı
    act(() => store.transaction((tx) => tx.patchFeatures([{ id: 'u1', meta: { yakıt: 50, durum: 'a' } }])));
    expect(screen.getByTestId('fuel').textContent).toBe('50');
  });

  it('isEqual: yeni nesne döndüren seçicide eşitse eski sonuç korunur', async () => {
    const results: unknown[] = [];
    function Pos() {
      const pos = useFeature(
        'u1',
        (f) => ({ kind: f?.kind }),
        (a, b) => a.kind === b.kind,
      );
      results.push(pos);
      return null;
    }
    const store = createMapStore();
    store.transaction((tx) => tx.upsertFeatures([unit('u1')]));
    render(
      <MapStoreProvider store={store}>
        <Pos />
      </MapStoreProvider>,
    );
    act(() => store.transaction((tx) => tx.patchFeatures([{ id: 'u1', meta: { x: 1 } }])));
    expect(new Set(results).size).toBe(1);
  });
});

describe('useLayerVisibility / useSelection / useHovered / useBasemaps', () => {
  it('görünürlük okunur ve değiştirilir', async () => {
    let api: ReturnType<typeof useLayerVisibility> | undefined;
    function Toggle() {
      api = useLayerVisibility('l1');
      return null;
    }
    const h = await renderMap(
      <MapLayer id="l1">
        <Toggle />
      </MapLayer>,
    );
    expect(api![0]).toBe(true);
    act(() => api![1](false));
    expect(api![0]).toBe(false);
    expect(h.store.getLayer('l1')?.visible).toBe(false);
  });

  it('seçim: select / toggle / clear; hover okunur', () => {
    let sel: ReturnType<typeof useSelection> | undefined;
    let hovered: string | null = null;
    function Panel() {
      sel = useSelection();
      hovered = useHovered();
      return null;
    }
    const store = createMapStore();
    store.transaction((tx) => tx.upsertFeatures([unit('a'), unit('b')]));
    render(
      <MapStoreProvider store={store}>
        <Panel />
      </MapStoreProvider>,
    );
    act(() => sel!.select('a'));
    expect([...sel!.selected]).toEqual(['a']);
    act(() => sel!.select(['b'], SELECT_MODE.ADD));
    expect([...sel!.selected].sort()).toEqual(['a', 'b']);
    act(() => sel!.toggle('a'));
    expect([...sel!.selected]).toEqual(['b']);
    act(() => sel!.clear());
    expect(sel!.selected.size).toBe(0);

    act(() => store.transaction((tx) => tx.setHovered('b')));
    expect(hovered).toBe('b');
  });

  it('useBasemaps altlık listesini izler', () => {
    let list: readonly unknown[] = [];
    function Panel() {
      list = useBasemaps();
      return null;
    }
    const store = createMapStore();
    render(
      <MapStoreProvider store={store}>
        <Panel />
      </MapStoreProvider>,
    );
    act(() =>
      store.transaction((tx) =>
        tx.upsertBasemaps([{ id: 'x', name: 'X', source: { type: 'xyz', urlTemplate: 'u' }, visible: true, opacity: 1, order: 0 }]),
      ),
    );
    expect(list).toHaveLength(1);
  });

  it('sağlayıcı yoksa açık hata', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Bad() {
      useMapStore();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(/<MapStoreProvider>/);
  });
});

describe('useMap / useMapReady', () => {
  it('hazır olunca imperatif API çalışır', async () => {
    let ready = false;
    let map: ReturnType<typeof useMap> | undefined;
    function Probe() {
      ready = useMapReady();
      map = useMap();
      return null;
    }
    await renderMap(<Probe />);
    expect(ready).toBe(true);
    act(() => map!.setView({ center: [1, 2], zoom: 4 }));
    expect(map!.getView()).toMatchObject({ center: [1, 2], zoom: 4 });
  });
});

describe('olay hook\'ları', () => {
  it('unsur → katman → global kabarma; latest-ref: callback değişince yeniden abone olmadan yenisi çağrılır', async () => {
    const calls: string[] = [];
    function Listeners({ tag }: { tag: string }) {
      useFeatureEvent('u1', MAP_EVENT.CLICK, () => calls.push(`feature:${tag}`));
      useLayerEvent('birlikler', MAP_EVENT.CLICK, () => calls.push(`layer:${tag}`));
      useMapEvent(MAP_EVENT.CLICK, (e: MapEvent) => calls.push(`global:${e.featureId}`));
      return null;
    }
    const h = await renderMap(<Listeners tag="v1" />);
    act(() => h.store.transaction((tx) => tx.upsertFeatures([unit('u1')])));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, featureId: 'u1' }));
    expect(calls).toEqual(['feature:v1', 'layer:v1', 'global:u1']);

    calls.length = 0;
    h.rerender(<Listeners tag="v2" />);
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, featureId: 'u1' }));
    expect(calls).toEqual(['feature:v2', 'layer:v2', 'global:u1']);
  });

  it('hedef değişince eski hedeften çıkar', async () => {
    const calls: string[] = [];
    let setTarget: (id: string) => void = () => {};
    function Listener() {
      const [target, set] = useState('a');
      setTarget = set;
      useFeatureEvent(target, MAP_EVENT.CLICK, (e) => calls.push(e.featureId!));
      return null;
    }
    const h = await renderMap(<Listener />);
    act(() => h.store.transaction((tx) => tx.upsertFeatures([unit('a'), unit('b')])));
    act(() => setTarget('b'));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, featureId: 'a' }));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, featureId: 'b' }));
    expect(calls).toEqual(['b']);
  });

  it('<Map> dışında hata', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Bad() {
      useMapEvent(MAP_EVENT.CLICK, () => {});
      return null;
    }
    expect(() => render(<Bad />)).toThrow(/<Map> içinde/);
  });
});
