import { CLUSTER_KIND, ClusterStage, GEOMETRY_KIND, MAP_EVENT, type Feature } from '@c2/map-core';
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapLayer } from './components/map-layer';
import { zoomToCluster } from './map';
import { renderMap } from './testing';

// Başlangıç görünümü zoom 7 (testing.tsx); bu zoom'da 0,01° arayla iki birlik aynı hücrede.
const unit = (id: string, lon: number): Feature => ({
  id,
  layerId: 'birlikler',
  kind: 'milsym',
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [lon, 39] },
});

const clusterIds = (features: Map<string, { feature: Feature }>) =>
  [...features.values()].filter((rf) => rf.feature.kind === CLUSTER_KIND).map((rf) => rf.feature.id);

describe('<Map stages> — kümeleme', () => {
  it('ilk karede kümeler (görünüm mount\'ta okunur); aşama kaldırılınca unsurlar geri gelir', async () => {
    const stage = new ClusterStage();
    const h = await renderMap(<MapLayer id="birlikler" />, { stages: [stage] });
    act(() => h.store.transaction((tx) => tx.upsertFeatures([unit('a', 32), unit('b', 32.01)])));
    await h.frame();
    const [id] = clusterIds(h.adapter.features);
    expect(id).toBeDefined();
    expect(h.adapter.features.has('a')).toBe(false);

    h.rerenderProps({ stages: [] });
    await h.frame();
    expect(clusterIds(h.adapter.features)).toEqual([]);
    expect(h.adapter.features.has('a') && h.adapter.features.has('b')).toBe(true);
  });

  it('kümeye tıklama: seçim değişmez, CLUSTER_CLICK yayılır ve kümeye yakınlaşılır', async () => {
    const stage = new ClusterStage();
    const h = await renderMap(<MapLayer id="birlikler" />, { stages: [stage] });
    act(() => h.store.transaction((tx) => tx.upsertFeatures([unit('a', 32), unit('b', 32.01)])));
    await h.frame();
    act(() => h.store.transaction((tx) => tx.select(['a'])));
    const [id] = clusterIds(h.adapter.features);
    const fitBounds = vi.spyOn(h.adapter, 'fitBounds');

    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, featureId: id }));
    expect([...h.store.getSelection()]).toEqual(['a']); // kümeye tıklama seçimi temizlemez
    expect(fitBounds).toHaveBeenCalledWith({ min: [32, 39], max: [32.01, 39] }, { paddingPx: 80 });
  });

  it('zoomToCluster: üyeler aynı noktadaysa iki zoom yakınlaşır', () => {
    const map = { fitBounds: vi.fn(), flyTo: vi.fn(async () => {}) };
    zoomToCluster(map, { id: 'cluster:x', count: 3, key: '', ids: ['a', 'b', 'c'], center: [32, 39], bounds: { min: [32, 39], max: [32, 39] }, zoom: 9 });
    expect(map.flyTo).toHaveBeenCalledWith({ center: [32, 39], zoom: 11 });
    expect(map.fitBounds).not.toHaveBeenCalled();
  });
});
