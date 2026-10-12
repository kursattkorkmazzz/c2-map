# Faz 0 — Çekirdek (`@c2/map-core`)

← [Plan ana sayfası](../README.md) · Durum: ✅ Tamamlandı (yalnız bayatlık zamanlayıcısı sonraya bırakıldı)

**Amaç:** Motor- ve framework-bağımsız, saf TypeScript çekirdek: modeller, store, senkronizasyon,
olay yönlendirme ve adapter sözleşmesi. Hiçbir harita motoru import edilmez; testler Node'da koşar.

**Kod:** `packages/map-core/src/` · **Komutlar:** `pnpm test`, `pnpm typecheck`

**Bitti sayılması için:**

- [x] Tüm alt adımlar tamamlandı (0.3'teki "sonra" maddesi hariç: bayatlık zamanlayıcısı)
- [x] `pnpm test` ve `pnpm typecheck` temiz (273 test)
- [x] `src/index.ts` genel API'yi dışa aktarıyor; iç yardımcılar dışa açılmıyor (`api.test.ts` korur)
- [x] `MockAdapter` ile uçtan uca senaryo testi: store'a yaz → flush → adapter doğru batch'i aldı (`map-sync.test.ts`, `api.test.ts`)

Uygulama sırası (bağımlılık nedeniyle): 0.1 → 0.2.x → 0.4 → 0.6 → 0.5 → 0.3 → 0.7.

---

## 0.1 Modeller

Tasarım: [design/02-core-model.md](../design/02-core-model.md) · Klasör: `src/model/` · Durum: ✅

- [x] `geometry.ts` — `LngLat`, `GEOMETRY_KIND` + `GeometryKind`, `Geometry` (ayrışık birleşim)
- [x] `layer.ts` — `Layer`
- [x] `feature.ts` — `Feature<K, S, P>` (`origin` yok, `rev` var)
- [x] `basemap.ts` — `BASEMAP_SOURCE`, `BasemapSource`, `Basemap`, `BasemapProvider`
- [x] `camera.ts` — `CameraView`, `Bounds`
- [x] `model/index.ts` — tüm model dosyalarını dışa aktar
- [x] `src/index.ts` — `model`'i dışa aktar
- [x] (Öneri) Geometri dizilerini ve `IMAGE.corners`'ı `readonly` yap ([neden](../design/02-core-model.md#geometri-ve-koordinat))
- [x] (Öneri) Kod içindeki `§6.3` gibi eski plan referanslarını yeni dosya adlarıyla değiştir

## 0.2 MapStore

Tasarım: [design/03-store.md](../design/03-store.md) · Klasör: `src/store/` · Durum: ⬜

Önerilen sıra: önce saf parçalar (maske, günlük), sonra store, en son abonelik.

### 0.2.1 Değişiklik maskeleri ve tipler — `store/change.ts`

- [x] `FEATURE_CHANGE`, `LAYER_CHANGE`, `BASEMAP_CHANGE` bitleri + türetilmiş `*_ALL` ve `FEATURE_CHANGE_VISUAL`
- [x] `CHANGE_OP` (`ADD` / `UPDATE` / `REMOVE`) + `ChangeOp`
- [x] `EntityChange`, `ChangeSet` tipleri
- [x] Test (`change.test.ts`): her değer tek bit, bitler çakışmıyor, `ALL` / `VISUAL` doğru

### 0.2.2 Değişiklik günlüğü — `store/change-journal.ts`

- [x] `record(kind, id, op, mask)` — [birleştirme tablosu](../design/03-store.md#işlemler-ve-birleştirme) (saf `coalesce()` fonksiyonu + `ChangeJournal`)
- [x] `markStructure`, `flipSelection` (net değişiklik), `recordHover` (ilk prev / son next)
- [x] `drain(): ChangeSet` — al ve sıfırla; `isEmpty`
- [x] Test (`change-journal.test.ts`): tablonun her satırı + zincirler, türlerin ayrılığı, seçim/hover, drain

### 0.2.3 Maske hesabı — `store/diff.ts`

- [x] `diffFeature(prev, next): number` — alan alan `Object.is` (`kind` değişirse tüm bitler, `rev` hariç)
- [x] `diffLayer`, `diffBasemap`
- [x] `mergeFeaturePatch(prev, patch)` — `style` / `props` / `meta` sığ birleştirme, diğerleri doğrudan
- [x] `mergeLayerPatch` (`meta` sığ), `mergeBasemapPatch` (`source` değiştirilir), `FeaturePatch` / `LayerPatch` / `BasemapPatch` tipleri
- [x] `shallowMerge`: içerik aynıysa eski referansı korur (gereksiz bit üretmez)
- [x] Test (`diff.test.ts`): her alan doğru biti üretiyor; aynı nesne → 0; patch birleştirme; `undefined` ile temizleme

### 0.2.4 Store iskeleti ve okuma — `store/map-store.ts`

- [x] `createMapStore({ now? })`
- [x] İç yapılar: `features`, `layers`, `basemaps`, `childLayerIds`, `featureIdsByLayer`, `selection`, `hovered`, `updatedAt` (+ `revs`)
- [x] Okuma API'si: `getFeature`, `getLayer`, `getBasemap`, `getChildLayerIds`, `getFeatureIds`, `getBasemaps`, `getSelection`, `getHovered`, `getUpdatedAt`, `stats`
  - `getBasemaps` sıralama + önbellek 0.2.7'de eklendi

### 0.2.5 Transaction ve unsur işlemleri

- [x] `transaction(fn)` — iç içe çağrı dıştakine katılır; `tx` dışarıda kullanılırsa hata; `fn` hata fırlatırsa geri alma yok
- [x] `upsertFeatures` — ADD / UPDATE (değişiklik yoksa hiçbir şey, eski referans kalır)
- [x] `patchFeatures` — olmayan id yok sayılır + `stats.ignoredPatches`
- [x] `removeFeatures` — indeks, seçim ve hover'dan da düşer (seçim/hover testi 0.2.9'da yazıldı)
- [x] `layerId` değişimi — iki katmanın indeksi güncellenir, `LAYER` biti
- [x] Yetim unsur kabul edilir ve indekslenir
- [x] `rev` kuralı — eski/eşit `rev` düşürülür + `stats.droppedStale`; `rev` nesneden ayrı tutulur
- [x] `updatedAt` her yazmada `now()` ile güncellenir (içerik aynı olsa bile; düşürülen yazmada değil)
- [x] Testler (`map-store.test.ts`): değişmezlik, `rev` senaryoları, patch birleştirme, iç içe/hatalı transaction

### 0.2.6 Katman işlemleri

- [x] `upsertLayers` — yeni katman ebeveynin sonuna; `parentId` değişirse taşınır; yetim katman kabul edilir
- [x] `patchLayer` — olmayan id yok sayılır (`stats.ignoredPatches`); `parentId` verilirse taşıma
- [x] `moveLayer(id, parentId, index)` — döngü kontrolü (kendi altına taşınamaz → hata); index sıkıştırılır; aynı yer → no-op
- [x] Döngü kontrolü upsert'te de (yetim zincirle kurulan döngü dahil)
- [x] `removeLayers` — cascade (alt katmanlar + unsurları)
- [x] `structure` bayrağı ekle/sil/taşı'da set edilir
- [x] `childLayerIds` dizileri değişince yeni referans; değişmeyenler aynı kalır
- [x] Testler (`map-store.layers.test.ts`): sıra, taşıma, döngü reddi, cascade silme, referanslar

### 0.2.7 Altlık işlemleri

- [x] `upsertBasemaps`, `patchBasemap` (olmayan id → `stats.ignoredPatches`), `removeBasemaps`
- [x] `exclusiveGroup`: görünür hale gelen (veya görünürken gruba geçen) altlık, gruptaki diğer görünürleri kapatır; aynı pakette sonuncu kazanır
- [x] `getBasemaps()` `order`'a göre sıralı (eşitlikte ekleme sırası), önbellekli; değişince yeni referans
- [x] Testler (`map-store.basemaps.test.ts`): CRUD, sıra, önbellek referansı, grup kuralı senaryoları

### 0.2.8 Snapshot — `replaceLayerContents`

- [x] Katmanın doğrudan unsurlarını snapshot ile eşitle (olmayan → REMOVE, olan → upsert, `rev` kontrolü yok)
- [x] `rev` durumu snapshot'tan yeniden kurulur (rev'siz unsurun eski `rev`'i unutulur)
- [x] Başka katmana ait unsur snapshot'ta → atlanır + `stats.rejectedSnapshotItems`
- [x] Testler (`map-store.snapshot.test.ts`): diğer katmanlar ve alt katman etkilenmez, rev sıfırlama, yanlış kapsam, taşıma, referans korunması

### 0.2.9 Seçim ve hover

- [x] `select(ids, mode)` — `replace` / `add` / `remove` / `toggle` (`SELECT_MODE`)
- [x] `clearSelection`, `setHovered` (store'da olmayan id yok sayılır)
- [x] `selectable === false` (unsur veya katman zincirinden biri) atlanır; çıkarma her zaman serbest
- [x] `selection` her değişimde yeni `Set`; değişiklik yoksa aynı referans
- [x] Günlükte yalnız seçimi **değişen** id'ler
- [x] Testler (`map-store.selection.test.ts`), 0.2.5'ten kalan "silinen unsur seçim/hover'dan düşer" dahil

### 0.2.10 Abonelik

- [x] `subscribeFeature`, `subscribeLayer`, `subscribeBasemap`, `subscribeLayerContents`
- [x] `subscribeStructure`, `subscribeSelection`, `subscribeHover`, `subscribeChanges`
- [x] (Ek) `subscribeBasemaps` — altlık listesi değişti (`getBasemaps()` için)
- [x] Bildirimler transaction sonunda; id başına bir kez
- [x] Dinleyici hatası diğerlerini durdurmaz (`onListenerError` seçeneği; varsayılan asenkron rapor)
- [x] Dinleyici içinden yeni transaction → ayrı dalga
- [x] Testler (`map-store.subscriptions.test.ts`): çağrı sayıları (100 değişiklik → 1 çağrı), abonelikten çıkma, hata izolasyonu, bildirim sırası

### 0.2.11 `drainChanges`

- [x] Birden fazla transaction boyunca biriken günlüğü döner ve sıfırlar (0.2.5 ile birlikte yazıldı)
- [x] Test: iki transaction + tek drain → birleşmiş sonuç

## 0.3 MapSync ve sunum aşaması

Tasarım: [design/04-sync-and-rendering.md](../design/04-sync-and-rendering.md#mapsyncin-görevleri) · Klasör: `src/sync/` · Durum: ✅ (bayatlık sonraya bırakıldı)

> Önkoşul: 0.5'teki `RenderBatch` / `RenderFeature` tipleri (önce tipleri yazın).

- [x] Zamanlayıcı arayüzü (`Scheduler.schedule(task)` → iptal) — `createFrameScheduler` (rAF + `maxApplyHz`, rAF yoksa zamanlayıcı); `createManualScheduler` (test)
- [x] `subscribeChanges` → flush planla (kare başına bir kez); flush başına tek `drainChanges`; `flush()` ile hemen uygulama
- [x] Efektif görünürlük (katman zinciri + `hidden` + zoom aralığı) — `LayerResolver`, katman başına önbellek; katman değişince geçersizleştirme + yalnız değişen alt ağacın unsurları yeniden değerlendirilir
- [x] Efektif opaklık (ataların çarpımı)
- [x] Render group çözümü (en yakın `renderGroup` ata, yoksa kökün çocuğu) + grup diff'i
- [x] zIndex (derinlik-öncelikli katman sırası × `Z_LAYER_STRIDE` + `feature.z`)
- [x] Katman aç/kapa → alt ağaçtaki unsurlar için ADD/REMOVE
- [x] Yetim unsur görünmez; katmanı gelince görünür olur
- [x] META-only değişiklik batch'e girmez; render'ı etkilemeyen katman değişikliği (ad, meta) de girmez
- [x] Seçim/hover → `FeatureStatePatch`; yeniden görünen seçili/hover'daki unsurun durumu tekrar gönderilir
- [x] Zoom eşiği geçişi (`setView`) → yalnız eşik geçilince yeniden değerlendirme (min dahil, max hariç)
- [x] `PresentationStage` arayüzü + aşama zinciri (varsayılan boş; batch aynen geçer); `setStages`, `onViewChange`
- [x] Altlık değişiklikleri batch'e (upsert / remove)
- [ ] (Sonra) bayatlık zamanlayıcısı → `stale` yamaları
- [x] Testler (`map-sync.test.ts` — uçtan uca store → MapSync → MockAdapter; `scheduler.test.ts`)

## 0.4 EventRouter

Tasarım: [design/05-adapter-and-events.md](../design/05-adapter-and-events.md#eventrouter-global--hedefli-abonelik) · Klasör: `src/events/` · Durum: ✅

- [x] `MAP_EVENT` sabitleri + olay tipleri (`MapEventInput`, `MapEvent`, `MapEventTarget`, `MapEventListener`)
- [x] `on(type, cb, target?)` → abonelikten çıkma fonksiyonu
- [x] `emit(event)` — unsur → katman zinciri (store'dan, güncel) → global; `stopPropagation`
- [x] Sentetik id (`cluster:…`, `CLUSTER_ID_PREFIX` / `isSyntheticId`) kabarmaz
- [x] `MapEventSink` arayüzü (adapter'ın gördüğü yüz); `EventHierarchy` (store'un okunan kısmı)
- [x] Dinleyici hatası izole (`onListenerError`)
- [x] Testler (`event-router.test.ts`): dağıtım sırası, `stopPropagation`, hedefsiz/hedefli, yetim/silinmiş unsur, taşınan katman, abonelikten çıkma

## 0.5 Adapter sözleşmesi ve MockAdapter

Tasarım: [design/05-adapter-and-events.md](../design/05-adapter-and-events.md) · Klasör: `src/adapter/` · Durum: ✅

- [x] `MapCapabilities`, `MapAdapter`, `MountOptions` tipleri
- [x] `RenderBatch`, `Diff`, `RenderFeature`, `RenderGroup`, `FeatureStatePatch`, `FeatureVisualState` + `isEmptyBatch`
- [x] `RENDER_CHANGE` (efektif `OPACITY` / `Z_INDEX` / `GROUP` bitleri, 8+) ve `RENDER_CHANGE_ALL`
- [x] `RenderContextBase`, `ImageAtlas` arayüzleri; `AdapterRenderer` (motor paketinde daraltılır)
- [x] `DrawSession` / `EditSession` / `DrawOptions` için yer tutucu tipler (Faz 2'de doldurulur)
- [x] `MockAdapter`: batch'leri kaydeder, "ekranda ne var" durumunu tutar, kamera, `emit` ile sahte olay, `takeBatches`
- [x] Testler (`mock-adapter.test.ts`)
- [x] Uçtan uca test: store → MapSync → MockAdapter (0.3 ile birlikte, `map-sync.test.ts`)

## 0.6 Registry'ler

Tasarım: [design/08-extensibility-symbology.md](../design/08-extensibility-symbology.md#registryler) · Klasör: `src/registry/` · Durum: ✅

- [x] Ortak `Registry<T>` (aynı anahtar → hata, `replace` ile bilinçli değiştirme, geri alma fonksiyonu)
- [x] `FeatureKindRegistry` (`validate`, `defaultStyle`, `defaultProps`, `bounds`, `fallback`) + `withDefaults`, `resolveFor` (döngü korumalı fallback zinciri)
- [x] `geometryBounds` (varsayılan sınır kutusu; daire metreden yaklaşık)
- [x] `BasemapProviderRegistry` (`resolveSource` custom → standart, `transformRequest`)
- [x] `SymbologyRegistry` + `SymbologyProvider`, `SymbolImage`, `SymbolRenderOptions` tipleri
- [x] Testler (`registry.test.ts`): kayıt, çakışan id, fallback zinciri ve döngüsü, sınır kutuları, sağlayıcı önceliği

## 0.7 Paketleme

- [x] `src/index.ts` genel API listesi gözden geçirildi: alt klasör `index.ts`'leri açıkça listeler; günlük, `coalesce`, `diff*`/`merge*`, `Registry` temel sınıfı ve `LayerResolver` iç ayrıntı
- [x] Genel API testi (`api.test.ts`): dışa açılan değerlerin listesi, iç ayrıntıların kapalılığı, yalnız genel API ile uçtan uca kurulum
- [x] Paket README'si: kısa kullanım örneği (store + router + MapSync + MockAdapter)
