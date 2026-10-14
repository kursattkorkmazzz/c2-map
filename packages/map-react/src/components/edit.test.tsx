import { ACTION_RESULT, GEOMETRY_KIND, MAP_EVENT, type Geometry, type LngLat } from '@c2/map-core';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMapDraw } from '../hooks/use-map-draw';
import { useMapEdit } from '../hooks/use-map-edit';
import { renderMap, type Harness } from '../testing';
import { DrawToolbar } from './draw-toolbar';
import { MapFeature } from './map-feature';
import { MapLayer } from './map-layer';

const A: LngLat = [32, 39];
const B: LngLat = [32.1, 39];
const line: Geometry = { kind: GEOMETRY_KIND.LINE, coords: [A, B] };

let editApi: ReturnType<typeof useMapEdit> | undefined;
let drawApi: ReturnType<typeof useMapDraw> | undefined;
function Probe() {
  editApi = useMapEdit();
  drawApi = useMapDraw();
  return null;
}

async function setup(props: Parameters<typeof renderMap>[1] = {}, editable?: boolean): Promise<Harness> {
  const h = await renderMap(
    <>
      <MapLayer id="cizimler">
        <MapFeature id="c1" kind="vector" geometry={line} editable={editable} />
      </MapLayer>
      <DrawToolbar />
      <Probe />
    </>,
    props,
  );
  h.adapter.project = (c) => ({ x: c[0] * 1000, y: c[1] * 1000 });
  return h;
}

const click = (h: Harness, coord: LngLat) => act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, coord }));

describe('düzenleme (React)', () => {
  it('başlat → panel; köşeyi taşı → Kaydet → beforeUpdate → asıl kayıt; panel kapanır', async () => {
    const beforeUpdate = vi.fn(async () => true);
    const h = await setup({ lifecycle: { beforeUpdate } });
    act(() => {
      expect(editApi!.start('c1')).toBe(true);
    });
    expect(screen.getByText('Düzenleniyor')).toBeDefined();
    expect((screen.getByText('Kaydet') as HTMLButtonElement).disabled).toBe(true); // değişiklik yok

    click(h, B);
    click(h, [32.2, 39.1]);
    expect(h.store.getDraft('c1')!.feature.geometry).toEqual({ kind: 'line', coords: [A, [32.2, 39.1]] });
    await act(async () => {
      fireEvent.click(screen.getByText('Kaydet'));
    });
    expect(beforeUpdate).toHaveBeenCalled();
    expect(h.store.getFeature('c1')!.geometry).toEqual({ kind: 'line', coords: [A, [32.2, 39.1]] });
    expect(h.store.getDraft('c1')).toBeUndefined();
    expect(screen.queryByText('Düzenleniyor')).toBeNull();
  });

  it('düzenlerken tıklama seçim yapmaz; Esc ile iptal; editable={false} başlamaz', async () => {
    const h = await setup();
    act(() => {
      editApi!.start('c1');
    });
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, coord: [50, 50], featureId: 'c1' }));
    expect(h.store.getSelection().size).toBe(0);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(editApi!.state).toBeNull();
    expect(h.store.getDraft('c1')).toBeUndefined();

    const locked = await setup({}, false);
    act(() => {
      expect(editApi!.start('c1')).toBe(false);
    });
    expect(locked.store.getDraft('c1')).toBeUndefined();
  });

  it('başkası değiştirince uyarı ve "Yine de kaydet"', async () => {
    const h = await setup();
    act(() => {
      editApi!.start('c1');
    });
    click(h, B);
    click(h, [32.2, 39.1]);
    act(() =>
      h.store.transaction((tx) => tx.patchFeatures([{ id: 'c1', geometry: { kind: 'line', coords: [A, [32.3, 39] as LngLat] } }])),
    );
    expect(screen.getByRole('alert').textContent).toContain('başka biri tarafından değiştirildi');
    expect(screen.getByText('Yine de kaydet')).toBeDefined();
  });

  it('kaydetme reddedilirse panel açık kalır, hata yazılır', async () => {
    const h = await setup({ lifecycle: { beforeUpdate: async () => false } });
    act(() => {
      editApi!.start('c1');
    });
    click(h, B);
    click(h, [32.2, 39.1]);
    let result: unknown;
    await act(async () => {
      result = await editApi!.save();
    });
    expect(result).toBe(ACTION_RESULT.REJECTED);
    expect(screen.getByRole('alert').textContent).toContain('reddedildi');
    expect(h.store.getDraft('c1')).toBeDefined();
  });

  it('çizim ve düzenleme birbirini iptal eder', async () => {
    const h = await setup();
    act(() => {
      editApi!.start('c1');
    });
    act(() => {
      void drawApi!.start('point');
    });
    expect(editApi!.state).toBeNull();
    expect(h.store.getDraft('c1')).toBeUndefined();
    act(() => {
      editApi!.start('c1');
    });
    expect(drawApi!.state).toBeNull();
    expect(editApi!.state?.featureId).toBe('c1');
  });
});
