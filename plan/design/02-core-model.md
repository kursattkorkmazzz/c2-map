# 02 — Çekirdek modeller

← [Plan ana sayfası](../README.md) · Faz: [0.1](../phases/phase-0-core.md#01-modeller) · Kod: `packages/map-core/src/model/`

## Layer ve Feature ilişkisi

İlk taslakta `Layer.kind: 'group' | 'feature-layer'` vardı ("katman içeren klasör" ile
"unsur içeren katman"ı ayırmak için). Gerek yok:

- **Layer = grup.** İçinde hem alt `Layer` hem `Feature` olabilir.
- **Feature = çizilebilir birim.** Her zaman tam olarak bir `Layer`'a aittir (`layerId`).
- Ağaç düğümü `Layer | Feature`'dır; ayrım düğümün **tipiyle** yapılır, ek bir alanla değil.

Motorun hangi kaynağa çizeceği ayrı bir konudur ([render group](04-sync-and-rendering.md#maplibre-render-group)),
modelde yalnız `renderGroup?: boolean` ipucu olarak durur.

## Tipler

### Geometri ve koordinat

```ts
// Kanonik WGS84, GeoJSON sırası [lon, lat, alt?]
export type LngLat = readonly [number, number] | readonly [number, number, number];

export const GEOMETRY_KIND = {
  POINT: "point",
  LINE: "line",
  POLYGON: "polygon",
  MULTI_POINT: "multi-point",
  MULTI_LINE: "multi-line",
  MULTI_POLYGON: "multi-polygon",
  CIRCLE: "circle",
  RECTANGLE: "rectangle",
} as const;
export type GeometryKind = (typeof GEOMETRY_KIND)[keyof typeof GEOMETRY_KIND];

export type Geometry =
  | { kind: typeof GEOMETRY_KIND.POINT; coord: LngLat }
  | { kind: typeof GEOMETRY_KIND.LINE; coords: readonly LngLat[] }
  | { kind: typeof GEOMETRY_KIND.POLYGON; rings: readonly (readonly LngLat[])[] }
  | { kind: typeof GEOMETRY_KIND.CIRCLE; center: LngLat; radiusM: number }
  | { kind: typeof GEOMETRY_KIND.RECTANGLE; min: LngLat; max: LngLat }
  | { kind: typeof GEOMETRY_KIND.MULTI_POINT; coords: readonly LngLat[] }
  | { kind: typeof GEOMETRY_KIND.MULTI_LINE; lines: readonly (readonly LngLat[])[] }
  | { kind: typeof GEOMETRY_KIND.MULTI_POLYGON; polygons: readonly (readonly (readonly LngLat[])[])[] };
```

> Diziler `readonly` önerilir: store varlıkları değişmez (immutable) kabul eder ve
> değişikliği **referans karşılaştırmasıyla** algılar. Yerinde değiştirilen bir dizi
> değişiklik olarak görülmez ([03](03-store.md#değişmezlik-kuralı)).

### Katman

```ts
export type Layer = {
  id: string;
  name: string;
  parentId: string | null; // null = kök
  visible: boolean;        // kendi bayrağı; efektif görünürlük MapSync'te hesaplanır
  opacity: number;         // 0..1; efektif = atalarla çarpım
  selectable?: boolean;
  interactive?: boolean;   // false → hit-test'e hiç girmez (perf)
  minZoom?: number;
  maxZoom?: number;
  renderGroup?: boolean;   // true → motor bu alt ağaç için ayrı kaynak/katman açar
  meta?: Record<string, unknown>;
};
```

Kardeş katmanların sırası `Layer` içinde **tutulmaz**; store'daki `childLayerIds` sıralı
listesindedir ([03](03-store.md)).

### Unsur

```ts
export type Feature<K extends string = string, S = unknown, P = unknown> = {
  id: string;
  layerId: string;          // ait olduğu katman
  kind: K;                  // 'vector' | 'marker' | 'milsym' | 'model3d' | 'composite' | custom
  geometry: Geometry;
  style?: S;                // kind'e özel görsel stil → motora gider
  props?: P;                // kind'e özel görsel veri (SIDC, model url) → motora gider
  z?: number;               // katman içi sıra
  hidden?: boolean;
  selectable?: boolean;
  meta?: Record<string, unknown>; // domain verisi (yakıt, durum…) → MOTORA GİTMEZ
  rev?: number;             // backend sürümü: sıra dışı mesajı düşürmek + düzenleme çakışması
};
```

> `style` / `props` / `geometry` **görsel** alanlardır: değişince haritaya gider.
> `meta` **görsel olmayan** domain verisidir: değişince yalnız React abonelerine (kart, tablo)
> gider, harita hiç etkilenmez. Bu ayrım performansın temelidir.

### Neden `FeatureOrigin` yok

Önceki revizyonda `origin: 'remote' | 'declarative' | 'drawn'` vardı. Kaldırıldı, çünkü bir
unsurun "kaynağı" ömrü boyunca değişir:

```
kullanıcı çizer → backend'e kaydedilir → refresh'te backend'den gelir
→ kullanıcı günceller → backend'den canlı değişiklik akar → kullanıcı yine günceller
```

`origin`'in çözdüğü iki ihtiyaç başka yoldan karşılanır:

| İhtiyaç | Eski çözüm | Yeni çözüm |
|---|---|---|
| Yeniden bağlanınca snapshot'ta olmayanları silmek, diğerlerine dokunmamak | `origin: remote` olanları sil | **Silme kapsamı katman bazında:** `tx.replaceLayerContents(layerId, features)` — her akış hangi katmanları beslediğini bilir ([03](03-store.md#yeniden-bağlanma-ve-snapshot)) |
| `<MapFeature>` kaldırılınca yalnız kendi unsurunu silmek | `origin: declarative` olanı sil | Bileşen eklediği id'yi bilir ve onu siler. Kural: deklaratif bileşenler ile backend akışı aynı id'yi kullanmaz |

Kullanıcı düzenlerken backend'den güncelleme gelmesi ise ayrı bir eşzamanlılık konusudur;
**taslak (draft)** ile çözülür ([09](09-interaction-and-editing.md#düzenleme-ve-eşzamanlılık)).
Bunun için modelde yalnız `rev` gerekir.

## Altlıklar (basemap)

Altlıklar `Layer` değildir:

- Unsur içermezler; bir **tile/görüntü kaynağıdırlar**.
- Her zaman tüm operasyonel katmanların **altında** çizilirler.
- Sağlayıcıya özel konfigürasyonları vardır (URL şablonu, tileSize, auth header,
  attribution, min/max zoom, WMS parametreleri, görüntü köşe koordinatları).

Ama **aynı store'da** tutulurlar ve LayerTree'de ayrı bir kök bölüm ("Altlıklar") olarak
görünürler. Birden fazlası aynı anda açık olabilir; her birinin opaklığı ve sırası vardır.

```ts
export const BASEMAP_SOURCE = {
  XYZ: "xyz",                   // {z}/{x}/{y} raster
  WMTS: "wmts",
  WMS: "wms",
  TILEJSON: "tilejson",
  VECTOR_STYLE: "vector-style", // MapLibre style.json (sokak görünümü vb.)
  IMAGE: "image",               // 4 köşe ile georeferanslı görüntü
} as const;
export type BasemapSourceType = (typeof BASEMAP_SOURCE)[keyof typeof BASEMAP_SOURCE];

export type BasemapSource =
  | { type: typeof BASEMAP_SOURCE.XYZ; urlTemplate: string; tileSize?: number; minZoom?: number; maxZoom?: number }
  | { type: typeof BASEMAP_SOURCE.WMTS; url: string; layer: string; tileMatrixSet: string; format?: string }
  | { type: typeof BASEMAP_SOURCE.WMS; url: string; layers: string; format?: string; params?: Record<string, string> }
  | { type: typeof BASEMAP_SOURCE.TILEJSON; url: string }
  | { type: typeof BASEMAP_SOURCE.VECTOR_STYLE; styleUrl: string }
  | { type: typeof BASEMAP_SOURCE.IMAGE; url: string; corners: readonly [LngLat, LngLat, LngLat, LngLat] } // TL, TR, BR, BL
  | { type: `custom:${string}`; config: unknown }; // BasemapProviderRegistry ile

export type Basemap = {
  id: string;
  name: string;
  provider?: string;       // 'firma-a', 'firma-b', 'local' … (gruplama/auth için)
  source: BasemapSource;
  visible: boolean;
  opacity: number;
  order: number;           // altlıklar arası sıra (üstteki yüksek)
  exclusiveGroup?: string; // aynı gruptan yalnız biri açık (radyo davranışı)
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

MapLibre eşlemesi: XYZ/WMTS/WMS/TILEJSON → `raster` source + `raster` layer (`raster-opacity`);
IMAGE → `image` source; VECTOR_STYLE → style'ın source/layer'ları id öneki ile **birleştirilir**
(Faz 4; birden fazla vektör stilini aynı anda açmak glyph/sprite çakışması yaratabilir).
Tüm altlık style layer'ları `basemap-top` adlı boş bir _anchor_ layer'ın altına eklenir;
operasyonel katmanlar her zaman üstte kalır.

Uygulama ayrıntıları (kod: `packages/map-maplibre/src/basemaps.ts`):

- Her altlık = `c2-bm-src-<id>` kaynağı + `c2-bm-<id>` raster katmanı; `order`'ı daha büyük ilk altlığın
  altına (yoksa çapanın altına) eklenir.
- Değişiklikler en ucuz yoldan: opaklık → `raster-opacity`, görünürlük → `visibility` (gizli katman tile
  istemez; silinmez, yeniden açmak anında), sıra → `moveLayer`. Kaynak (veya attribution) değişince kaynak +
  katman baştan kurulur — çekirdek içeriği aynı `source`'un referansını koruduğu için bu yalnız gerçek
  değişiklikte olur.
- **WMS:** `VERSION=1.3.0`, `CRS=EPSG:3857`, 256 px karolar, `TRANSPARENT=true`, `BBOX={bbox-epsg-3857}`;
  `params` ek sorgu parametreleri olarak eklenir.
- **WMTS:** URL `{z}` içeriyorsa REST şablonu olarak aynen; yoksa KVP `GetTile` şablonu kurulur ve
  `TILEMATRIX = zoom` varsayılır (GoogleMapsCompatible / WebMercatorQuad). Farklı matris kümeleri için
  sağlayıcı (`custom:*` + `resolve`) ile REST şablonu verilmelidir.
- **Auth / imzalı URL:** MapLibre'nin `transformRequest`'i harita kurulurken bir kez verilir; adapter her
  isteğin URL'sini altlıkların URL önekleriyle eşleyip o altlığın sağlayıcısının `transformRequest`'ine iletir
  (en uzun önek kazanır; sağlayıcısı olmayan altlıkta istek değişmez).

## Kamera

```ts
export type CameraView = {
  center: LngLat;
  zoom?: number;
  bearingDeg?: number;
  pitchDeg?: number;
};
export type Bounds = { min: LngLat; max: LngLat };
```
