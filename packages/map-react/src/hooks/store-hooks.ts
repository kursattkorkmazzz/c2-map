// ── Store hook'ları ──────────────────────────────────────────────
// Tasarım: plan/design/07-react-api.md#hooklar
//
// Hepsi `useSyncExternalStore` + id bazlı abonelik: 50k birlik akarken yalnız İZLENEN unsur
// değişince bileşen render olur. Store değişen nesneye yeni referans verir, değişmeyene vermez;
// seçici sonucu kaynak referansına göre önbelleklenir.

import {
  SELECT_MODE,
  type Basemap,
  type Feature,
  type Layer,
  type MapStore,
  type SelectMode,
  type Unsubscribe,
} from '@c2/map-core';
import { useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { MapContext, StoreContext } from '../context';
import type { MapHandle } from '../map-handle';

/** <Map> veya <MapStoreProvider> altındaki store. */
export function useMapStore(): MapStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useMapStore yalnız <Map> veya <MapStoreProvider> içinde kullanılabilir.');
  return store;
}

/** İmperatif harita API'si (kamera, projeksiyon). Yalnız <Map> içinde. */
export function useMap(): MapHandle {
  const context = useContext(MapContext);
  if (!context) throw new Error('useMap yalnız <Map> içinde kullanılabilir.');
  return context.handle;
}

/** Haritanın mount edilip edilmediği (kamera metodları ancak `true` iken çalışır). */
export function useMapReady(): boolean {
  const context = useContext(MapContext);
  if (!context) throw new Error('useMapReady yalnız <Map> içinde kullanılabilir.');
  return context.ready;
}

const UNSET = Symbol('unset');

/**
 * Genel abone: `read()` kaynağı döner (store referansı), `selector` ondan türetir. Kaynak
 * referansı değişmedikçe seçici yeniden çalışmaz ve aynı sonuç döner; `isEqual` verilirse
 * kaynak değişse bile eşit sonuçta eski referans korunur (gereksiz render yok).
 */
function useStoreValue<S, R>(
  subscribe: (cb: () => void) => Unsubscribe,
  read: () => S,
  selector: ((source: S) => R) | undefined,
  isEqual: ((a: R, b: R) => boolean) | undefined,
): R {
  const getSnapshot = useMemo(() => {
    let source: S | typeof UNSET = UNSET;
    let result: R;
    return () => {
      const next = read();
      if (next === source) return result;
      const value = (selector ? selector(next) : next) as R;
      source = next;
      if (!(isEqual && result !== undefined && isEqual(result, value))) result = value;
      return result;
    };
  }, [read, selector, isEqual]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Tek unsur. `selector` verilirse yalnız seçilen değer değişince render olur:
 * `useFeature(id, f => f?.meta?.yakıt)`. Seçici satır içi olabilir.
 */
export function useFeature(id: string): Feature | undefined;
export function useFeature<R>(id: string, selector: (feature: Feature | undefined) => R, isEqual?: (a: R, b: R) => boolean): R;
export function useFeature<R>(
  id: string,
  selector?: (feature: Feature | undefined) => R,
  isEqual?: (a: R, b: R) => boolean,
): R | Feature | undefined {
  const store = useMapStore();
  const subscribe = useCallback((cb: () => void) => store.subscribeFeature(id, cb), [store, id]);
  const read = useCallback(() => store.getFeature(id), [store, id]);
  return useStoreValue(subscribe, read, selector, isEqual);
}

export function useLayer(id: string): Layer | undefined;
export function useLayer<R>(id: string, selector: (layer: Layer | undefined) => R, isEqual?: (a: R, b: R) => boolean): R;
export function useLayer<R>(
  id: string,
  selector?: (layer: Layer | undefined) => R,
  isEqual?: (a: R, b: R) => boolean,
): R | Layer | undefined {
  const store = useMapStore();
  const subscribe = useCallback((cb: () => void) => store.subscribeLayer(id, cb), [store, id]);
  const read = useCallback(() => store.getLayer(id), [store, id]);
  return useStoreValue(subscribe, read, selector, isEqual);
}

const layerVisible = (layer: Layer | undefined) => layer?.visible;

/** Katmanın KENDİ görünürlük bayrağı ve değiştirici. Katman yoksa `undefined`. */
export function useLayerVisibility(id: string): [visible: boolean | undefined, setVisible: (visible: boolean) => void] {
  const store = useMapStore();
  const visible = useLayer(id, layerVisible);
  const setVisible = useCallback(
    (next: boolean) => store.transaction((tx) => tx.patchLayer(id, { visible: next })),
    [store, id],
  );
  return [visible, setVisible];
}

/** Altlıklar (`order`'a göre sıralı). */
export function useBasemaps(): readonly Basemap[] {
  const store = useMapStore();
  const subscribe = useCallback((cb: () => void) => store.subscribeBasemaps(cb), [store]);
  const read = useCallback(() => store.getBasemaps(), [store]);
  return useStoreValue(subscribe, read, undefined, undefined);
}

export type SelectionApi = {
  readonly selected: ReadonlySet<string>;
  select(ids: string | readonly string[], mode?: SelectMode): void;
  toggle(id: string): void;
  clear(): void;
};

export function useSelection(): SelectionApi {
  const store = useMapStore();
  const subscribe = useCallback((cb: () => void) => store.subscribeSelection(cb), [store]);
  const read = useCallback(() => store.getSelection(), [store]);
  const selected = useStoreValue<ReadonlySet<string>, ReadonlySet<string>>(subscribe, read, undefined, undefined);
  const actions = useMemo(
    () => ({
      select: (ids: string | readonly string[], mode?: SelectMode) =>
        store.transaction((tx) => tx.select(typeof ids === 'string' ? [ids] : ids, mode)),
      toggle: (id: string) => store.transaction((tx) => tx.select([id], SELECT_MODE.TOGGLE)),
      clear: () => store.transaction((tx) => tx.clearSelection()),
    }),
    [store],
  );
  return useMemo(() => ({ selected, ...actions }), [selected, actions]);
}

/** Fare altındaki unsurun id'si. */
export function useHovered(): string | null {
  const store = useMapStore();
  const subscribe = useCallback((cb: () => void) => store.subscribeHover(cb), [store]);
  const read = useCallback(() => store.getHovered(), [store]);
  return useStoreValue(subscribe, read, undefined, undefined);
}
