import { GEOMETRY_KIND, MAP_EVENT, type Feature, type LngLat } from '@c2/map-core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMapDraw } from '../hooks/use-map-draw';
import { Map } from '../map';
import { renderMap, StrictMockAdapter } from '../testing';
import { DrawToolbar } from './draw-toolbar';

const A: LngLat = [32, 39];
const B: LngLat = [32.1, 39];
const C: LngLat = [32.1, 39.1];

/** MockAdapter projeksiyonu özdeşlik (1° = 1 px): yakınlık testleri için ölçekle. */
function scaled(adapter: StrictMockAdapter) {
  adapter.project = (c) => ({ x: c[0] * 1000, y: c[1] * 1000 });
}

describe('<DrawToolbar>', () => {
  it('7 araç; seçilen araç basılı, harita çizim modunda, panelde ipucu', async () => {
    const h = await renderMap(<DrawToolbar />);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('data-tool'))).toEqual([
      'point',
      'line',
      'polygon',
      'circle',
      'rectangle',
      'corridor',
      'ellipse',
    ]);
    fireEvent.click(screen.getByLabelText('Poligon'));
    expect(screen.getByLabelText('Poligon').getAttribute('aria-pressed')).toBe('true');
    expect(h.adapter.drawMode).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('İlk noktaya tıklayın');
  });

  it('çiz → canlı ölçüm → Enter ile bitir → onComplete; panel kapanır, mod kapanır', async () => {
    const onComplete = vi.fn();
    const h = await renderMap(<DrawToolbar onComplete={onComplete} />);
    scaled(h.adapter);
    fireEvent.click(screen.getByLabelText('Poligon'));
    for (const coord of [A, B, C]) act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, coord }));
    expect(screen.getByRole('status').textContent).toMatch(/Alan.*km²/);
    expect(screen.getByText('Bitir')).toBeDefined();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Enter' });
    });
    expect(onComplete).toHaveBeenCalledWith({ kind: 'polygon', rings: [[A, B, C, A]] }, 'polygon');
    expect(screen.queryByRole('status')).toBeNull();
    expect(h.adapter.drawMode).toBe(false);
    expect(h.adapter.drawPreview).toBeNull();
  });

  it('Bitir / Geri al / İptal düğmeleri; aynı araca tekrar basmak iptal eder', async () => {
    const onComplete = vi.fn();
    const h = await renderMap(<DrawToolbar onComplete={onComplete} />);
    scaled(h.adapter);
    fireEvent.click(screen.getByLabelText('Çizgi'));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, coord: A }));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, coord: B }));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, coord: C }));
    fireEvent.click(screen.getByText('Geri al'));
    await act(async () => {
      fireEvent.click(screen.getByText('Bitir'));
    });
    expect(onComplete).toHaveBeenCalledWith({ kind: 'line', coords: [A, B] }, 'line');

    fireEvent.click(screen.getByLabelText('Daire'));
    fireEvent.click(screen.getByLabelText('Daire'));
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByLabelText('Elips'));
    fireEvent.click(screen.getByText('İptal'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('çizim sürerken tıklama seçim yapmaz; Esc iptal; yazı alanındaki tuşlar çizime gitmez', async () => {
    const h = await renderMap(
      <>
        <DrawToolbar />
        <input aria-label="arama" />
      </>,
    );
    const unit: Feature = { id: 'u1', layerId: 'l', kind: 'milsym', geometry: { kind: GEOMETRY_KIND.POINT, coord: A } };
    act(() => h.store.transaction((tx) => tx.upsertFeatures([unit])));
    fireEvent.click(screen.getByLabelText('Çizgi'));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, coord: A, featureId: 'u1' }));
    expect(h.store.getSelection().size).toBe(0);

    fireEvent.keyDown(screen.getByLabelText('arama'), { key: 'Escape' });
    expect(screen.queryByRole('status')).not.toBeNull();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('status')).toBeNull();

    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, featureId: 'u1', coord: A })); // çizim bitti: seçim geri
    expect([...h.store.getSelection()]).toEqual(['u1']);
  });

  it('araç alt kümesi, etiketler ve araç seçenekleri (koridor genişliği)', async () => {
    const onComplete = vi.fn();
    const h = await renderMap(
      <DrawToolbar tools={['corridor', 'point']} labels={{ corridor: 'Güzergâh' }} toolOptions={{ corridor: { corridorWidthM: 300 } }} onComplete={onComplete} />,
    );
    scaled(h.adapter);
    expect(screen.getAllByRole('button').map((b) => b.title)).toEqual(['Güzergâh', 'Nokta']);
    fireEvent.click(screen.getByLabelText('Güzergâh'));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, coord: A }));
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, coord: B }));
    await act(async () => {
      h.adapter.emit({ type: MAP_EVENT.DBLCLICK, coord: B });
    });
    expect(onComplete).toHaveBeenCalledWith({ kind: 'corridor', coords: [A, B], widthM: 300 }, 'corridor');
  });

  it('dış kutu haritaya giden tıklamayı yutmaz: yalnız sütun ve panel tıklama alır', async () => {
    await renderMap(<DrawToolbar />);
    fireEvent.click(screen.getByLabelText('Daire'));
    const root = document.querySelector<HTMLElement>('[data-c2-draw-toolbar]')!;
    expect(root.style.pointerEvents).toBe('none');
    expect(screen.getByRole('toolbar').style.pointerEvents).toBe('auto');
    expect(screen.getByRole('status').style.pointerEvents).toBe('auto');
  });

  it('çizim sürerken harita kapanırsa çizim iptal olur, hata yok', async () => {
    const h = await renderMap(<DrawToolbar />);
    fireEvent.click(screen.getByLabelText('Nokta'));
    expect(() => h.unmount()).not.toThrow();
    expect(h.adapter.drawMode).toBe(false);
  });
});

describe('useMapDraw', () => {
  it('harita hazır değilken başlatma açık hatayla reddedilir', async () => {
    let api: ReturnType<typeof useMapDraw> | undefined;
    function Probe() {
      api = useMapDraw();
      return null;
    }
    render(
      <Map adapter={new StrictMockAdapter()} initialView={{ center: [0, 0] }}>
        <Probe />
      </Map>,
    );
    await expect(api!.start('point')).rejects.toThrow(/hazır değil/);
  });

  it('programatik çizim: start → sonuç promise', async () => {
    let api: ReturnType<typeof useMapDraw> | undefined;
    function Probe() {
      api = useMapDraw();
      return null;
    }
    const h = await renderMap(<Probe />);
    let result: unknown;
    act(() => {
      api!.start('rectangle').then((g) => (result = g));
    });
    expect(api!.state?.tool).toBe('rectangle');
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, coord: A }));
    await act(async () => {
      h.adapter.emit({ type: MAP_EVENT.CLICK, coord: C });
    });
    expect(result).toEqual({ kind: 'rectangle', min: A, max: C });
    expect(api!.state).toBeNull();
  });
});
