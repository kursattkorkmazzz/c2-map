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

## 1.0 Akış girişi: tam nesne (en kötü durum) ve kısmi patch — ✅
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
- [ ] Paket iskeleti; MapLibre 6 worker URL kurulumu ([spike notu](../spike/findings.md#uyumluluk-notları))
- [ ] `mount` / `unmount` / `resize` / kamera metodları
- [ ] `applyBatch`: render group başına GeoJSON source, kind'lerin style layer'ları
- [ ] Encode + önceki encode ile diff → `updateData`
- [ ] Efektif opaklık (`_op`) ve sıra (`_z`)
- [ ] Hover / seçim → `feature-state`
- [ ] Hit-test → `MapEventSink`
- [ ] `vector` ve `marker` kind renderer'ları

## 1.2 Altlıklar
Tasarım: [02](../design/02-core-model.md#altlıklar-basemap)
- [ ] XYZ / WMTS / WMS / TILEJSON → raster source + layer
- [ ] IMAGE (4 köşe) → image source
- [ ] `basemap-top` anchor; sıra ve opaklık
- [ ] `BasemapProvider.transformRequest` (auth header)

## 1.3 deck.gl renderer'ı (canlı birlikler)
Tasarım: [04](../design/04-sync-and-rendering.md#deckgl-yolu)
- [ ] deck.gl dokümanındaki MapLibre 6 entegrasyon yöntemi; spike'taki `map.transform` senaryosunu test et
- [ ] Render group başına `IconLayer`; id → indeks eşlemesi; swap-remove
- [ ] Typed array + sarmalayıcı + `updateTriggers` güncelleme deseni
- [ ] Seçim/hover vurgusu, `pickObject` hit-test
- [ ] Akıcı hareket + `MOTION_MODE` (`off` / `on` / `auto` histerezisli)
- [ ] Kind → renderer seçimi (adapter konfigürasyonu)

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
