import type { Bounds, CameraView, LngLat, MapAdapter, MapCapabilities, MapStore } from '@c2/map-core';

/** İmperatif harita API'si: `useMap()` ve `<Map ref>`. */
export type MapHandle = {
  readonly store: MapStore;
  readonly adapter: MapAdapter;
  /** Harita mount edildi mi? Kamera metodları ancak `true` iken çalışır. */
  readonly ready: boolean;
  readonly capabilities: MapCapabilities;
  setView(view: CameraView, options?: { animate?: boolean }): void;
  flyTo(view: CameraView, options?: { durationMs?: number }): Promise<void>;
  fitBounds(bounds: Bounds, options?: { paddingPx?: number }): void;
  getView(): CameraView;
  getBounds(): Bounds;
  project(coord: LngLat): { x: number; y: number } | null;
  unproject(point: { x: number; y: number }): LngLat | null;
};

export function createMapHandle(store: MapStore, adapter: MapAdapter, isReady: () => boolean): MapHandle {
  const live = (): MapAdapter => {
    if (!isReady()) throw new Error('Harita henüz hazır değil (mount sürüyor). `ready` veya `onReady` kullanın.');
    return adapter;
  };
  return {
    store,
    adapter,
    get ready() {
      return isReady();
    },
    get capabilities() {
      return adapter.capabilities;
    },
    setView: (view, options) => live().setView(view, options),
    flyTo: (view, options) => live().flyTo(view, options),
    fitBounds: (bounds, options) => live().fitBounds(bounds, options),
    getView: () => live().getView(),
    getBounds: () => live().getBounds(),
    project: (coord) => live().project(coord),
    unproject: (point) => live().unproject(point),
  };
}
