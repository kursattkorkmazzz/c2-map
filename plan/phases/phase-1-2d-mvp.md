# Faz 1 — 2D MVP

← [Plan ana sayfası](../README.md) · Durum: ⬜ · Önkoşul: Faz 0

**Amaç:** Canlı akışı çizen ilk çalışan sürüm (gerçek paketler: `@c2/map-maplibre`, `@c2/map-react`).

**Bitti sayılması için:** demo uygulamasında 10k canlı birlik + kontrol tedbirleri + altlıklar;
hem kısmi patch hem tam nesne akışı çalışıyor; yük üreteci ve ölçüm paneli çalışıyor. Bütçelerin
ölçümle doğrulanması [Faz 1.5](phase-1.5-perf.md)'te. Katman ağacı ayrı fazda: [Faz 1.6](phase-1.6-layer-tree.md).

## Kararlar
- [x] #10 Backend mesaj formatı → **ikisi de desteklenir; en kötü durum (her mesajda tam nesne) esas alınır**, değişikliği çekirdek bulur ([decisions](../decisions.md))
- [x] #11 Güncelleme frekansı → birlik başına ≤ 1 Hz, haritaya uygulama tavanı 10 Hz
- [x] #14 Unsurlar LayerTree'de mi? → LayerTree ayrı faz ([1.6](phase-1.6-layer-tree.md)), karar orada

## 1.0 Akış girişi: tam nesne (en kötü durum) ve kısmi patch

Durum: ✅
Tasarım: [03](../design/03-store.md#en-kötü-durum-her-mesajda-tam-nesne)
- [x] ~~**Ölç:** tam nesne akışının düzeltme öncesi maliyeti~~ — atlandı (karar: doğrudan düzeltmeye geçildi)
- [x] **Değer karşılaştırması** (`store/stabilize.ts`): referans farklı ama içerik aynıysa eski referans korunur (geometri, `style` / `props` / `meta`; katmanda `meta`, altlıkta `source`) → maskede gereksiz bit yok, adapter ikon/stil ve tile kaynağını yeniden hesaplamaz. Tam nesne, kısmi patch ve snapshot aynı yoldan. Testler: `stabilize.test.ts`, `map-store.full-object.test.ts` (uçtan uca MapSync dahil)
- [x] **Akış yardımcısı** (`createLayerStream`, `src/ingest/`): katman başına akış; format akış bazında **açıkça** (`full` varsayılan / `patch`, çağrı bazında da değiştirilebilir — mesajdan tahmin edilmez); `normalize` ile backend biçimi → model (null = atla, `{ id, removed: true }` = sil); bir paket = tek transaction, sıra korunur; `snapshot()` → `replaceLayerContents`; sayaçlar (`received` / `skipped` / `wrongLayer`). Testler: `layer-stream.test.ts`
- [x] **Yeniden ölç:** Node bench'e tam nesne senaryoları + `core.html`'e `?format=full|patch` (akış yardımcısı üzerinden).
      Sonuç: tam nesne ≈ 2× kısmi patch (store), tarayıcıda +%33; harita tarafı aynı (yalnız `GEOMETRY` biti gidiyor).
      Ölçüm sırasında içerik karşılaştırması optimize edildi (geometriye özel karşılaştırma, anahtar dizisi üretmeden sayım):
      kısmi patch'e eklenen bedel sıfırlandı. Ayrıntı: [spike/findings.md](../spike/findings.md#tam-nesne--kısmi-patch-2026-10-13)

## 1.1 `@c2/map-maplibre` — temel adapter
Tasarım: [05](../design/05-adapter-and-events.md), [04](../design/04-sync-and-rendering.md#maplibre-render-group)
Durum: ✅ (kod: `packages/map-maplibre/`, 35 test; gerçek tarayıcıda `core.html?engine=maplibre`)
- [x] Paket iskeleti; worker URL **seçenek** olarak (`workerUrl`) — kütüphane Vite'a özel `?url` importu yapamaz ([spike notu](../spike/findings.md#uyumluluk-notları))
- [x] `mount` / `unmount` / `resize` / kamera metodları; `maplibre-gl` yalnız `mount`'ta dinamik import (Node testleri WebGL yüklemez)
- [x] `MapLike` arayüzü + test için `FakeMap` (kaynak içeriği, katman sırası, feature-state, olaylar)
- [x] `applyBatch`: render group başına GeoJSON source (`promoteId: '_id'`), kind ilk görününce katmanları; gruplar arası sıra (ekleme konumu + `restack`)
- [x] Encode + önceki encode ile diff → kaynak başına **tek** `updateData` (konum-only = yalnız `newGeometry`)
- [x] Standart alanlar: `_id`, `_fid`, `_op` (efektif opaklık), `_z` (sıra), `_kind` (çizen renderer)
- [x] Hover / seçim → `feature-state` (unsurun tüm parçalarına)
- [x] Hit-test → `MapEventSink` (etkileşimsiz katmanlar `metadata: NON_INTERACTIVE` ile hariç); click / dblclick / contextmenu / hover enter-leave / pointermove / viewchange
- [x] `vector` (dolgu + çerçeve + nokta; daire jeodezik poligon) ve `marker` (ikon veya daire + seçim halkası) renderer'ları
- [x] Desteklenmeyen kind → çekirdeğin fallback zinciri (`FeatureKindRegistry.resolveFor`), yoksa çizilmez + sayaç
- [x] İkon çözümleyici seçeneği (`resolveImage`): senkron sonuç senkron eklenir
- [x] **Performans kuralı:** marker'da `icon-size` veri güdümlü değil (katman sabiti) — 10k'da FPS'i 1–2'ye düşürüyordu ([findings](../spike/findings.md#gerçek-maplibre-adapterı-faz-11-2026-10-13))
- [ ] (Sonraya) `ImageAtlas` ref-count + LRU (Faz 3 sembolojiyle); katmanın `interactive: false` bilgisinin adapter'a taşınması

## 1.2 Altlıklar
Tasarım: [02](../design/02-core-model.md#altlıklar-basemap)
Durum: ✅ (kod: `packages/map-maplibre/src/basemaps.ts`, 16 test; gerçek servislerle `core.html?engine=maplibre`)
- [x] XYZ / WMTS / WMS / TILEJSON → raster source + layer (WMS: EPSG:3857 `{bbox-epsg-3857}`; WMTS: KVP veya REST şablonu)
- [x] IMAGE (4 köşe) → image source
- [x] `basemap-top` anchor altında, `order`'a göre; opaklık / görünürlük yerinde (`setPaintProperty` / `setLayoutProperty`), sıra `moveLayer`, kaynak değişince baştan
- [x] `BasemapProvider.transformRequest` (auth header): istek URL'si önek eşlemesiyle altlığa → sağlayıcısına
- [x] `custom:*` kaynaklar `BasemapProviderRegistry.resolveSource` ile; çözülemeyen / desteklenmeyen → çizilmez + `stats.skippedBasemaps`
- [ ] VECTOR_STYLE (vektör stil altlığı) → Faz 4.3 (stil birleştirme)
- Tarayıcı doğrulaması: OSM, OpenTopoMap, Esri World Imagery (XYZ), terrestris (WMS) ve üretilmiş görüntü (IMAGE); tüm tile istekleri 200, `exclusiveGroup` radyo davranışı ve opaklık panelden store üzerinden

## 1.3 deck.gl renderer'ı (canlı birlikler)
Tasarım: [04](../design/04-sync-and-rendering.md#deckgl-yolu)
Durum: ✅ (kod: `packages/map-maplibre/src/deck/`, 36 test; gerçek tarayıcıda `core.html?engine=deck`)
- [x] deck.gl dokümanındaki MapLibre 6 entegrasyon yöntemi: `@deck.gl/maplibre` `MapLibreOverlay` (interleaved). `map.transform` hatası **yok**, yama gerekmedi (hata `@deck.gl/mapbox`'a özgüydü)
- [x] Render group başına `IconLayer`; id → indeks eşlemesi; swap-remove (`DeckGroupData`)
- [x] Typed array + sarmalayıcı + `updateTriggers` güncelleme deseni; uzunluk değişmezse aynı `data` nesnesi (ikonlar yeniden hesaplanmaz)
- [x] Seçim/hover vurgusu (ayrı `ScatterplotLayer` halkası), `pickObject` hit-test (önce deck, sonra MapLibre)
- [x] Akıcı hareket + `MOTION_MODE` (`off` / `on` / `auto` histerezisli, her geçişte bekleme ×2); `setMotionMode` ile canlı değişir
- [x] Kind → renderer seçimi (adapter konfigürasyonu): tek adapter, `deckRenderers` → deck.gl, `renderers` → MapLibre; fallback zinciri ikisini de görür
- [x] Gruplar arası sıra korunur: deck katmanı `beforeId` ile grubun MapLibre katmanlarının üstüne, üst grubunkilerin altına
- [ ] (Sonraya) LOD: uzak zoom'da `ScatterplotLayer` noktası → [Faz 3.5](phase-3-symbology.md)

## 1.4 `@c2/map-react`
Tasarım: [07](../design/07-react-api.md)
- [ ] `<Map>`, `useMap`, `useMapStore`
- [ ] `<MapLayer>`, `<MapFeature>` + kısayollar, `<MapBasemap>`
- [ ] `useFeature`, `useLayer`, `useLayerVisibility`, `useSelection`
- [ ] `useMapEvent`, `useLayerEvent`, `useFeatureEvent` (latest-ref)

## 1.5 LayerTree → [Faz 1.6](phase-1.6-layer-tree.md)'ya taşındı

## 1.6 Demo
Tasarım: [10](../design/10-testing.md)
- [ ] Demo uygulaması (spike'tan uyarlanan yük üreteci + ölçüm paneli, gerçek paketlerle)
- [ ] Akış bağlantısı örneği: delta (kısmi patch veya tam nesne) → transaction, reconnect → `replaceLayerContents`
- [ ] String `promoteId` ile `updateData` (statik yol) — davranış [Faz 1.5](phase-1.5-perf.md)'te ölçülür

Ölçümler ve otomatik perf testi: [Faz 1.5](phase-1.5-perf.md).
