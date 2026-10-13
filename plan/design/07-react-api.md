# 07 — React API (`@c2/map-react`)

← [Plan ana sayfası](../README.md) · Faz: [1](../phases/phase-1-2d-mvp.md)

## Kabuk

- `<Map adapter initialView store? className onReady>` — container + `adapter.mount`; store
  verilmezse üstteki `<MapStoreProvider>`'ınkini, o da yoksa kendi oluşturur. `ref` → imperatif API.
- Store mount'u beklemez: çocuklar ilk render'dan itibaren store'a yazar; mount bitince MapSync
  tam senkronla hepsini haritaya taşır.
- `adapter.mount` asenkron: StrictMode'un mount → unmount → mount'unda veya mount sürerken
  kapatılıp açılınca aynı adapter, önceki unmount bitmeden yeniden mount edilmez (adapter başına
  söz zinciri).
- `defaultInteractions` (varsayılan açık): tıklama → `select` / boşa tıklama → `clearSelection`,
  enter/leave → `setHovered`. Global dinleyicidir: unsur veya katman dinleyicisi
  `stopPropagation()` ile engeller.
- `useMap()` → `{ ready, flyTo, setView, fitBounds, getView, getBounds, project, unproject, capabilities, store, adapter }`.
  Mount bitmeden kamera çağrısı açık bir hata verir; `useMapReady()` / `onReady` ile beklenir.
- `<MapStoreProvider store>`: harita dışındaki paneller (yan menü, LayerTree) store hook'larını
  kullanabilsin. Olay hook'ları yalnız `<Map>` içinde (router haritaya aittir).

## Deklaratif bileşenler

Statik / az sayıda unsur için (kontrol tedbirleri, çizimler):

- `<MapBasemap id name source visible opacity order />`
- `<MapLayer id name visible opacity renderGroup>` — iç içe olabilir (grup = katman).
- `<MapFeature id kind geometry style props />`, kısayollar `<Polygon>`, `<Polyline>`,
  `<Circle>`, `<Marker>`, `<MilSymbol>`, `<CompositeFeature>`.
- `<MapOverlay anchor offset>` — koordinata sabit React DOM; konum her karede `adapter.project`
  ile DOM'a doğrudan yazılır (React render'ı yok). `viewchange` yalnız hareket bitince geldiği
  için yetmez.

Bileşen mount'ta kendi id'sini store'a yazar, unmount'ta **yalnız o id'yi** siler (katman: alt
ağacıyla). Kural: deklaratif bileşenler ile backend akışı aynı id'yi kullanmaz ([02](02-core-model.md#neden-featureorigin-yok)).

Yazma kuralları:

- **Tek transaction:** bileşenler store'a doğrudan değil bir yazıcıya yazar; aynı commit'teki
  tüm yazmalar bir mikro görevde tek transaction olur. React çocuk effect'ini ebeveyninkinden
  önce çalıştırır; işlemler geliş sırasıyla tek seferde uygulandığı için sıra sorun olmaz.
- **Yalnız değişen alan:** `<MapLayer>` / `<MapBasemap>` prop'u değişince yalnız değişen alanlar
  `patch` ile yazılır. Kullanıcı katmanı LayerTree'den kapattıysa, başka bir prop (ad) değişti
  diye `visible` prop'u o kararı ezmez. `<MapFeature>` tam upsert yazar; aynı içerik store'da
  ayıklanır (satır içi `geometry={{…}}` haritaya iş göndermez).
- **Kardeş sırası:** yeni katman kardeşlerinin sonuna eklenir; sonradan koşullu render edilen
  katman JSX'teki yerine değil sona girer. Sıralama LayerTree / `tx.moveLayer` işidir ([Faz 1.6](../phases/phase-1.6-layer-tree.md)).
- Kısayollar sabit kind adları kullanır (`BUILTIN_KIND`: `vector`, `marker`, `milsym`); stil
  tipi motora özeldir, React paketi motor bilmez.

## Canlı veri

Canlı birlikler bileşen olarak **değil**, store üzerinden:

```ts
const store = useMapStore();
useEffect(() => connectUnitStream(socket, store, { layerId: "birlikler" }), [socket, store]);
// akış: delta → store.transaction; yeniden bağlanınca → tx.replaceLayerContents("birlikler", snapshot)
```

## Hook'lar

- `useFeature(id, selector?, isEqual?)`, `useLayer(id, selector?, isEqual?)`, `useLayerVisibility(id)`
  — `useSyncExternalStore` + id bazlı abonelik: 50k birlik akarken yalnız izlenen unsur değişince
  render. Seçici sonucu kaynak referansına göre önbelleklenir (satır içi seçici serbest);
  `isEqual` yeni nesne döndüren seçicide gereksiz render'ı keser.
- `useSelection()` → `{ selected, select, toggle, clear }`, `useHovered()`, `useBasemaps()`
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
