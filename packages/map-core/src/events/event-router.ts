// ── EventRouter ──────────────────────────────────────────────────
// Tasarım: plan/design/05-adapter-and-events.md#eventrouter-global--hedefli-abonelik
//
// Adapter ham etkileşimi yakalar, BİR KEZ hit-test yapar ve normalize olayı `emit` ile verir.
// Router olayı DOM'daki kabarma (bubbling) gibi dağıtır:
//
//   f:<unsur> → l:<katmanı> → l:<ebeveyni> … → * (global)      stopPropagation() zinciri keser
//
// Maliyet dinleyici sayısıyla değil, katman ağacının derinliğiyle orantılıdır: 50k unsura ayrı
// dinleyici kayıtlı olsa bile bir tıklama birkaç Map okumasıdır.

import type { CameraView } from "../model/camera";
import type { LngLat } from "../model/geometry";

export const MAP_EVENT = {
  CLICK: "click",
  DBLCLICK: "dblclick",
  CONTEXT_MENU: "contextmenu",
  POINTER_ENTER: "pointerenter", // unsur üzerine gelindi (unsur değişiminde 1 kez)
  POINTER_LEAVE: "pointerleave",
  POINTER_MOVE: "pointermove", // yalnız global; unsur bazlı yok (gürültü)
  VIEW_CHANGE: "viewchange", // moveend/zoomend, throttle'lı
  DRAW_UPDATE: "draw:update",
  DRAW_COMPLETE: "draw:complete",
  CLUSTER_CLICK: "cluster:click", // sunum aşaması (kümeleme) için ayrılmış
} as const;
export type MapEventType = (typeof MAP_EVENT)[keyof typeof MAP_EVENT];

/** Sunum aşamalarının ürettiği sentetik unsurların (küme) id öneki. Store'da yoktur, kabarmaz. */
export const CLUSTER_ID_PREFIX = "cluster:";
export const isSyntheticId = (id: string): boolean => id.startsWith(CLUSTER_ID_PREFIX);

export type ScreenPoint = { x: number; y: number };

/** Adapter'ın ürettiği normalize olay. */
export type MapEventInput = {
  type: MapEventType;
  /** Hit-test sonucu en üstteki unsur (yoksa boş). Sentetik (küme) id olabilir. */
  featureId?: string;
  coord?: LngLat;
  screen?: ScreenPoint;
  /** VIEW_CHANGE için güncel kamera. */
  view?: CameraView;
  /** Olay türüne özel ek veri (ör. kümenin içerdiği unsur id'leri, çizim geometrisi). */
  data?: unknown;
  /** Motorun orijinal olayı (kaçış kapısı). */
  originalEvent?: unknown;
};

/** Hedef: belirli unsur, bir katmanın alt ağacındaki tüm unsurlar veya global (undefined). */
export type MapEventTarget = { featureId: string } | { layerId: string } | undefined;

/** Dinleyiciye verilen olay. */
export type MapEvent = Readonly<MapEventInput> & {
  /** Şu an olayı işleyen hedef (kabarma sırasında değişir). */
  readonly currentTarget: MapEventTarget;
  /** Sonraki hedeflere (üst katmanlar, global) iletmeyi durdurur. Aynı hedefteki diğer dinleyiciler yine çalışır. */
  stopPropagation(): void;
};

export type MapEventListener = (event: MapEvent) => void;

/** Adapter'ın gördüğü yüz: yalnız olay basabilir. */
export interface MapEventSink {
  emit(event: MapEventInput): void;
}

/** Router'ın kabarma zincirini kurmak için store'dan okuduğu kısım. */
export type EventHierarchy = {
  getFeature(id: string): { layerId: string } | undefined;
  getLayer(id: string): { parentId: string | null } | undefined;
};

export type EventRouterOptions = {
  /** Dinleyici hata fırlatırsa çağrılır (diğer dinleyiciler çalışmaya devam eder). */
  onListenerError?: (error: unknown) => void;
};

const GLOBAL_KEY = "*";
const featureKey = (id: string) => `f:${id}`;
const layerKey = (id: string) => `l:${id}`;

export class EventRouter implements MapEventSink {
  /** type → hedef anahtarı → dinleyiciler */
  private readonly listeners = new Map<MapEventType, Map<string, Set<MapEventListener>>>();
  private readonly reportError: (error: unknown) => void;

  constructor(
    private readonly hierarchy: EventHierarchy,
    options: EventRouterOptions = {},
  ) {
    this.reportError =
      options.onListenerError ??
      ((error) =>
        queueMicrotask(() => {
          throw error;
        }));
  }

  /** Abone olur; abonelikten çıkma fonksiyonu döner. Hedef verilmezse global dinleyicidir. */
  on(type: MapEventType, listener: MapEventListener, target?: MapEventTarget): () => void {
    const key = targetKey(target);
    let byKey = this.listeners.get(type);
    if (!byKey) {
      byKey = new Map();
      this.listeners.set(type, byKey);
    }
    let set = byKey.get(key);
    if (!set) {
      set = new Set();
      byKey.set(key, set);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(type)?.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.get(type)?.delete(key);
    };
  }

  emit(input: MapEventInput): void {
    const byKey = this.listeners.get(input.type);
    if (!byKey || byKey.size === 0) return;

    let stopped = false;
    const dispatch = (key: string, currentTarget: MapEventTarget): boolean => {
      const set = byKey.get(key);
      if (set && set.size > 0) {
        const event: MapEvent = {
          ...input,
          currentTarget,
          stopPropagation: () => {
            stopped = true;
          },
        };
        for (const listener of [...set]) {
          try {
            listener(event);
          } catch (error) {
            this.reportError(error);
          }
        }
      }
      return stopped;
    };

    const { featureId } = input;
    // Sentetik (küme) id katman zincirine kabarmaz; yalnız global dinleyicilere gider.
    if (featureId !== undefined && !isSyntheticId(featureId)) {
      if (dispatch(featureKey(featureId), { featureId })) return;

      let layerId = this.hierarchy.getFeature(featureId)?.layerId ?? null;
      const visited = new Set<string>();
      while (layerId !== null && !visited.has(layerId)) {
        visited.add(layerId);
        if (dispatch(layerKey(layerId), { layerId })) return;
        layerId = this.hierarchy.getLayer(layerId)?.parentId ?? null;
      }
    }
    dispatch(GLOBAL_KEY, undefined);
  }
}

function targetKey(target: MapEventTarget): string {
  if (!target) return GLOBAL_KEY;
  return "featureId" in target ? featureKey(target.featureId) : layerKey(target.layerId);
}
