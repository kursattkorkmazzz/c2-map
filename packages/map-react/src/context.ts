import { createContext, useContext } from 'react';
import type { DrawController, EditController, EventRouter, FeatureActions, MapAdapter, MapStore } from '@c2/map-core';
import type { DeclarativeWriter } from './declarative-writer';
import type { MapHandle } from './map-handle';

/** <Map>'in alt ağaca verdiği her şey. */
export type MapContextValue = {
  store: MapStore;
  router: EventRouter;
  adapter: MapAdapter;
  writer: DeclarativeWriter;
  /** Adapter mount edildi ve MapSync çalışıyor. */
  ready: boolean;
  handle: MapHandle;
  draw: DrawController;
  edit: EditController;
  /** İzinli ekle / güncelle / sil (bayrak + yaşam döngüsü). */
  actions: FeatureActions;
};

export const MapContext = createContext<MapContextValue | null>(null);

/** Yalnız store: <Map> dışındaki paneller (`MapStoreProvider`) de hook'ları kullanabilsin. */
export const StoreContext = createContext<MapStore | null>(null);

/** İç içe <MapLayer>: unsurların ve alt katmanların ebeveyn katmanı. */
export const LayerContext = createContext<string | null>(null);

export function useMapContext(hook: string): MapContextValue {
  const value = useContext(MapContext);
  if (!value) throw new Error(`${hook} yalnız <Map> içinde kullanılabilir.`);
  return value;
}
