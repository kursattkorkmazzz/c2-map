// ── <Map> ────────────────────────────────────────────────────────
// Tasarım: plan/design/07-react-api.md#kabuk
//
// Container + adapter.mount + MapSync + EventRouter. Store hemen vardır (mount beklenmez):
// çocuk bileşenler ve hook'lar ilk render'dan itibaren store'a yazar/okur; MapSync mount bitince
// tam senkronla hepsini haritaya taşır.

import {
  BasemapProviderRegistry,
  bindClusterEvents,
  createMapStore,
  DrawController,
  EditController,
  EventRouter,
  FeatureActions,
  type FeatureLifecycle,
  FeatureKindRegistry,
  isClusterSource,
  isSyntheticId,
  MAP_EVENT,
  MapSync,
  SELECT_MODE,
  SymbologyRegistry,
  type CameraView,
  type ClusterInfo,
  type MapAdapter,
  type MapStore,
  type MapTx,
  type PointerModifiers,
  type PresentationStage,
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
   * Sunum aşamaları (ör. `new ClusterStage(...)`): MapSync ile adapter arasında batch'i dönüştürür.
   * Değişince yerinde uygulanır (harita yeniden mount edilmez); dizi her render'da yeni olmasın
   * (`useMemo`). Küme verebilen aşamanın tıklamaları `CLUSTER_CLICK` olarak yayılır.
   */
  stages?: readonly PresentationStage[];
  /**
   * Varsayılan etkileşimler (varsayılan `true`): tıklama → seçim (Ctrl/⌘ toggle, Shift ekle;
   * kümeye tıklama → kümeye yakınlaş;
   * boşa tıklama temizler — `applyClickSelection`), üzerine gelme → hover (`<MapTooltip>` bunu kullanır). Global dinleyicidir: unsur/katman dinleyicisinde `stopPropagation()`
   * çağırmak varsayılanı engeller.
   */
  defaultInteractions?: boolean;
  className?: string;
  style?: CSSProperties;
  /**
   * Kullanıcı işlemlerinin (çizimle ekleme, düzenleme, silme) "önce" kancaları: ör. backend'de
   * yetki kontrolü + kayıt. `false` → iptal; cevap gelene kadar store'a dokunulmaz. Hata /
   * zaman aşımı uygulamanın. Bayraklar (`editable` / `deletable: false`) kancadan önce bakılır.
   */
  lifecycle?: FeatureLifecycle;
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
  const [actions] = useState(() => new FeatureActions(store));
  const edit = useMemo(() => new EditController({ store, actions, events: router, adapter }), [store, actions, router, adapter]);
  // Güncel kancalar (satır içi fonksiyon verilebilir): her render'dan sonra yenilenir.
  useEffect(() => actions.setLifecycle(props.lifecycle ?? {}));
  // Çizim araçları çekirdekte; adapter yalnız mod + önizleme sağlar (karar #8).
  const draw = useMemo(() => new DrawController({ events: router, adapter }), [router, adapter]);
  const [ready, setReady] = useState(false);

  // Mount'ta bir kez okunanlar ve geri çağrılar: effect bağımlılığı olmasınlar.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const readyRef = useRef(false);
  const syncRef = useRef<MapSync | null>(null);

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
        const stages = latest.current.stages ?? [];
        const currentSync = (sync = new MapSync({ store, adapter, scheduler: options.scheduler, stages }));
        // Görünüm ilk tam senkrondan ÖNCE: zoom'a bağlı aşamalar (kümeleme) ilk karede doğru çalışsın.
        currentSync.setView(adapter.getView());
        currentSync.start();
        syncRef.current = currentSync;
        appliedStages.current = stages;
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
      draw.cancel(); // adapter unmount olmadan önce: önizleme / mod / taslak temizlensin
      edit.cancel();
      readyRef.current = false;
      setReady(false);
      for (const off of detach.splice(0)) off();
      syncRef.current = null;
      const done = mounted.then(
        (ok) => {
          sync?.stop();
          if (ok) adapter.unmount();
        },
        () => {},
      );
      lifecycle.set(adapter, done);
    };
  }, [adapter, store, router, handle, draw, edit]);

  // Sunum aşamaları: değişince yerinde (mount'tan önce verilenler mount'ta uygulanır).
  const appliedStages = useRef<readonly PresentationStage[]>([]);
  const stages = props.stages;
  useEffect(() => {
    const next = stages ?? [];
    const sync = syncRef.current;
    if (!ready || !sync || sameStages(next, appliedStages.current)) return;
    sync.setStages(next);
    appliedStages.current = next;
  }, [stages, ready]);
  useEffect(() => {
    const offs = (stages ?? []).flatMap((stage) => (isClusterSource(stage) ? [bindClusterEvents(router, stage)] : []));
    return () => offs.forEach((off) => off());
  }, [stages, router]);

  // Varsayılan etkileşimler (global dinleyiciler: hedefli dinleyiciler stopPropagation ile engelleyebilir).
  useEffect(() => {
    if (!defaultInteractions) return;
    // Çizim / düzenleme sürerken tıklama ona aittir: seçim / hover yapılmaz.
    const busy = () => draw.isDrawing || edit.isEditing;
    const offs = [
      router.on(MAP_EVENT.CLICK, (e) => {
        // Kümeye tıklama seçim değil (CLUSTER_CLICK olarak ayrıca gelir)
        if (busy() || (e.featureId !== undefined && isSyntheticId(e.featureId))) return;
        store.transaction((tx) => applyClickSelection(tx, e.featureId, e.modifiers));
      }),
      router.on(MAP_EVENT.CLUSTER_CLICK, (e) => {
        if (!busy() && e.data) zoomToCluster(handle, e.data as ClusterInfo);
      }),
      router.on(MAP_EVENT.POINTER_ENTER, (e) => {
        if (!busy()) store.transaction((tx) => tx.setHovered(e.featureId ?? null));
      }),
      router.on(MAP_EVENT.POINTER_LEAVE, () => store.transaction((tx) => tx.setHovered(null))),
    ];
    return () => offs.forEach((off) => off());
  }, [defaultInteractions, router, store, draw, edit, handle]);

  // Çizim / düzenleme klavyesi: Esc, Enter, Backspace / Delete (yazı alanındayken değil).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const handled = edit.isEditing ? edit.key(e.key) : draw.key(e.key);
      if (handled) e.preventDefault();
    };
    const sync = () => {
      if (draw.isDrawing || edit.isEditing) document.addEventListener('keydown', onKey);
      else document.removeEventListener('keydown', onKey);
    };
    const offs = [draw.subscribe(sync), edit.subscribe(sync)];
    return () => {
      offs.forEach((off) => off());
      document.removeEventListener('keydown', onKey);
    };
  }, [draw, edit]);

  const context = useMemo<MapContextValue>(
    () => ({ store, router, adapter, writer, ready, handle, draw, edit, actions }),
    [store, router, adapter, writer, ready, handle, draw, edit, actions],
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

/**
 * Tıklama → seçim kuralı (masaüstü alışkanlığı):
 *   tıkla            → yalnız bu (boşa tıklama: temizle)
 *   Ctrl/⌘ + tıkla   → ekle/çıkar (toggle)
 *   Shift + tıkla    → ekle
 *   değiştiriciyle boşa tıklama → seçim korunur (yanlışlıkla kaybolmasın)
 */
export function applyClickSelection(tx: MapTx, featureId: string | undefined, modifiers?: PointerModifiers): void {
  const toggle = modifiers?.ctrl || modifiers?.meta;
  const add = modifiers?.shift;
  if (!featureId) {
    if (!toggle && !add) tx.clearSelection();
    return;
  }
  tx.select([featureId], toggle ? SELECT_MODE.TOGGLE : add ? SELECT_MODE.ADD : SELECT_MODE.REPLACE);
}

/** Kümeye yakınlaş: üyeleri ekrana sığdır; hepsi aynı noktadaysa iki zoom yakınlaş. */
export function zoomToCluster(map: Pick<MapHandle, 'fitBounds' | 'flyTo'>, cluster: ClusterInfo): void {
  const { min, max } = cluster.bounds;
  if (Math.abs(max[0] - min[0]) < 1e-6 && Math.abs(max[1] - min[1]) < 1e-6) {
    void map.flyTo({ center: cluster.center, zoom: cluster.zoom + 2 });
  } else {
    map.fitBounds(cluster.bounds, { paddingPx: 80 });
  }
}

function sameStages(a: readonly PresentationStage[], b: readonly PresentationStage[]): boolean {
  return a.length === b.length && a.every((stage, i) => stage === b[i]);
}

/** <Map> dışındaki bileşenler (yan panel, LayerTree) store hook'larını kullanabilsin diye. */
export function MapStoreProvider({ store, children }: { store: MapStore; children?: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
