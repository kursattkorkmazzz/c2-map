# 07 — React API (`@c2/map-react`)

← [Plan ana sayfası](../README.md) · Faz: [1](../phases/phase-1-2d-mvp.md)

## Kabuk

- `<Map adapter initialView store? className onReady>` — container + `adapter.mount`; store
  verilmezse kendi oluşturur. `ref` → imperatif API.
- `useMap()` → `{ flyTo, fitBounds, getView, project, capabilities, store, adapter }`.

## Deklaratif bileşenler

Statik / az sayıda unsur için (kontrol tedbirleri, çizimler):

- `<MapBasemap id name source visible opacity order />`
- `<MapLayer id name visible opacity renderGroup>` — iç içe olabilir (grup = katman).
- `<MapFeature id kind geometry style props />`, kısayollar `<Polygon>`, `<Polyline>`,
  `<Circle>`, `<Marker>`, `<MilSymbol>`, `<CompositeFeature>`.
- `<MapOverlay anchor offset>` — koordinata sabit React DOM; konum `viewchange` + rAF ile.

Bileşen mount'ta kendi id'sini store'a yazar, unmount'ta **yalnız o id'yi** siler.
Kural: deklaratif bileşenler ile backend akışı aynı id'yi kullanmaz ([02](02-core-model.md#neden-featureorigin-yok)).

## Canlı veri

Canlı birlikler bileşen olarak **değil**, store üzerinden:

```ts
const store = useMapStore();
useEffect(() => connectUnitStream(socket, store, { layerId: "birlikler" }), [socket, store]);
// akış: delta → store.transaction; yeniden bağlanınca → tx.replaceLayerContents("birlikler", snapshot)
```

## Hook'lar

- `useFeature(id, selector?)`, `useLayer(id, selector?)`, `useLayerVisibility(id)`
- `useSelection()` → `{ selected, select, toggle, clear }`
- `useMapEvent / useLayerEvent / useFeatureEvent` (latest-ref deseni: callback değişince yeniden abone olunmaz)
- `useMapDraw()` → `start(kind): Promise<Geometry>`, `cancel()`

```tsx
<Map adapter={adapter} initialView={{ center: [27.1, 38.4], zoom: 10 }} className="h-full">
  <MapBasemap id="uydu-a" name="Firma A Uydu" source={{ type: BASEMAP_SOURCE.XYZ, urlTemplate }} visible opacity={1} order={0} />
  <MapBasemap id="ortofoto" name="Ortofoto" source={{ type: BASEMAP_SOURCE.IMAGE, url, corners }} visible opacity={0.6} order={1} />

  <MapLayer id="harekat" name="Harekât" renderGroup>
    <MapLayer id="kontrol" name="Kontrol Tedbirleri">
      <Polygon id="fh-altin" geometry={geom} style={{ stroke: "#f00", fillOpacity: 0.1 }} />
    </MapLayer>
  </MapLayer>

  {/* Canlı birlikler: içi boş katman; unsurlar backend akışından store'a */}
  <MapLayer id="birlikler" name="Birlikler" renderGroup />

  <MapOverlay anchor={selectedUnitPos}><UnitCard /></MapOverlay>
</Map>
```

## Neden reconciler yok

**a) Effect tabanlı (react-leaflet deseni):** Her bileşen `useLayoutEffect` içinde imperatif API'yi
çağırır. Yüzlerce unsur için sorunsuz; binlerce **canlı** unsurda React her güncellemede o
bileşenleri render etmek zorunda.

**b) Custom reconciler (react-three-fiber deseni):** `react-reconciler` ile yeni bir renderer;
"host" nesneleri motor nesneleridir, React'in diff'i doğrudan motor mutasyonuna çevrilir.
Ama r3f'nin asıl performans dersi: yüksek frekanslı değişiklikler React'ten **geçirilmez**
(`useFrame` içinde doğrudan mutasyon). Maliyetleri: React iç API'lerine sıkı bağlılık, bakım
yükü, iki renderer arası context köprüsü, debug zorluğu.

**c) Store güdümlü senkronizasyon (seçilen):** React bileşenleri adapter'a değil **store'a**
yazar. Adapter, store'un günlüğünü okuyan `MapSync` tarafından kare başına toplu beslenir.
Canlı veri React'e hiç girmez.

Neden (c):

- Bizde "host nesnesi" = store kaydı; store yazımı zaten ucuz, reconciler'ın kazandıracağı diff işi kalmıyor.
- Canlı unsurlar React'ten geçmediği için reconciler'ın güçlü olduğu senaryo bizim sıcak yolumuz değil.
- Aynı mimari Vue/vanilla binding'lerinde de çalışır.
- Deklaratif bileşenler effect ile store'a yazar; az sayıda olduklarından maliyet önemsiz.
