// ── <Map> ────────────────────────────────────────────────────────
// Tasarım: plan/design/07-react-api.md#kabuk
//
// Container + adapter.mount + MapSync + EventRouter. Store hemen vardır (mount beklenmez):
// çocuk bileşenler ve hook'lar ilk render'dan itibaren store'a yazar/okur; MapSync mount bitince
// tam senkronla hepsini haritaya taşır.

import {
  BasemapProviderRegistry,
  createMapStore,
  EventRouter,
  FeatureKindRegistry,
  MAP_EVENT,
  MapSync,
  SymbologyRegistry,
  type CameraView,
  type MapAdapter,
  type MapStore,
  type Scheduler,
} from '@c2/map-core';
import {
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { MapContext, StoreContext, type MapContextValue } from './context';
import { DeclarativeWriter } from './declarative-writer';
import { createMapHandle, type MapHandle } from './map-handle';

export type MapProps = {
  /** Motor adapter'ı (ör. `createMaplibreAdapter(...)`). Değişirse harita yeniden mount edilir. */
  adapter: MapAdapter;
  /** Yalnız ilk mount'ta okunur. */
  initialView: CameraView;
  /** Verilmezse üstteki `MapStoreProvider`'ınki, o da yoksa kendi store'u. İlk render'dan sonra değişmez. */
  store?: MapStore;
  kinds?: FeatureKindRegistry;
  symbology?: SymbologyRegistry;
  basemapProviders?: BasemapProviderRegistry;
  /** MapSync zamanlayıcısı (varsayılan: rAF + en fazla 10 Hz). */
  scheduler?: Scheduler;
  /**
   * Varsayılan etkileşimler (varsayılan `true`): tıklama → seçim (boşa tıklama seçimi temizler),
   * üzerine gelme → hover. Global dinleyicidir: unsur/katman dinleyicisinde `stopPropagation()`
   * çağırmak varsayılanı engeller.
   */
  defaultInteractions?: boolean;
  className?: string;
  style?: CSSProperties;
  onReady?: (map: MapHandle) => void;
  /** Mount hatası (varsayılan: konsola). */
  onError?: (error: unknown) => void;
  ref?: Ref<MapHandle>;
  children?: ReactNode;
};

/**
 * Aynı adapter'ın bir önceki unmount'u bitmeden yeniden mount edilmemesi için (StrictMode'da
 * effect'ler mount → unmount → mount çalışır; `adapter.mount` asenkron).
 */
const lifecycle = new WeakMap<MapAdapter, Promise<unknown>>();

export function Map(props: MapProps) {
  const {
    adapter,
    defaultInteractions = true,
    className,
    style,
    ref,
    children,
  } = props;

  const outerStore = useContext(StoreContext);
  const [store] = useState(() => props.store ?? outerStore ?? createMapStore());
  const [router] = useState(() => new EventRouter(store));
  const [writer] = useState(() => new DeclarativeWriter(store));
  const [ready, setReady] = useState(false);

  // Mount'ta bir kez okunanlar ve geri çağrılar: effect bağımlılığı olmasınlar.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const readyRef = useRef(false);

  const handle = useMemo(() => createMapHandle(store, adapter, () => readyRef.current), [store, adapter]);
  useImperativeHandle(ref, () => handle, [handle]);

  const mapElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = mapElement.current!;
    const options = latest.current;
    let active = true;
    let sync: MapSync | null = null;
    const detach: (() => void)[] = [];

    const previous = lifecycle.get(adapter) ?? Promise.resolve();
    const mounted = previous.then(async () => {
      if (!active) return false;
      await adapter.mount(container, {
        initialView: options.initialView,
        events: router,
        kinds: options.kinds ?? new FeatureKindRegistry(),
        symbology: options.symbology ?? new SymbologyRegistry(),
        basemapProviders: options.basemapProviders ?? new BasemapProviderRegistry(),
      });
      return true;
    });

    mounted.then(
      (ok) => {
        if (!ok || !active) return;
        const currentSync = (sync = new MapSync({ store, adapter, scheduler: options.scheduler }));
        currentSync.start();
        detach.push(router.on(MAP_EVENT.VIEW_CHANGE, (e) => e.view && currentSync.setView(e.view)));
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(() => adapter.resize());
          observer.observe(container);
          detach.push(() => observer.disconnect());
        }
        readyRef.current = true;
        setReady(true);
        latest.current.onReady?.(handle);
      },
      (error) => (latest.current.onError ?? console.error)(error),
    );

    return () => {
      active = false;
      readyRef.current = false;
      setReady(false);
      for (const off of detach.splice(0)) off();
      const done = mounted.then(
        (ok) => {
          sync?.stop();
          if (ok) adapter.unmount();
        },
        () => {},
      );
      lifecycle.set(adapter, done);
    };
  }, [adapter, store, router, handle]);

  // Varsayılan etkileşimler (global dinleyiciler: hedefli dinleyiciler stopPropagation ile engelleyebilir).
  useEffect(() => {
    if (!defaultInteractions) return;
    const offs = [
      router.on(MAP_EVENT.CLICK, (e) =>
        store.transaction((tx) => (e.featureId ? tx.select([e.featureId]) : tx.clearSelection())),
      ),
      router.on(MAP_EVENT.POINTER_ENTER, (e) => store.transaction((tx) => tx.setHovered(e.featureId ?? null))),
      router.on(MAP_EVENT.POINTER_LEAVE, () => store.transaction((tx) => tx.setHovered(null))),
    ];
    return () => offs.forEach((off) => off());
  }, [defaultInteractions, router, store]);

  const context = useMemo<MapContextValue>(
    () => ({ store, router, adapter, writer, ready, handle }),
    [store, router, adapter, writer, ready, handle],
  );

  return (
    <StoreContext.Provider value={store}>
      <MapContext.Provider value={context}>
        <div className={className} style={{ position: 'relative', overflow: 'hidden', ...style }}>
          <div ref={mapElement} style={{ position: 'absolute', inset: 0 }} />
          {children}
        </div>
      </MapContext.Provider>
    </StoreContext.Provider>
  );
}

/** <Map> dışındaki bileşenler (yan panel, LayerTree) store hook'larını kullanabilsin diye. */
export function MapStoreProvider({ store, children }: { store: MapStore; children?: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
