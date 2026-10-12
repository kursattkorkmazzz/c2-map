# Map Component — Detaylı İmplementasyon Planı (rev. 2)

**Framework- ve motor-bağımsız, genişletilebilir harita kütüphanesi**
`@c2/map-core` + `@c2/map-react` + motor adapter paketleri (`@c2/map-maplibre`, sonra `@c2/map-cesium`)

> Amaç: Uygulama, arkada hangi harita motorunun (MapLibre, Cesium, …) çalıştığını
> **bilmeden** katmanları, altlıkları ve canlı güncellenen binlerce unsuru
> (vektör, ikon, askeri sembol, 3D model, composite) yönetir ve çizer.
> Motor, dışarıdan verilen bir **adapter** üzerinden değiştirilebilir.
> React yalnızca bir binding'dir; çekirdek saf TypeScript'tir.

**Rev. 2'de netleşen kararlar**

| Konu | Karar |
|---|---|
| v1 motoru | **MapLibre GL JS** (WebGL, vector tile, data-driven style, feature-state) |
| Cesium | Model + `MapAdapter` + store oturduktan **sonra** (Faz 5) |
| Paketleme | **Ayrı paketler** |
| Koordinat | WGS84, GeoJSON sırası `[lon, lat, alt?]` |
| Askeri sembol | Genişletilebilir **symbology registry**; ilk sağlayıcı APP-6(D) |
| Veri ölçeği | **min. 3.000 unsur, hepsi canlı** (konum, stil, props) |
| Hot path | **React render yolunun dışında**: Store → MapSync → Adapter |
| Reconciler | Yok. Deklaratif bileşenler adapter'a değil **store'a** yazar (bkz. §11) |
| Store | Çekirdekte amaca özel `MapStore` (per-id abonelik + değişiklik günlüğü); zustand yalnız uygulama UI durumu için (bkz. §9) |

---

## 1. İlkeler

1. **Motor bağımsızlığı (hard boundary):** `@c2/map-core` ve `@c2/map-react`
   hiçbir motoru import etmez. MapLibre/Cesium yalnızca adapter paketlerindedir.
2. **Framework bağımsızlığı:** Tüm durum, olay yönlendirme ve senkronizasyon
   `@c2/map-core` içinde (saf TS). React, Vue vb. yalnız ince binding.
3. **Tek doğruluk kaynağı = `MapStore`:** Katmanlar, altlıklar, unsurlar, seçim,
   hover. Harita motoru da LayerTree UI da bu store'un **aboneleridir**.
4. **Hot path React dışında:** Backend → store → (kare başına toplu) adapter.
   React yalnızca ekranda gösterdiği dilime (seçili birim kartı, görünen ağaç
   satırları) per-id abone olur.
5. **Genişletilebilirlik (registry):** Yeni unsur türleri (`kind`), yeni altlık
   sağlayıcıları, yeni sembolojiler ve yeni motorlar çekirdeği değiştirmeden eklenir.
6. **Yetenek müzakeresi (capabilities) + zarif düşüş.**
7. **Repo konvansiyonları:** `enum` yok (const object + türetilmiş tip),
   `import type`, `noUncheckedIndexedAccess`.

---

## 2. Mimari genel bakış

```
 Backend (WS/SSE)                                  React / UI
      │ delta + snapshot                            │  <Map>, <MapLayer>, <MapFeature>
      ▼                                             │  useFeature(id), useLayer(id) …
┌──────────────┐  batch   ┌───────────────────────────────────────────────┐
│ Ingest       │────────▶ │ MapStore (@c2/map-core)                       │
│ (ops. Worker)│          │  layers · basemaps · features · selection     │
└──────────────┘          │  ├─ per-id abonelik (React satırları, kartlar) │
                          │  └─ değişiklik günlüğü (dirty set)            │
                          └───────────────┬───────────────────────────────┘
                                          │ rAF başına 1 flush (coalesce)
                          ┌───────────────▼───────────────────────────────┐
                          │ MapSync (@c2/map-core)                        │
                          │  efektif görünürlük/opaklık/z hesapla,         │
                          │  RenderBatch üret                              │
                          └───────────────┬───────────────────────────────┘
                                          │ adapter.applyBatch(batch)
       ┌──────────────────────────────────▼────────────────────────────────┐
       │ MapAdapter (sözleşme)                                             │
       │  @c2/map-maplibre: kind encoder → GeoJSON source.updateData(diff)│
       │                    seçim/hover → feature-state                    │
       │  @c2/map-cesium (sonra): Primitive/Billboard koleksiyonları       │
       │  MockAdapter (test)                                               │
       └──────────────────────────────────┬────────────────────────────────┘
                                          │ ham etkileşim (hit-test sonucu)
                          ┌───────────────▼───────────────────────────────┐
                          │ EventRouter (@c2/map-core)                    │
                          │  feature → üst katmanlar → map (bubbling)     │
                          │  hedefli (id bazlı) + global dinleyiciler     │
                          └───────────────────────────────────────────────┘
```

---

## 3. Paket yapısı

| Paket | İçerik | Bağımlılık |
|---|---|---|
| `@c2/map-core` | Tipler, `MapStore`, `MapSync`, `EventRouter`, `MapAdapter` sözleşmesi, `FeatureKindRegistry`, `BasemapProviderRegistry`, `SymbologyRegistry` arayüzü, koordinat util, `MockAdapter`. | yok (ops. `mgrs`) |
| `@c2/map-react` | `<Map>`, `<MapLayer>`, `<MapFeature>`, `<MapBasemap>`, `<MapOverlay>`, hook'lar (`useMap`, `useFeature`, `useFeatureEvent` …). Ayrı entry: `@c2/map-react/layer-tree` (headless-tree köprüsü). | `@c2/map-core`, react (peer) |
| `@c2/map-maplibre` | `MapAdapter` MapLibre implementasyonu, kind encoder'ları, image atlas, draw entegrasyonu. | `maplibre-gl`, `@c2/map-core` |
| `@c2/map-symbology` | `SymbologyProvider` arayüzü + ortak önbellek/rasterize yardımcıları. | `@c2/map-core` |
| `@c2/map-symbology-app6` | `milsymbol` tabanlı APP-6(D) sağlayıcısı (sonra 2525, kurum içi sembolojiler ayrı paket). | `milsymbol` |
| `@c2/map-cesium` (sonra) | Cesium adapter. | `cesium` |
| `@c2/ui` | Stilli kompozisyonlar: `MapLayerTree` (mevcut `layer-tree` + `@c2/map-react/layer-tree`), harita kontrolleri, overlay kartları. | `@c2/map-react` |

> `@c2/ui` motor import etmez. Adapter'lar app kökünde lazy import edilir:
> `const { createMaplibreAdapter } = await import('@c2/map-maplibre')`.

---

## 4. Çekirdek modeller (`@c2/map-core`)

### 4.1 Neden `Layer.kind` kalktı

İlk planda `Layer.kind: 'group' | 'feature-layer'` vardı: "katman içeren klasör" ile
"unsur içeren katman"ı ayırmak içindi. Buna gerek yok:

- **Layer = grup.** İçinde hem alt `Layer` hem `Feature` olabilir.
- **Feature = çizilebilir birim.** Her zaman tam olarak bir `Layer`'a aittir.
- Ağaç düğümü `Layer | Feature`'dır; ayrım düğümün **tipiyle** yapılır, ek bir alanla değil.

Bir katmanın "boş klasör" mü yoksa "unsur katmanı" mı olduğu içeriğinden belli olur.
Motorun hangi kaynağa çizeceği ayrı bir konudur (§6.3 *render group*), modelde tutulmaz.

### 4.2 Tipler

```ts
// Koordinat: kanonik WGS84, GeoJSON sırası [lon, lat, alt?]
export type LngLat = readonly [number, number] | readonly [number, number, number];

export const GEOMETRY_KIND = {
  POINT: 'point',
  LINE: 'line',
  POLYGON: 'polygon',
  MULTI_POINT: 'multi-point',
  MULTI_LINE: 'multi-line',
  MULTI_POLYGON: 'multi-polygon',
  CIRCLE: 'circle',
  RECTANGLE: 'rectangle',
} as const;
export type GeometryKind = (typeof GEOMETRY_KIND)[keyof typeof GEOMETRY_KIND];

export type Geometry =
  | { kind: typeof GEOMETRY_KIND.POINT; coord: LngLat }
  | { kind: typeof GEOMETRY_KIND.LINE; coords: LngLat[] }
  | { kind: typeof GEOMETRY_KIND.POLYGON; rings: LngLat[][] }
  | { kind: typeof GEOMETRY_KIND.CIRCLE; center: LngLat; radiusM: number }
  | { kind: typeof GEOMETRY_KIND.RECTANGLE; min: LngLat; max: LngLat }
  | { kind: typeof GEOMETRY_KIND.MULTI_POINT; coords: LngLat[] }
  | { kind: typeof GEOMETRY_KIND.MULTI_LINE; lines: LngLat[][] }
  | { kind: typeof GEOMETRY_KIND.MULTI_POLYGON; polygons: LngLat[][][] };

// ── Katman (grup) ────────────────────────────────────────────────
export type Layer = {
  id: string;
  name: string;
  parentId: string | null;   // null = kök
  visible: boolean;          // kendi bayrağı; efektif görünürlük MapSync'te hesaplanır
  opacity: number;           // 0..1; efektif = atalarla çarpım
  selectable?: boolean;
  interactive?: boolean;     // false → hit-test'e hiç girmez (perf)
  minZoom?: number;
  maxZoom?: number;
  renderGroup?: boolean;     // true → motor bu alt ağaç için ayrı kaynak açar (§6.3)
  meta?: Record<string, unknown>;
};

// ── Unsur (çizilebilir) ──────────────────────────────────────────
export type Feature<K extends string = string, S = unknown, P = unknown> = {
  id: string;
  layerId: string;           // ait olduğu katman
  kind: K;                   // 'vector' | 'marker' | 'milsym' | 'model3d' | 'composite' | custom
  geometry: Geometry;
  style?: S;                 // kind'e özel görsel stil       → motora gider
  props?: P;                 // kind'e özel görsel veri (SIDC, etiket, model url) → motora gider
  z?: number;                // katman içi sıra
  hidden?: boolean;
  selectable?: boolean;
  meta?: Record<string, unknown>; // domain verisi (yakıt, durum…) → MOTORA GİTMEZ
  rev?: number;              // backend sürüm/sequence; sıra dışı güncellemeyi düşürmek için
  origin?: FeatureOrigin;    // kim yönetiyor (aşağıda)
};

export const FEATURE_ORIGIN = {
  REMOTE: 'remote',          // backend akışı
  DECLARATIVE: 'declarative',// <MapFeature> bileşeni
  DRAWN: 'drawn',            // kullanıcı çizimi
} as const;
export type FeatureOrigin = (typeof FEATURE_ORIGIN)[keyof typeof FEATURE_ORIGIN];
```

> `style`/`props`/`geometry` **görsel** alanlardır, değişince haritaya gider.
> `meta` **görsel olmayan** domain verisidir, değişince yalnız React abonelerine
> (kart, tablo) gider; harita hiç dokunulmaz. Bu ayrım perf'in temelidir (§6).

### 4.3 Altlıklar (basemap) — ayrı tip

Altlıklar `Layer` değildir, çünkü:
- Unsur içermezler; bir **tile/görüntü kaynağıdırlar**.
- Her zaman tüm operasyonel katmanların **altında** çizilirler.
- Sağlayıcıya özel konfigürasyonları vardır (URL şablonu, tileSize, auth header,
  attribution, min/max zoom, WMS parametreleri, görüntü köşe koordinatları).

Ama **aynı store'da** tutulurlar ve LayerTree'de ayrı bir kök bölüm ("Altlıklar")
olarak görünürler. n tanesi aynı anda açık olabilir; her birinin opaklığı ve sırası var.

```ts
export const BASEMAP_SOURCE = {
  XYZ: 'xyz',               // {z}/{x}/{y} raster
  WMTS: 'wmts',
  WMS: 'wms',
  TILEJSON: 'tilejson',
  VECTOR_STYLE: 'vector-style', // MapLibre style.json (sokak görünümü vb.)
  IMAGE: 'image',           // kendi yüklediğimiz, 4 köşe ile georeferanslı görüntü
} as const;
export type BasemapSourceType = (typeof BASEMAP_SOURCE)[keyof typeof BASEMAP_SOURCE];

export type BasemapSource =
  | { type: typeof BASEMAP_SOURCE.XYZ; urlTemplate: string; tileSize?: number; minZoom?: number; maxZoom?: number }
  | { type: typeof BASEMAP_SOURCE.WMTS; url: string; layer: string; tileMatrixSet: string; format?: string }
  | { type: typeof BASEMAP_SOURCE.WMS; url: string; layers: string; format?: string; params?: Record<string, string> }
  | { type: typeof BASEMAP_SOURCE.TILEJSON; url: string }
  | { type: typeof BASEMAP_SOURCE.VECTOR_STYLE; styleUrl: string }
  | { type: typeof BASEMAP_SOURCE.IMAGE; url: string; corners: [LngLat, LngLat, LngLat, LngLat] } // TL, TR, BR, BL
  | { type: `custom:${string}`; config: unknown }; // BasemapProviderRegistry ile

export type Basemap = {
  id: string;
  name: string;
  provider?: string;        // 'firma-a', 'firma-b', 'local' … (gruplama/auth için)
  source: BasemapSource;
  visible: boolean;
  opacity: number;
  order: number;            // altlıklar arası sıra (üstteki yüksek)
  exclusiveGroup?: string;  // aynı gruptan yalnız biri açık (radyo davranışı), ops.
  attribution?: string;
  thumbnail?: string;
};

// Firma bazlı auth / URL dönüşümü / özel tipler için genişleme noktası
export interface BasemapProvider {
  id: string;
  transformRequest?(url: string): { url: string; headers?: Record<string, string> };
  resolve?(source: BasemapSource): BasemapSource; // custom:* → standart tipe çevir
}
```

MapLibre eşlemesi: XYZ/WMTS/WMS/TILEJSON → `raster` source + `raster` layer
(`raster-opacity`), IMAGE → `image` source, VECTOR_STYLE → style'ın source/layer'ları
id öneki ile **birleştirilir** (v1.1; birden fazla vektör stilini aynı anda açmak
glyph/sprite çakışması yaratabilir → spike gerektirir). Tüm altlık style layer'ları
`basemap-top` adlı boş bir *anchor* layer'ın altına eklenir; operasyonel katmanlar
her zaman üstte kalır.

### 4.4 Kamera / görünüm

```ts
export type CameraView = {
  center: LngLat;
  zoom?: number;
  bearingDeg?: number;
  pitchDeg?: number;
};
export type Bounds = { min: LngLat; max: LngLat };
```

---

## 5. `MapAdapter` sözleşmesi & olaylar

### 5.1 Adapter arayüzü

İlk plandaki per-feature `createFeature/updateFeature/removeFeature` yerine
**toplu (batch)** uygulama: adapter her karede en fazla bir kez, birleştirilmiş
değişiklik paketi alır.

```ts
export type MapCapabilities = {
  dimension: '2d' | '3d' | 'both';
  terrain: boolean;
  models3d: boolean;
  clustering: boolean;
  draw: boolean;
  featureState: boolean;          // hover/seçim için veriye dokunmadan boyama
  supportedFeatureKinds: string[];
  supportedBasemapSources: BasemapSourceType[];
};

export interface MapAdapter<TEngine = unknown> {
  readonly capabilities: MapCapabilities;

  // Yaşam döngüsü
  mount(container: HTMLElement, opts: MountOptions): Promise<void>;
  unmount(): void;
  resize(): void;
  getEngine(): TEngine;           // kaçış kapağı (escape hatch), tipli

  // Kamera
  setView(view: CameraView, opts?: { animate?: boolean }): void;
  flyTo(view: CameraView, opts?: { durationMs?: number }): Promise<void>;
  fitBounds(bounds: Bounds, opts?: { paddingPx?: number }): void;
  getView(): CameraView;
  getBounds(): Bounds;
  project(c: LngLat): { x: number; y: number } | null;
  unproject(p: { x: number; y: number }): LngLat | null;

  // Tek giriş noktası: MapSync'ten gelen birleştirilmiş paket
  applyBatch(batch: RenderBatch): void;

  // Renderer'lar (kind → motor-özel çizici)
  registerRenderer(kind: string, renderer: AdapterRenderer<TEngine>): void;

  // Çizim (capabilities.draw)
  startDraw(kind: GeometryKind, opts?: DrawOptions): DrawSession;
  editFeature(id: string): EditSession;
}

export type MountOptions = {
  initialView: CameraView;
  events: MapEventSink;           // adapter ham olayları buraya basar (EventRouter)
  kinds: FeatureKindRegistry;
  symbology: SymbologyRegistry;
  basemapProviders: BasemapProviderRegistry;
};

// MapSync'in ürettiği paket — adapter yalnız bunu bilir
export type RenderBatch = {
  basemaps?: Diff<Basemap>;
  groups?: Diff<RenderGroup>;     // §6.3
  features?: {
    upsert: RenderFeature[];      // eklenen veya görsel alanı değişen
    remove: string[];
  };
  state?: FeatureStatePatch[];    // seçim/hover/vurgu/bayatlık — veriye dokunmaz
};

export type Diff<T> = { upsert: T[]; remove: string[] };

// Motora giden "çözülmüş" unsur: efektif değerler hesaplanmış
export type RenderFeature = {
  feature: Feature;               // aynı referans; adapter kopyalamaz
  groupId: string;                // hangi render group / kaynak
  opacity: number;                // efektif (ataların çarpımı)
  zIndex: number;                 // global sıra (katman sırası + feature.z)
  changed: ChangeMask;            // GEOMETRY | STYLE | PROPS | Z | OPACITY bit maskesi
};

export type FeatureStatePatch = { id: string; state: Partial<FeatureVisualState> };
export type FeatureVisualState = { selected: boolean; hovered: boolean; highlighted: boolean; stale: boolean };
```

### 5.2 `RenderContext` (ilk planda eksikti)

Bir renderer'ın bir unsuru çizerken ihtiyaç duyduğu, adapter tarafından sağlanan
bağlam. Motor-özeldir; çekirdek yalnız ortak kısmını tanımlar:

```ts
// @c2/map-core — ortak kısım
export interface RenderContextBase {
  readonly kinds: FeatureKindRegistry;      // kind tanımları (default stil, fallback)
  readonly symbology: SymbologyRegistry;    // sembol üretimi
  readonly images: ImageAtlas;              // ikon/sembol görüntü önbelleği (ref-count + LRU)
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
  readonly sourceId: string;                // bu render group'un GeoJSON kaynağı
  readonly beforeLayerId: string;           // style layer ekleme konumu
}
```

### 5.3 Renderer'lar motora göre farklı şekildedir

- **MapLibre (veri güdümlü):** Unsur başına motor nesnesi **yok**. Her kind iki şey sağlar:
  1. `layers(ctx)` → bu kind için render group başına **bir kez** eklenen style layer'lar
     (paint/layout değerleri `['get', '_x']` ile unsur özelliklerinden okunur).
  2. `encode(rf, ctx)` → `RenderFeature`'ı bir veya daha fazla düz GeoJSON feature'a
     çeviren **saf** fonksiyon.
- **Cesium (imperatif, sonra):** `create/update/remove` ile Billboard/Primitive koleksiyonu.

```ts
// @c2/map-maplibre
export interface MaplibreKindRenderer {
  layers(ctx: MaplibreRenderContext): LayerSpecification[];
  encode(rf: RenderFeature, ctx: MaplibreRenderContext): EncodedFeature[]; // saf, memo'lanabilir
}
export type EncodedFeature = {
  id: string;                               // composite için `${featureId}#${part}`
  geometry: GeoJSON.Geometry;
  properties: Record<string, string | number | boolean>; // yalnız stilin okuduğu düz alanlar
};
```

### 5.4 Olaylar: global + hedefli (id bazlı) abonelik

İhtiyaç: React tarafı 3k unsurun hepsini dinlemeden, yalnız ilgilendiği unsurun
veya katmanın olayına abone olabilmeli. Çözüm: **EventRouter** (`@c2/map-core`).

**Akış**
1. Adapter ham olayı yakalar (MapLibre `click`/`mousemove`/`contextmenu`).
2. Adapter **bir kez** hit-test yapar (`queryRenderedFeatures`, yalnız
   `interactive` katmanların style layer'larında) → en üstteki `featureId`.
3. Adapter normalize olayı `events.emit({ type, featureId?, coord, screen, originalEvent })` ile router'a verir.
4. Router dağıtır — **O(dinleyici sayısı) değil, O(ağaç derinliği)**:

```
feature:<id> dinleyicileri  →  layer:<parent> → layer:<grandparent> … → global map
         (stopPropagation() zinciri keser — DOM bubbling gibi)
```

**Veri yapısı:** `Map<EventType, Map<TargetKey, Set<Listener>>>`.
`TargetKey` = `f:<featureId>` | `l:<layerId>` | `*`. Dispatch'te yalnız ilgili
anahtarlar okunur; 3k unsur kaydı olsa bile tıklama başına birkaç Map lookup.

```ts
export const MAP_EVENT = {
  CLICK: 'click',
  DBLCLICK: 'dblclick',
  CONTEXT_MENU: 'contextmenu',
  POINTER_ENTER: 'pointerenter',   // unsur üzerine gelindi (değişimde 1 kez)
  POINTER_LEAVE: 'pointerleave',
  POINTER_MOVE: 'pointermove',     // yalnız global; unsur bazlı yok (gürültü)
  VIEW_CHANGE: 'viewchange',       // moveend/zoomend, throttle'lı
  DRAW_UPDATE: 'draw:update',
  DRAW_COMPLETE: 'draw:complete',
} as const;

export type MapEventTarget =
  | { featureId: string }
  | { layerId: string }   // alt ağaçtaki tüm unsurların olayları (bubbling)
  | undefined;            // global

events.on(MAP_EVENT.CLICK, cb, { featureId: 'unit-42' });
events.on(MAP_EVENT.CLICK, cb, { layerId: 'dusman' });
events.on(MAP_EVENT.VIEW_CHANGE, cb);
```

- **Hover ucuz:** Adapter son hover id'sini tutar; `pointerenter/leave` yalnız id
  değiştiğinde üretilir. Hover vurgusu `feature-state` ile (veri güncellemesi yok).
- **Olaylar ≠ veri değişiklikleri.** "Unsur 42'nin konumu değişti" bir harita
  olayı değil, **store aboneliğidir** (`store.subscribeFeature(id, cb)` / `useFeature(id)`).

**React hook'ları** (latest-ref deseni: callback değişince yeniden abone olunmaz):

```ts
useMapEvent(MAP_EVENT.VIEW_CHANGE, cb);
useLayerEvent('dusman', MAP_EVENT.CLICK, cb);
useFeatureEvent(unitId, MAP_EVENT.CLICK, cb);
```

---

## 6. Rendering stratejisi (3k canlı unsur)

### 6.1 Hedef bütçeler

| Metrik | Hedef |
|---|---|
| Unsur sayısı | 3.000 (tasarım payı 10.000) |
| Gelen güncelleme | ~3.000 mesaj/sn tepe (3k unsur × 1 Hz) |
| Haritaya uygulama | kare başına ≤ 1 flush, varsayılan en fazla **10 Hz** (ayarlanabilir) |
| Ana thread flush maliyeti | **< 4 ms** (encode + diff + postMessage) |
| Hover / seçim | 0 veri güncellemesi (yalnız feature-state) |
| React rerender | yalnız değişen id'ye abone bileşenler |

### 6.2 Boru hattı (pipeline)

```
1 Ingest   : WS mesajları → normalize → store.applyPatches(batch)       (ops. Worker'da parse)
2 Store    : entity güncelle, değişen alan maskesini dirty set'e yaz, per-id dinleyicileri işaretle
3 Schedule : rAF (veya maxApplyHz) ile tek flush
4 MapSync  : dirty set → efektif görünürlük/opaklık/z → RenderBatch
5 Adapter  : kind.encode (yalnız değişenler) → önceki encode ile diff → source.updateData(diff)
6 GPU      : MapLibre worker yeniden tile'lar, çizer
```

**Coalescing (birleştirme) kuralları** — bir flush içinde aynı id için:

| Önce → Sonra | Sonuç |
|---|---|
| add → update | add (son hali) |
| add → remove | hiçbir şey |
| update → update | update (maskeler OR'lanır) |
| update → remove | remove |
| remove → add | update (aynı id yeniden) |

10 ardışık konum güncellemesi tek `updateData` girdisine iner.

### 6.3 MapLibre'de kaynak/katman düzeni (render group)

Unsur başına motor nesnesi yerine **az sayıda GeoJSON source + data-driven style**:

- **Render group:** `renderGroup: true` olan katman (varsayılan: kökün doğrudan
  çocukları) için **bir GeoJSON source** açılır. Alt katmanlarındaki tüm unsurlar
  bu kaynağa düşer. Böylece kaynak sayısı ~5–20 ile sınırlı kalır.
- Her render group için, içinde **kullanılan** her kind'in `layers()` çıktısı bir kez eklenir
  (ör. `milsym` → 1 symbol layer; `vector` → fill + line + circle).
- Kaynak ayarları: `promoteId: '_id'` (feature-state ve diff için),
  `updateData()` ile diff (tam `setData` yok).
- Sık değişen canlı akış (ör. birlik izleri) ile seyrek değişen kontrol tedbirleri
  **ayrı render group'larda** olmalı: canlı kaynağın yeniden tile'lanması statik
  poligonları etkilemez.

**Görünürlük çekirdekte çözülür, motorda değil:**
- Efektif görünürlük = `!feature.hidden && tüm atalar visible && zoom ∈ [minZoom, maxZoom]`.
- Görünmeyen unsur kaynağa **hiç gönderilmez** (remove). 1.000 unsurluk katmanı kapatmak
  = tek `updateData({ remove: [...1000 id] })`.
- Zoom aralığı: MapSync yalnız `viewchange`'te bir eşik **geçildiğinde** ilgili katmanları
  yeniden değerlendirir.
- Bir render group'un **tamamı** gizlenirse (ör. "İstihbarat" kapalı) → daha ucuz
  yol: style layer'larına `visibility: none` (veri gönderilmez).

**Opaklık & sıra:**
- Efektif opaklık unsur özelliği `_op` olarak kodlanır; paint: `['*', baseOpacity, ['get', '_op']]`.
- Sıra: `_z = katmanSırası * 1e4 + feature.z` → `symbol-sort-key` / `line-sort-key` / `fill-sort-key`.
- Kısıt: Farklı style layer tipleri arasında (fill < line < symbol) sıra karışmaz; kartografik
  olarak kabul edilebilir, dokümante edilir.

### 6.4 Encode & diff (en kritik optimizasyon)

1. `RenderFeature.changed` maskesi yalnız `GEOMETRY|STYLE|PROPS|Z|OPACITY` için set edilir.
   **Yalnız `meta` değiştiyse unsur batch'e hiç girmez.**
2. Adapter her id için **son encode edilmiş özellikleri** saklar (`Map<id, EncodedFeature>`).
3. Yeni encode ile karşılaştırır → `GeoJSONSourceDiff`:
   - geometri değiştiyse `newGeometry`,
   - yalnız değişen özellik anahtarları `addOrUpdateProperties`,
   - kaybolan anahtarlar `removeProperties`.
4. Konum-only güncelleme (en yaygın durum) = yalnız `newGeometry` → worker'a en küçük yük.
5. Kaynağa yalnız stilin okuduğu düz alanlar gider (`_id`, `_fid`, `_icon`, `_rot`, `_op`,
   `_z`, `_label`, renkler). Domain verisi asla.

### 6.5 Hover / seçim / vurgu / bayatlık → `feature-state`

`map.setFeatureState({ source, id }, { selected: true })` veriye dokunmaz, yeniden
tile'lama yapmaz, yalnız yeniden boyar. Paint ifadeleri:
`['case', ['boolean', ['feature-state', 'selected'], false], seçiliRenk, normalRenk]`.

Bayatlık (stale): MapSync her ~1 sn `lastUpdate` eşiğini aşan unsurlar için
`stale: true` state patch'i üretir (veri yok, yalnız state).

### 6.6 İkonlar & askeri semboller (image atlas)

- Sembol görüntüsü **benzersiz anahtar başına bir kez** üretilir:
  `key = ${standard}:${hash(code, modifiers, size)}`. 3k birlik ≈ birkaç yüz benzersiz sembol.
- Unsur yalnız `_icon: key` taşır; `icon-image: ['get', '_icon']`.
- **Lazy üretim:** MapLibre `styleimagemissing` olayı → `symbology.render(key)` →
  `map.addImage(key, imageData)`. Ekranda hiç görünmeyen sembol üretilmez.
- Ref-count + LRU: kullanılmayan görüntüler `removeImage` ile atılır.
- Dönüş: `icon-rotate: ['get', '_rot']`, `icon-rotation-alignment: 'map'`.
- Etiketler: `text-field: ['get', '_label']`, çakışma yönetimi motorda.

### 6.7 Composite

`encode` birden çok `EncodedFeature` döndürür (`${id}#icon`, `${id}#ring`, `${id}#label`),
hepsi `_fid = id` taşır. Hit-test `_fid` üzerinden asıl unsura döner. Seçim state'i tüm
parçalara uygulanır.

### 6.8 Ölçek kaçış kapıları (gerekirse, v1 değil)

- **> ~10k hareketli unsur veya yumuşak interpolasyon (60 fps):** GeoJSON kaynağı
  her karede güncellemek pahalı. Çözüm: MapLibre **custom layer** (deck.gl
  `MapboxOverlay` interleaved) ile GPU attribute güncellemesi. Adapter içinde ikinci
  bir renderer türü olarak eklenebilir; sözleşme değişmez.
- **Clustering:** milsym için özel kümeleme (MapLibre `cluster` yerine supercluster ile
  sembol-farkında). Faz 4+.

### 6.9 Spike'ta doğrulanacaklar

- `GeoJSONSource.updateData` + string `promoteId` davranışı ve 3k nokta × 10 Hz maliyeti
  (kullanılan MapLibre sürümünde).
- 3k milsym symbol layer'ının çakışma (collision) hesap maliyeti; gerekirse
  `icon-allow-overlap` ile kapatma.
- Ölçüm: Chrome Performance + `map.showTileBoundaries`/FPS sayacı; sentetik 3k akış üreteci.

---

## 7. Canlı veri: ingest, store ve senkronizasyon

### 7.1 Ingest API (backend → store)

```ts
store.transaction((tx) => {
  tx.upsertFeatures(snapshot);                     // tam nesne
  tx.patchFeatures([{ id, geometry }]);            // kısmi: yalnız gelen alanlar merge
  tx.removeFeatures(ids);
  tx.upsertLayers(layers);
});
```

- **Kısmi patch (merge) semantiği:** Backend yalnız değişen alanı gönderir
  (`{ id, geometry }` veya `{ id, style: { color } }`). Store alan bazlı birleştirir
  ve **değişen alan maskesini** kaydeder.
- **Sıra dışı mesajlar:** `rev` (veya `ts`) eskiyse patch düşürülür.
- **Snapshot + delta / yeniden bağlanma:** Reconnect'te snapshot gelir;
  `tx.replaceRemote(snapshot)` → snapshot'ta olmayan `origin: remote` unsurlar silinir,
  `declarative`/`drawn` olanlar korunur.
- **Sahiplik (`origin`):** `<MapFeature>` unmount olurken yalnız kendi (`declarative`)
  unsurunu siler; backend unsurlarına dokunmaz.
- **Backpressure:** Ingest kuyruğu flush'a kadar birikir; aynı id'nin ara durumları
  coalesce edilir, bellek O(unsur sayısı) kalır.
- **Worker (v1.1):** WS bağlantısı + JSON parse + normalize + coalesce bir Web Worker'da;
  ana thread'e kare başına tek, birleştirilmiş batch postMessage edilir. Ingest API
  batch-odaklı olduğu için taşımak sözleşmeyi değiştirmez.

### 7.2 Değişiklik yayılımı (kim neyi duyar)

| Değişen | Harita (MapSync) | React per-id aboneleri | LayerTree |
|---|---|---|---|
| `geometry` | ✔ newGeometry | ✔ (`useFeature(id)` seçicisi okuyorsa) | ✘ |
| `style` / `props` | ✔ properties diff | ✔ | ✘ (ikon rengi gösteriliyorsa ✔ satır) |
| `meta` | ✘ | ✔ | ✘ |
| layer `visible`/`opacity` | ✔ (alt ağaç için batch) | ✔ | ✔ yalnız o satır |
| layer ekle/sil/taşı | ✔ | ✔ | ✔ `rebuildTree()` (throttle'lı) |
| selection | ✔ feature-state | ✔ | ✔ seçili satırlar |

---

## 8. Katman modeli & LayerTree entegrasyonu

### 8.1 Ağaç yapısı

```
(kök)
├─ Altlıklar           ← sanal bölüm; Basemap düğümleri (Layer değil)
│   ├─ Firma A Uydu
│   ├─ Firma B Uydu
│   ├─ Sokak
│   └─ Yüklenen ortofoto
└─ Operasyonel katmanlar ← Layer ağacı
    ├─ Harekât (Layer, renderGroup)
    │   ├─ Kontrol Tedbirleri (Layer)
    │   │   ├─ FH Altın (Feature)      ← ops. unsurlar ağaçta
    │   …
    └─ İstihbarat (Layer, renderGroup)
```

Store indeksleri (O(1) erişim):
- `layers: Map<id, Layer>`, `features: Map<id, Feature>`, `basemaps: Map<id, Basemap>`
- `childLayerIds: Map<layerId, string[]>` (sıralı), `featureIdsByLayer: Map<layerId, Set<string>>`
- Türetilmiş, önbellekli: `effectiveVisible(layerId)`, `effectiveOpacity(layerId)`
  (bir katman değişince yalnız alt ağacı geçersiz kılınır).

### 8.2 headless-tree köprüsü (`@c2/map-react/layer-tree`)

headless-tree **pull-based** (dataLoader) çalışır; kendi UI durumunu (expanded,
focused, drag, renaming) tutar. Bölüşüm:

| Durum | Sahibi | Bağlantı |
|---|---|---|
| Ağaç yapısı (çocuklar, ad, renk) | **MapStore** | `dataLoader.getItem/getChildren` store'dan okur |
| Görünürlük | **MapStore** | `LayerTreeItemVisibility` store'a bağlı (aşağıda) |
| Seçim | **MapStore** | headless-tree `state.selectedItems` **controlled** ↔ `store.selection` |
| Expanded / focused / drag / rename | headless-tree | iç durum (ops. persist) |
| Sürükle-bırak sonucu | **MapStore** | `onDrop` → `store.moveLayer(id, parentId, index)` |
| Yeniden adlandırma | **MapStore** | `onRename` → `store.patchLayer(id, { name })` |

- **Görünürlük ve `checkboxesFeature`:** headless-tree'nin checkbox yayılımı "klasör =
  tüm yapraklar işaretli" mantığıyla çalışır; bizim modelimiz "her katmanın kendi
  `visible` bayrağı + efektif görünürlük = atalarla VE". Bunlar uyuşmaz. Bu yüzden
  görünürlük için `checkboxesFeature` **kullanılmaz**; mevcut
  `LayerTreeItemVisibility`'ye controlled `checked`/`onCheckedChange` (ve `mixed`)
  prop'ları eklenir, değer store'dan `useLayerVisibility(id)` ile gelir.
- **Yapısal değişiklikte** (ekle/sil/taşı) `tree.rebuildTree()` — rAF ile throttle'lı.
  Unsur konum/stil güncellemeleri ağacı **yeniden kurmaz**.
- **Satır bazlı abonelik:** Her satır `useLayerNode(id)` ile yalnız kendi ad/renk/
  görünürlük/sayı alanına abone; bir katmanı kapatmak yalnız o satırı ve
  (efektif görünürlüğü değişen) alt satırları yeniden çizer.
- **Unsurları ağaçta göstermek** opsiyonel (`showFeaturesInTree` katman bazlı).
  3k satır olabileceği için ağaç **sanallaştırılır** (headless-tree + `@tanstack/react-virtual`).
  Sayılar (`12 unsur`) store'da türetilmiş sayaç olarak tutulur, ağacı gezmeden.

---

## 9. Store teknolojisi

### 9.1 Gereksinimler

1. Framework-bağımsız (çekirdekte, React'siz).
2. **Per-id abonelik:** 3k unsur güncellenirken yalnız ilgili id'ye bakan dinleyici çalışmalı.
3. **Değişiklik günlüğü:** MapSync "son flush'tan beri ne değişti?"yi O(değişen) sürede bilmeli.
4. Toplu transaction: 1 WS batch'i = 1 bildirim dalgası.
5. Değişen entity'ler için **yeni referans** (React seçicileri `Object.is` ile çalışsın),
   ama koleksiyonun tamamını kopyalamadan.

### 9.2 Seçenekler

| Seçenek | Artı | Eksi |
|---|---|---|
| **zustand (immutable, tek state)** | Bilinen, küçük, devtools, `zustand/vanilla` React'siz çalışır | Her güncellemede `{...features}` kopyası O(n); her `set` tüm dinleyicileri çağırır (200 abone × 10 Hz × seçici); değişiklik günlüğü yok → MapSync her flush'ta 3k'yı diff'lemek zorunda |
| **zustand + `subscribeWithSelector`** | Seçici bazlı abonelik | Seçiciler yine her `set`'te çalışır (O(abone)); diff problemi aynı |
| **Amaca özel `MapStore`** (önerilen) | `Map` yerinde güncellenir, entity'ler yeni referans; per-id listener seti; dirty set yerleşik; O(değişen) | Kendi kodumuz (~300–400 satır + test) |
| headless-tree state merkezli | Ağaç zaten orada | UI-ağaç kütüphanesi; 3k canlı entity ve harita senkronu için tasarlanmamış |

### 9.3 Öneri

- **`MapStore` (`@c2/map-core`)**: entity verisi (layers, basemaps, features),
  seçim, hover, değişiklik günlüğü. API:

```ts
interface MapStore {
  // okuma
  getFeature(id: string): Feature | undefined;
  getLayer(id: string): Layer | undefined;
  getChildIds(parentId: string | null): readonly string[];
  // yazma
  transaction(fn: (tx: MapTx) => void): void;
  // abonelik (hepsi unsubscribe döner)
  subscribeFeature(id: string, cb: () => void): () => void;
  subscribeLayer(id: string, cb: () => void): () => void;
  subscribeStructure(cb: () => void): () => void;  // ağaç şekli değişti
  subscribeSelection(cb: () => void): () => void;
  // MapSync için
  drainChanges(): ChangeSet;                        // dirty set'i al ve sıfırla
}
```

- React binding: `useSyncExternalStore(cb => store.subscribeFeature(id, cb), () => store.getFeature(id))`
  + seçici (`useFeature(id, f => f.meta?.fuel)`) → sadece o değer değişince rerender.
- **zustand**: uygulama/UI durumu için (aktif araç, panel durumu, filtreler, koordinat
  formatı, harita ayarları). Map entity verisi için değil.
- headless-tree yalnız ağaç **UI** durumunu tutar (§8.2).

---

## 10. React public API (`@c2/map-react`)

**Kabuk**
- `<Map adapter initialView store? className onReady>` — container + `adapter.mount`; store
  verilmezse kendi oluşturur. `ref` → imperatif API.
- `useMap()` → `{ flyTo, fitBounds, getView, project, capabilities, store, adapter }`.

**Deklaratif bileşenler** (statik / az sayıda unsur için: kontrol tedbirleri, çizimler)
- `<MapBasemap id name source visible opacity order />`
- `<MapLayer id name visible opacity renderGroup>` — iç içe olabilir (grup = katman).
- `<MapFeature id kind geometry style props />`, kısayollar `<Polygon>`, `<Polyline>`,
  `<Circle>`, `<Marker>`, `<MilSymbol>`, `<CompositeFeature>`.
- `<MapOverlay anchor offset>` — koordinata sabit React DOM; konum `viewchange` + rAF ile.

**Canlı veri** (3k birlik) bileşen olarak **değil**, store üzerinden:
```ts
const store = useMapStore();
useEffect(() => connectUnitStream(socket, store), [socket, store]); // ingest → store.transaction
```

**Hook'lar**
- `useFeature(id, selector?)`, `useLayer(id, selector?)`, `useLayerVisibility(id)`
- `useSelection()` → `{ selected, select, toggle, clear }`
- `useMapEvent / useLayerEvent / useFeatureEvent`
- `useMapDraw()` → `start(kind): Promise<Geometry>`, `cancel()`

```tsx
<Map adapter={adapter} initialView={{ center: [27.1, 38.4], zoom: 10 }} className="h-full">
  <MapBasemap id="uydu-a" name="Firma A Uydu" source={{ type: BASEMAP_SOURCE.XYZ, urlTemplate }} visible opacity={1} order={0} />
  <MapBasemap id="ortofoto" name="Ortofoto" source={{ type: BASEMAP_SOURCE.IMAGE, url, corners }} visible opacity={0.6} order={1} />

  <MapLayer id="harekat" name="Harekât" renderGroup>
    <MapLayer id="kontrol" name="Kontrol Tedbirleri">
      <Polygon id="fh-altin" geometry={geom} style={{ stroke: '#f00', fillOpacity: 0.1 }} />
    </MapLayer>
  </MapLayer>

  {/* Canlı birlikler: içi boş katman; unsurlar backend akışından store'a */}
  <MapLayer id="birlikler" name="Birlikler" renderGroup />

  <MapOverlay anchor={selectedUnitPos}><UnitCard /></MapOverlay>
</Map>
```

---

## 11. Reconciler: v1'de neden yok

### 11.1 Üç yaklaşım

**a) Effect tabanlı (react-leaflet deseni)**
Her bileşen normal bir React bileşenidir, DOM döndürmez; `useLayoutEffect` içinde
imperatif API'yi çağırır (mount → create, prop değişimi → update, unmount → remove).
Maliyet: bileşen başına hook + effect + fiber. Yüzlerce unsur için sorunsuz,
binlerce **canlı** unsur için React her güncellemede o bileşenleri render etmek zorunda.

**b) Custom reconciler (react-three-fiber deseni)**
`react-reconciler` ile react-dom gibi **yeni bir renderer** yazılır; "host" nesneleri DOM
düğümleri yerine motor nesneleridir. `<mesh position={p} />` → reconciler
`createInstance('mesh', props)` → `new THREE.Mesh()`; prop değişince `commitUpdate`
yalnız değişen prop'u uygular; `appendChild` sahne grafiğine ekler. Effect yok, hook
yok; React'in diff'i doğrudan motor mutasyonuna çevrilir.
**Ama r3f'nin asıl performans dersi şudur:** yüksek frekanslı değişiklikler
(animasyon, konum) React'ten **geçirilmez**; `useFrame` içinde `ref.current.position`
doğrudan mutasyona uğratılır. React yapıyı yönetir, sıcak yol React dışındadır.
Maliyetleri: React sürümüne sıkı bağlı (React 19 iç API'leri), bakım yükü, iki renderer
arası context köprüsü (`its-fine`), debug zorluğu.

**c) Store güdümlü senkronizasyon (önerilen)**
React bileşenleri adapter'a değil **store'a** yazar. Adapter, store'un change journal'ına
abone olan `MapSync` tarafından kare başına toplu beslenir. Canlı veri React'e hiç girmez.

### 11.2 Neden (c)

- Bizde "host nesnesi" = store kaydı. Store yazımı zaten ucuz; reconciler'ın bize
  kazandıracağı bir diff işi kalmıyor.
- 3k canlı unsur React'ten geçmediği için reconciler'ın en güçlü olduğu senaryo
  (büyük deklaratif ağacın verimli diff'i) bizim sıcak yolumuz değil.
- Aynı mimari Vue/vanilla binding'lerinde de çalışır (framework-bağımsızlık hedefi).
- Deklaratif bileşenler (`<MapLayer>`, `<Polygon>`) effect ile store'a yazar:
  `useLayoutEffect(() => store.transaction(tx => tx.upsertFeature(...)))` +
  unmount'ta `origin: declarative` kaydı siler. Az sayıda olduğundan maliyet önemsiz.

---

## 12. Genişletilebilirlik (registry'ler)

1. **`FeatureKindRegistry` (çekirdek, motor-bağımsız):**
   `kind → { validate, defaultStyle, defaultProps, bounds(f), fallback(f) }`.
   `fallback`: motor bu kind'i desteklemiyorsa basit bir kind'e çevirir (model3d → marker).
2. **Adapter renderer'ları:** `adapter.registerRenderer(kind, renderer)` (§5.3).
3. **`BasemapProviderRegistry`:** firma-özel auth, URL dönüşümü, `custom:*` kaynak tipleri.
4. **`SymbologyRegistry`** (§13).

---

## 13. Askeri semboloji (genişletilebilir)

```ts
export interface SymbologyProvider<TModifiers = Record<string, unknown>> {
  id: string;                                   // 'app6d', '2525e', 'c2-custom'
  validate(code: string): boolean;
  cacheKey(code: string, mods: TModifiers, sizePx: number): string;
  render(code: string, mods: TModifiers, opts: { sizePx: number; pixelRatio: number }):
    Promise<SymbolImage> | SymbolImage;
}
export type SymbolImage = { image: ImageData | ImageBitmap; width: number; height: number; anchor: [number, number] };
```

- `milsym` kind props: `{ standard: 'app6d', code: '...', modifiers: {...} }`.
- İlk sağlayıcı `@c2/map-symbology-app6` (`milsymbol`, APP-6 D). Kurum içi semboloji =
  aynı arayüzü uygulayan yeni paket (ör. SVG şablon tabanlı).
- Görüntüler image atlas üzerinden lazy üretilir ve önbelleklenir (§6.6).

---

## 14. Koordinat sistemleri

- Kanonik: WGS84 `[lon, lat, alt?]`. Adapter kendi projeksiyonunu yönetir.
- `@c2/map-core` util: MGRS ↔ lon/lat, UTM, DMS/DD format.
- Mesafe/alan: haversine + jeodezik; `Circle.radiusM` metre → MapLibre'de encode sırasında
  poligona çevrilir (zoom'dan bağımsız doğru yarıçap).

---

## 15. Etkileşim & çizim

- **Seçim:** tek/çoklu; `store.selection` ↔ feature-state ↔ LayerTree.
- **Hover/tooltip:** `pointerenter/leave` + `<MapOverlay>`.
- **Context menu:** `contextmenu` → UI `DropdownMenu`.
- **Çizim kütüphanesi (ayrıca konuşulacak).** Aday: **terra-draw** (MIT, motor-bağımsız,
  MapLibre adapter'ı var; nokta/çizgi/poligon/daire/dikdörtgen/serbest + seç/düzenle
  modları) — motor bağımsızlığı hedefimize en uygun olanı. Alternatifler:
  `@mapbox/mapbox-gl-draw` (MapLibre ile çalışır, eskiyor), Geoman MapLibre (free/pro lisans).
  Açık sorular: daire çıktısı merkez+yarıçap olarak alınabiliyor mu, askeri kontrol
  tedbiri (ok, faz hattı) çizimi için özel mod gereksinimi, snapping.

---

## 16. Test & geliştirme

- **`MockAdapter`**: `applyBatch` çağrılarını kaydeder → MapSync/coalescing/görünürlük
  mantığı motorsuz test edilir.
- **`MapStore` birim testleri**: transaction, coalescing tablosu, rev düşürme,
  replaceRemote, per-id abonelik sayısı.
- **Yük üreteci**: sentetik 3k (ve 10k) unsur, 1 Hz konum + rastgele stil değişimi;
  `apps/web` map-demo paneli FPS/flush süresi göstergesiyle.
- Görsel/entegrasyon: Playwright (ops.).

---

## 17. Yol haritası (fazlar)

| Faz | Kapsam | Çıktı |
|---|---|---|
| **0 — Çekirdek** | `@c2/map-core`: tipler, `MapStore`, `MapSync`, `EventRouter`, registry'ler, `MockAdapter`. | Saf TS, testli. |
| **0.5 — Perf spike** | Ham MapLibre ile 3k nokta × 10 Hz `updateData` + feature-state + 300 benzersiz sembol ölçümü. | Bütçelerin doğrulanması (§6.9). |
| **1 — 2D MVP (MapLibre)** | `@c2/map-maplibre` (vector + marker + raster/image basemap); `@c2/map-react`; LayerTree köprüsü; map-demo paneli + yük üreteci. | Canlı akışı çizen, LayerTree ile yönetilen MVP. |
| **2 — Etkileşim** | Seçim, hover, hedefli event'ler, context menu, overlay, MGRS util, çizim (terra-draw). | Operasyonel etkileşim. |
| **3 — Semboloji** | `@c2/map-symbology` + APP-6 sağlayıcı + `milsym` renderer + image atlas; ingest Worker. | APP-6 birlikler, canlı. |
| **4 — Composite & ölçek** | `composite`, vektör stil altlık birleştirme, sembol-farkında kümeleme, gerekirse deck.gl yolu. | Kompozisyon + ölçek. |
| **5 — 3D (Cesium)** | `@c2/map-cesium`, `model3d`, terrain, capability negotiation, 2D↔3D geçiş. | 3D + zarif düşüş. |

---

## 18. Riskler & açık kararlar

| # | Konu | Durum |
|---|---|---|
| 1 | v1 motoru | ✅ MapLibre |
| 2 | Cesium | ✅ Faz 5 (sözleşme oturduktan sonra) |
| 3 | Paketleme | ✅ Ayrı paketler (§3) |
| 4 | Store | ✅ Öneri: özel `MapStore` + zustand yalnız UI durumu (§9) — onay bekliyor |
| 5 | Koordinat | ✅ `[lon, lat, alt?]` |
| 6 | Semboloji | ✅ Registry; APP-6(D) ilk sağlayıcı |
| 7 | Reconciler | ✅ Yok; store güdümlü senkron (§11) |
| 8 | Çizim kütüphanesi | ⏳ Ayrı oturum; aday terra-draw (§15) |
| 9 | Veri ölçeği | ✅ min. 3k canlı → batch pipeline (§6, §7) |
| 10 | Backend mesaj formatı | ⏳ Kısmi patch mı, tam nesne mi; `rev`/`ts` var mı; snapshot endpoint'i? |
| 11 | Güncelleme frekansı | ⏳ Unsur başına beklenen Hz; haritaya uygulama tavanı (varsayılan 10 Hz) yeterli mi? |
| 12 | Konum interpolasyonu | ⏳ 1 Hz zıplama kabul mü, yoksa yumuşak hareket (→ deck.gl yolu) mu? |
| 13 | Vektör stil altlıkları | ⏳ Birden fazla vektör stilini aynı anda açma gereksinimi (glyph/sprite çakışması) |
| 14 | Unsurlar LayerTree'de mi? | ⏳ Hangi katmanlar unsurlarını ağaçta listeler (sanallaştırma şart) |
