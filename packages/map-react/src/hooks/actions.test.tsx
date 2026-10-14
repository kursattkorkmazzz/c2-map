import { ACTION_RESULT, GEOMETRY_KIND, MAP_EVENT, type Feature, type FeatureLifecycle, type LngLat } from '@c2/map-core';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DrawToolbar } from '../components/draw-toolbar';
import { MapFeature } from '../components/map-feature';
import { MapLayer } from '../components/map-layer';
import { renderMap } from '../testing';
import { useFeatureActions, useFeaturePermissions } from './use-feature-actions';

const point = (coord: LngLat = [32, 39]) => ({ kind: GEOMETRY_KIND.POINT, coord }) as const;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let perms: ReturnType<typeof useFeaturePermissions> | undefined;
let actions: ReturnType<typeof useFeatureActions> | undefined;
function Probe({ id }: { id: string }) {
  perms = useFeaturePermissions(id);
  actions = useFeatureActions();
  return null;
}

describe('izinler', () => {
  it('<MapLayer deletable={false}> alt ağaca miras; <MapFeature editable={false}>; varsayılan açık', async () => {
    const tree = (deletable?: boolean) => (
      <>
        <MapLayer id="kontrol" deletable={deletable}>
          <MapFeature id="k1" kind="vector" geometry={point()} editable={false} />
        </MapLayer>
        <Probe id="k1" />
      </>
    );
    const h = await renderMap(tree(false));
    expect(perms).toEqual({ canEdit: false, canDelete: false, pending: false });
    h.rerender(tree(undefined));
    await h.frame();
    expect(perms).toEqual({ canEdit: false, canDelete: true, pending: false });
  });

  it('store\'daki bayrak değişince hook render olur (ör. backend izni geri çekti)', async () => {
    const h = await renderMap(
      <>
        <MapLayer id="cizimler">
          <MapFeature id="c1" kind="vector" geometry={point()} />
        </MapLayer>
        <Probe id="c1" />
      </>,
    );
    expect(perms!.canDelete).toBe(true);
    act(() => h.store.transaction((tx) => tx.patchLayer('cizimler', { deletable: false })));
    expect(perms!.canDelete).toBe(false);
  });
});

describe('<Map lifecycle> ile silme', () => {
  it('backend onaylı: bekliyor → onay → silinir; bekleme hook\'a yansır', async () => {
    const backend = deferred<boolean>();
    const beforeDelete = vi.fn(() => backend.promise);
    const h = await renderMap(
      <>
        <MapLayer id="kontrol">
          <MapFeature id="k1" kind="vector" geometry={point()} />
        </MapLayer>
        <Probe id="k1" />
      </>,
      { lifecycle: { beforeDelete } },
    );
    let result: unknown;
    act(() => {
      actions!.delete('k1').then((r) => (result = r));
    });
    expect(perms!.pending).toBe(true);
    expect(h.store.getFeature('k1')).toBeDefined();
    await act(async () => backend.resolve(true));
    expect(result).toBe(ACTION_RESULT.DONE);
    expect(h.store.getFeature('k1')).toBeUndefined();
    expect(beforeDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'k1' }));
  });

  it('kanca prop\'u her render\'da güncel (satır içi fonksiyon)', async () => {
    const lifecycle = (allow: boolean): FeatureLifecycle => ({ beforeDelete: () => allow });
    const tree = (
      <>
        <MapLayer id="l">
          <MapFeature id="f" kind="vector" geometry={point()} />
        </MapLayer>
        <Probe id="f" />
      </>
    );
    const h = await renderMap(tree, { lifecycle: lifecycle(false) });
    await act(async () => expect(await actions!.delete('f')).toBe(ACTION_RESULT.REJECTED));
    h.rerenderProps({ lifecycle: lifecycle(true) });
    await act(async () => expect(await actions!.delete('f')).toBe(ACTION_RESULT.DONE));
  });
});

describe('<DrawToolbar layerId>: çizim lifecycle\'dan geçerek eklenir', () => {
  it('beforeCreate backend id\'si verir → o eklenir; onComplete sonucu alır', async () => {
    const onComplete = vi.fn();
    const beforeCreate = vi.fn(async (f: Feature) => ({ ...f, id: 'srv-7', rev: 1 }));
    const h = await renderMap(
      <>
        <MapLayer id="cizimler" />
        <DrawToolbar layerId="cizimler" featureStyle={{ strokeColor: '#0ff' }} onComplete={onComplete} />
      </>,
      { lifecycle: { beforeCreate } },
    );
    fireEvent.click(screen.getByLabelText('Nokta'));
    await act(async () => {
      h.adapter.emit({ type: MAP_EVENT.CLICK, coord: [32, 39] });
    });
    expect(beforeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ layerId: 'cizimler', kind: 'vector', style: { strokeColor: '#0ff' }, meta: { tool: 'point' } }),
    );
    expect(h.store.getFeature('srv-7')).toMatchObject({ layerId: 'cizimler', rev: 1 });
    expect(onComplete).toHaveBeenCalledWith(point(), 'point', expect.objectContaining({ result: ACTION_RESULT.DONE }));
  });

  it('beforeCreate false → eklenmez', async () => {
    const h = await renderMap(
      <>
        <MapLayer id="cizimler" />
        <DrawToolbar layerId="cizimler" createId={() => 'x1'} />
      </>,
      { lifecycle: { beforeCreate: () => false } },
    );
    fireEvent.click(screen.getByLabelText('Nokta'));
    await act(async () => {
      h.adapter.emit({ type: MAP_EVENT.CLICK, coord: [32, 39] });
    });
    expect(h.store.getFeature('x1')).toBeUndefined();
  });
});
