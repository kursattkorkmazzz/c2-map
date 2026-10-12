# 05 — MapAdapter sözleşmesi ve olaylar

← [Plan ana sayfası](../README.md) · Faz: [0.4](../phases/phase-0-core.md#04-eventrouter), [0.5](../phases/phase-0-core.md#05-adapter-sözleşmesi-ve-mockadapter), [1](../phases/phase-1-2d-mvp.md)

## Adapter arayüzü

Unsur başına `create/update/remove` yerine **toplu (batch)** uygulama: adapter her karede en
fazla bir kez, birleştirilmiş değişiklik paketi alır.

```ts
export type MapCapabilities = {
  dimension: "2d" | "3d" | "both";
  terrain: boolean;
  models3d: boolean;
  clustering: boolean;
  draw: boolean;
  featureState: boolean; // hover/seçim için veriye dokunmadan boyama
  supportedFeatureKinds: string[];
  supportedBasemapSources: BasemapSourceType[];
};

export interface MapAdapter<TEngine = unknown> {
  readonly capabilities: MapCapabilities;

  // Yaşam döngüsü
  mount(container: HTMLElement, opts: MountOptions): Promise<void>;
  unmount(): void;
  resize(): void;
  getEngine(): TEngine; // kaçış kapağı, tipli

  // Kamera
  setView(view: CameraView, opts?: { animate?: boolean }): void;
  flyTo(view: CameraView, opts?: { durationMs?: number }): Promise<void>;
  fitBounds(bounds: Bounds, opts?: { paddingPx?: number }): void;
  getView(): CameraView;
  getBounds(): Bounds;
  project(c: LngLat): { x: number; y: number } | null;
  unproject(p: { x: number; y: number }): LngLat | null;

  // Tek giriş noktası: MapSync'ten (ve sunum aşamalarından) gelen paket
  applyBatch(batch: RenderBatch): void;

  // Renderer'lar (kind → motor-özel çizici)
  registerRenderer(kind: string, renderer: AdapterRenderer<TEngine>): void;

  // Çizim (capabilities.draw) — Faz 2
  startDraw(kind: GeometryKind, opts?: DrawOptions): DrawSession;
  editFeature(id: string): EditSession;
}

export type MountOptions = {
  initialView: CameraView;
  events: MapEventSink; // adapter ham olayları buraya basar (EventRouter)
  kinds: FeatureKindRegistry;
  symbology: SymbologyRegistry;
  basemapProviders: BasemapProviderRegistry;
};
```

> `HTMLElement` tipi çekirdekte yalnız **tip** olarak geçer; çekirdek DOM'a çalışma
> zamanında dokunmaz (testler Node'da koşar).

## RenderBatch

```ts
// MapSync'in ürettiği paket — adapter yalnız bunu bilir
export type RenderBatch = {
  basemaps?: Diff<Basemap>;
  groups?: Diff<RenderGroup>;
  features?: { upsert: RenderFeature[]; remove: string[] };
  state?: FeatureStatePatch[]; // seçim/hover/vurgu/bayatlık — veriye dokunmaz
};

export type Diff<T> = { upsert: T[]; remove: string[] };

// Motora giden "çözülmüş" unsur: efektif değerler hesaplanmış
export type RenderFeature = {
  feature: Feature;   // aynı referans; adapter kopyalamaz
  groupId: string;    // hangi render group
  opacity: number;    // efektif (ataların çarpımı)
  zIndex: number;     // global sıra
  changed: number;    // FEATURE_CHANGE maskesi (+ efektif OPACITY/Z değişimi)
};

export type FeatureStatePatch = { id: string; state: Partial<FeatureVisualState> };
export type FeatureVisualState = { selected: boolean; hovered: boolean; highlighted: boolean; stale: boolean };
```

## RenderContext

Bir renderer'ın çizerken ihtiyaç duyduğu, adapter tarafından sağlanan bağlam. Motor-özeldir;
çekirdek yalnız ortak kısmı tanımlar:

```ts
// @c2/map-core
export interface RenderContextBase {
  readonly kinds: FeatureKindRegistry;
  readonly symbology: SymbologyRegistry;
  readonly images: ImageAtlas;   // ikon/sembol önbelleği (ref-count + LRU)
  readonly pixelRatio: number;
  requestRepaint(): void;
}

export interface ImageAtlas {
  /** key yoksa factory ile üretir, motora kaydeder; ref-count artırır. */
  acquire(key: string, factory: () => Promise<ImageData | ImageBitmap> | ImageData | ImageBitmap): void;
  release(key: string): void;
  has(key: string): boolean;
}

// @c2/map-maplibre — motor-özel genişletme
export interface MaplibreRenderContext extends RenderContextBase {
  readonly map: maplibregl.Map;
  readonly groupId: string;
  readonly sourceId: string;
  readonly beforeLayerId: string;
}
```

## Renderer türleri

- **MapLibre (veri güdümlü):** unsur başına motor nesnesi yok. Her kind iki şey sağlar:
  1. `layers(ctx)` → render group başına **bir kez** eklenen style layer'lar.
  2. `encode(rf, ctx)` → `RenderFeature`'ı düz GeoJSON parçalarına çeviren **saf** fonksiyon.
- **deck.gl (GPU dizileri):** canlı ve yoğun kind'ler için; ayrıntı [04](04-sync-and-rendering.md#deckgl-yolu).
- **Cesium (Faz 5):** `create/update/remove` ile Billboard/Primitive koleksiyonu.
- Adapter, kind başına hangi renderer'ın kullanılacağını seçer; çekirdek bunu bilmez.

```ts
// @c2/map-maplibre
export interface MaplibreKindRenderer {
  layers(ctx: MaplibreRenderContext): LayerSpecification[];
  encode(rf: RenderFeature, ctx: MaplibreRenderContext): EncodedFeature[]; // saf, memo'lanabilir
}
export type EncodedFeature = {
  id: string; // composite için `${featureId}#${part}`
  geometry: GeoJSON.Geometry;
  properties: Record<string, string | number | boolean>;
};
```

### `changed` maskesi

`RenderFeature.changed` = unsurun kendi `FEATURE_CHANGE` bitleri (0–7) **|** MapSync'in hesapladığı
efektif değer bitleri `RENDER_CHANGE` (8+): `OPACITY` (ata opaklığı değişti), `Z_INDEX` (katman
taşındı / `z` değişti), `GROUP` (unsur başka render group'a geçti). Yeni çizilen unsurda
`RENDER_CHANGE_ALL`. Adapter yalnız ilgili bitler set ise yeniden kodlar.

## MockAdapter

Test için: `applyBatch` çağrılarını sırayla kaydeder (`batches`, `takeBatches()`), batch'ler
uygulandıktan sonra "ekranda ne var" durumunu tutar (`features`, `groups`, `basemaps`, `states`),
kamera durumunu bellekte tutar, `emit` ile sahte etkileşim olayı üretir. MapSync / birleştirme /
görünürlük mantığı motorsuz test edilir.

## EventRouter: global + hedefli abonelik

İhtiyaç: React tarafı tüm unsurları dinlemeden, yalnız ilgilendiği unsurun veya katmanın
olayına abone olabilmeli.

**Akış**

1. Adapter ham olayı yakalar (`click` / `mousemove` / `contextmenu`).
2. Adapter **bir kez** hit-test yapar (yalnız `interactive` katmanlarda) → en üstteki unsur id'si.
3. Adapter normalize olayı `events.emit({ type, featureId?, coord, screen, originalEvent })` ile router'a verir.
4. Router dağıtır — **O(dinleyici sayısı) değil, O(ağaç derinliği)**:

```
feature:<id> dinleyicileri → layer:<ebeveyn> → layer:<büyükebeveyn> … → global
            (stopPropagation() zinciri keser — DOM'daki kabarma gibi)
```

**Veri yapısı:** `Map<EventType, Map<TargetKey, Set<Listener>>>`; `TargetKey` =
`f:<featureId>` | `l:<layerId>` | `*`. Dağıtımda yalnız ilgili anahtarlar okunur.
Katman zinciri store'dan okunur (`feature.layerId` → `layer.parentId` …).

```ts
export const MAP_EVENT = {
  CLICK: "click",
  DBLCLICK: "dblclick",
  CONTEXT_MENU: "contextmenu",
  POINTER_ENTER: "pointerenter", // unsur değişiminde 1 kez
  POINTER_LEAVE: "pointerleave",
  POINTER_MOVE: "pointermove",   // yalnız global; unsur bazlı yok (gürültü)
  VIEW_CHANGE: "viewchange",     // moveend/zoomend, throttle'lı
  DRAW_UPDATE: "draw:update",
  DRAW_COMPLETE: "draw:complete",
  CLUSTER_CLICK: "cluster:click", // sunum aşaması (kümeleme) için ayrılmış
} as const;

export type MapEventTarget =
  | { featureId: string }
  | { layerId: string } // alt ağaçtaki tüm unsurların olayları (kabarma)
  | undefined;          // global

events.on(MAP_EVENT.CLICK, cb, { featureId: "unit-42" });
events.on(MAP_EVENT.CLICK, cb, { layerId: "dusman" });
events.on(MAP_EVENT.VIEW_CHANGE, cb);
```

- **Hover ucuz:** adapter son hover id'sini tutar; `pointerenter/leave` yalnız id değişince üretilir.
- **Olaylar ≠ veri değişiklikleri.** "Unsur 42'nin konumu değişti" bir harita olayı değil,
  **store aboneliğidir** (`store.subscribeFeature(id, cb)` / `useFeature(id)`).
- Sentetik id (`cluster:…`) taşıyan olaylar katman zincirine kabarmaz; `CLUSTER_CLICK` olarak iletilir.

Uygulama ayrıntıları (kod: `src/events/event-router.ts`):

- `stopPropagation()` **sonraki hedefleri** keser; aynı hedefteki diğer dinleyiciler yine çalışır.
- Katman zinciri her olayda store'dan **güncel** okunur (taşınan katman yeni ebeveynine kabarır).
- Yetim unsur: kendi `layerId` dinleyicilerine ve globale gider. Store'da olmayan unsur id'si
  (ör. hit-test ile emit arasında silinmiş): unsur dinleyicileri + global.
- Dinleyici hatası diğerlerini ve kabarmayı durdurmaz (`onListenerError`).
- Olaya ek veri `data` alanıyla taşınır (küme içeriği, çizim geometrisi); `view` alanı `VIEW_CHANGE` içindir.
