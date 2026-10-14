import { GEOMETRY_KIND, MAP_EVENT, type Feature } from '@c2/map-core';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderMap } from '../testing';
import { MapContextMenu } from './map-context-menu';
import { MapTooltip } from './map-tooltip';

const unit = (id: string, layerId = 'birlikler'): Feature => ({
  id,
  layerId,
  kind: 'milsym',
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [32, 39] },
});

const mods = (over: Partial<{ shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }> = {}) => ({
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
  ...over,
});

describe('çoklu seçim (varsayılan etkileşim)', () => {
  it('tıkla: tek; Ctrl/⌘: toggle; Shift: ekle; değiştiriciyle boşa tıklama seçimi korur', async () => {
    const h = await renderMap(null);
    act(() => h.store.transaction((tx) => tx.upsertFeatures([unit('a'), unit('b'), unit('c')])));
    const click = (featureId: string | undefined, modifiers = mods()) =>
      act(() => h.adapter.emit({ type: MAP_EVENT.CLICK, featureId, modifiers }));
    const selected = () => [...h.store.getSelection()].sort();

    click('a');
    click('b', mods({ ctrl: true }));
    expect(selected()).toEqual(['a', 'b']);
    click('a', mods({ meta: true }));
    expect(selected()).toEqual(['b']);
    click('c', mods({ shift: true }));
    click('c', mods({ shift: true })); // Shift: ekler, çıkarmaz
    expect(selected()).toEqual(['b', 'c']);
    click(undefined, mods({ ctrl: true }));
    expect(selected()).toEqual(['b', 'c']);
    click('a');
    expect(selected()).toEqual(['a']);
    click(undefined);
    expect(selected()).toEqual([]);
  });
});

describe('<MapTooltip>', () => {
  it('hover edilen unsur için içerik; imleci DOM üzerinden takip eder; katman süzgeci', async () => {
    const content = vi.fn((id: string) => <span>ipucu {id}</span>);
    const h = await renderMap(<MapTooltip layerId="birlikler">{content}</MapTooltip>);
    act(() =>
      h.store.transaction((tx) => {
        tx.upsertLayers([{ id: 'birlikler', name: 'B', parentId: null, visible: true, opacity: 1 }]);
        tx.upsertFeatures([unit('u1'), unit('k1', 'kontrol')]);
      }),
    );
    expect(screen.queryByText(/ipucu/)).toBeNull();

    act(() => h.adapter.emit({ type: MAP_EVENT.POINTER_MOVE, screen: { x: 100, y: 50 } }));
    act(() => h.adapter.emit({ type: MAP_EVENT.POINTER_ENTER, featureId: 'u1' }));
    const tip = screen.getByText('ipucu u1').parentElement!;
    expect(tip.style.transform).toBe('translate(114px, 64px)');
    expect(tip.style.visibility).toBe('visible');

    content.mockClear();
    act(() => h.adapter.emit({ type: MAP_EVENT.POINTER_MOVE, screen: { x: 200, y: 80 } }));
    expect(tip.style.transform).toBe('translate(214px, 94px)');
    expect(content).not.toHaveBeenCalled(); // imleç hareketi React render'ı değil

    act(() => h.adapter.emit({ type: MAP_EVENT.POINTER_LEAVE, featureId: 'u1' }));
    expect(screen.queryByText(/ipucu/)).toBeNull();

    act(() => h.adapter.emit({ type: MAP_EVENT.POINTER_ENTER, featureId: 'k1' })); // başka katman
    expect(screen.queryByText(/ipucu/)).toBeNull();
  });

  it('içerik null → tooltip yok', async () => {
    const h = await renderMap(<MapTooltip>{() => null}</MapTooltip>);
    act(() => h.store.transaction((tx) => tx.upsertFeatures([unit('u1')])));
    act(() => h.adapter.emit({ type: MAP_EVENT.POINTER_ENTER, featureId: 'u1' }));
    expect(document.querySelector('[style*="pointer-events: none"]')).toBeNull();
  });
});

describe('<MapContextMenu>', () => {
  const menu = (
    <MapContextMenu>
      {(m) => (
        <div>
          <span>menü {m.featureId ?? 'boş'}</span>
          <button onClick={m.close}>Kapat</button>
        </div>
      )}
    </MapContextMenu>
  );
  const rightClick = (h: Awaited<ReturnType<typeof renderMap>>, featureId?: string) =>
    act(() => h.adapter.emit({ type: MAP_EVENT.CONTEXT_MENU, featureId, coord: [32, 39], screen: { x: 40, y: 60 } }));

  it('sağ tıkta tıklanan noktada açılır; unsur id\'si ve close verilir', async () => {
    const h = await renderMap(menu);
    act(() => h.store.transaction((tx) => tx.upsertFeatures([unit('u1')])));
    rightClick(h, 'u1');
    const el = screen.getByRole('menu');
    expect(screen.getByText('menü u1')).toBeDefined();
    expect(el.style.left).toBe('40px');
    expect(el.style.top).toBe('60px');
    fireEvent.click(screen.getByText('Kapat'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('kapanma: Esc, dışarıya basma, harita tıklaması, harita hareketi; içeride basma kapatmaz', async () => {
    const h = await renderMap(menu);
    rightClick(h);
    fireEvent.pointerDown(screen.getByText('menü boş'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    rightClick(h);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    rightClick(h);
    act(() => h.adapter.emit({ type: MAP_EVENT.CLICK }));
    expect(screen.queryByRole('menu')).toBeNull();

    rightClick(h);
    act(() => h.adapter.emit({ type: MAP_EVENT.VIEW_CHANGE, view: { center: [0, 0] } }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('içerik null → açılmaz (ör. yalnız unsur üzerinde menü)', async () => {
    const h = await renderMap(<MapContextMenu>{(m) => (m.featureId ? <span>var</span> : null)}</MapContextMenu>);
    rightClick(h);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
