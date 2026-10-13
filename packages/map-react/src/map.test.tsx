import { GEOMETRY_KIND, MAP_EVENT, type Feature } from '@c2/map-core';
import { act, render } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MapFeature } from './components/map-feature';
import { MapLayer } from './components/map-layer';
import { useFeatureEvent } from './hooks/event-hooks';
import { Map } from './map';
import type { MapHandle } from './map-handle';
import { renderMap, settle, StrictMockAdapter } from './testing';

const point = (id: string, layerId = 'l1'): Feature => ({
  id,
  layerId,
  kind: 'marker',
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [32, 39] },
});

describe('<Map>', () => {
  it('adapter\'ı container\'a mount eder, MapSync ile store içeriğini taşır, onReady çağırır', async () => {
    const onReady = vi.fn();
    const h = await renderMap(
      <MapLayer id="l1">
        <MapFeature id="f1" kind="marker" geometry={{ kind: GEOMETRY_KIND.POINT, coord: [1, 2] }} />
      </MapLayer>,
      { onReady },
    );
    expect(h.adapter.mounted).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0]![0].ready).toBe(true);
    // Mount'tan önce yazılanlar ilk tam senkronla gelir
    expect(h.adapter.features.has('f1')).toBe(true);
  });

  it('unmount → MapSync durur, adapter.unmount', async () => {
    const h = await renderMap(null);
    h.unmount();
    await settle();
    expect(h.adapter.mounted).toBe(false);
    expect(h.adapter.unmountCount).toBe(1);
  });

  it('StrictMode: çift effect\'e rağmen adapter aynı anda iki kez mount edilmez, sonunda mount kalır', async () => {
    const onError = vi.fn();
    const h = await renderMap(null, { onError }, (ui) => <StrictMode>{ui}</StrictMode>);
    await settle();
    expect(onError).not.toHaveBeenCalled();
    expect(h.adapter.mounted).toBe(true);
    expect(h.adapter.mountCount - h.adapter.unmountCount).toBe(1);
  });

  it('mount sürerken kapatılıp aynı adapter\'la yeniden açılırsa: önceki unmount bitmeden mount edilmez', async () => {
    const adapter = new StrictMockAdapter();
    const onError = vi.fn();
    const view = { center: [0, 0] as const };
    const first = render(<Map adapter={adapter} initialView={view} onError={onError} />);
    await Promise.resolve(); // mount başladı, bitmedi
    expect(adapter.mountCount).toBe(1);
    first.unmount();
    render(<Map adapter={adapter} initialView={view} onError={onError} />);
    await settle();
    expect(onError).not.toHaveBeenCalled();
    expect(adapter.mounted).toBe(true);
    expect(adapter.mountCount).toBe(2);
    expect(adapter.unmountCount).toBe(1);
  });

  it('adapter değişince eskisi unmount, yenisi mount edilir', async () => {
    const first = new StrictMockAdapter();
    const next = new StrictMockAdapter();
    const view = { center: [0, 0] as const };
    const r = render(<Map adapter={first} initialView={view} />);
    await settle();
    r.rerender(<Map adapter={next} initialView={view} />);
    await settle();
    expect(first.mounted).toBe(false);
    expect(next.mounted).toBe(true);
  });

  it('ref → imperatif API; mount bitmeden kamera çağrısı açık hata verir', async () => {
    const ref = createRef<MapHandle>();
    const adapter = new StrictMockAdapter();
    render(<Map ref={ref} adapter={adapter} initialView={{ center: [0, 0], zoom: 3 }} />);
    expect(ref.current!.ready).toBe(false);
    expect(() => ref.current!.getView()).toThrow(/hazır değil/);
    await settle();
    expect(ref.current!.ready).toBe(true);
    await ref.current!.flyTo({ center: [5, 6], zoom: 9 });
    expect(ref.current!.getView()).toMatchObject({ center: [5, 6], zoom: 9 });
    expect(ref.current!.capabilities.dimension).toBe('2d');
  });

  it('mount hatası onError\'a gider', async () => {
    const adapter = new StrictMockAdapter();
    adapter.mount = async () => {
      throw new Error('WebGL yok');
    };
    const onError = vi.fn();
    render(<Map adapter={adapter} initialView={{ center: [0, 0] }} onError={onError} />);
    await settle();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'WebGL yok' }));
  });
});

describe('<Map> varsayılan etkileşimler', () => {
  it('tıklama seçer, boşa tıklama temizler; enter/leave → hover', async () => {
    const h = await renderMap(null);
    act(() => h.store.transaction((tx) => tx.upsertFeatures([point('a')])));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, featureId: 'a' }));
    expect([...h.store.getSelection()]).toEqual(['a']);
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK }));
    expect(h.store.getSelection().size).toBe(0);

    act(() => h.adapter.emit({ type: MAP_EVENT.POINTER_ENTER, featureId: 'a' }));
    expect(h.store.getHovered()).toBe('a');
    act(() => h.adapter.emit({ type: MAP_EVENT.POINTER_LEAVE, featureId: 'a' }));
    expect(h.store.getHovered()).toBeNull();
  });

  it('defaultInteractions=false → seçim yapılmaz', async () => {
    const h = await renderMap(null, { defaultInteractions: false });
    act(() => h.store.transaction((tx) => tx.upsertFeatures([point('a')])));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, featureId: 'a' }));
    expect(h.store.getSelection().size).toBe(0);
  });

  it('unsur dinleyicisi stopPropagation ile varsayılan seçimi engeller', async () => {
    function Blocker() {
      useFeatureEvent('a', MAP_EVENT.CLICK, (e) => e.stopPropagation());
      return null;
    }
    const h = await renderMap(<Blocker />);
    act(() => h.store.transaction((tx) => tx.upsertFeatures([point('a'), point('b')])));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, featureId: 'a' }));
    expect(h.store.getSelection().size).toBe(0);
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, featureId: 'b' }));
    expect([...h.store.getSelection()]).toEqual(['b']);
  });

  it('VIEW_CHANGE → MapSync.setView: zoom eşiği geçilince unsur gizlenir', async () => {
    const h = await renderMap(
      <MapLayer id="l1" minZoom={8}>
        <MapFeature id="f1" kind="marker" geometry={{ kind: GEOMETRY_KIND.POINT, coord: [1, 2] }} />
      </MapLayer>,
    );
    act(() => h.adapter.emit({ type: MAP_EVENT.VIEW_CHANGE, view: { center: [0, 0], zoom: 9 } }));
    await h.frame();
    expect(h.adapter.features.has('f1')).toBe(true);
    act(() => h.adapter.emit({ type: MAP_EVENT.VIEW_CHANGE, view: { center: [0, 0], zoom: 5 } }));
    await h.frame();
    expect(h.adapter.features.has('f1')).toBe(false);
  });
});
