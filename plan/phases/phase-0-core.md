# Faz 0 — Çekirdek (`@c2/map-core`)

← [Plan ana sayfası](../README.md) · Durum: 🔄 Devam ediyor

**Amaç:** Motor- ve framework-bağımsız, saf TypeScript çekirdek: modeller, store, senkronizasyon,
olay yönlendirme ve adapter sözleşmesi. Hiçbir harita motoru import edilmez; testler Node'da koşar.

**Kod:** `packages/map-core/src/` · **Komutlar:** `pnpm test`, `pnpm typecheck`

**Bitti sayılması için:**

- [ ] Tüm alt adımlar tamamlandı
- [ ] `pnpm test` ve `pnpm typecheck` temiz
- [ ] `src/index.ts` genel API'yi dışa aktarıyor; iç yardımcılar dışa açılmıyor
- [ ] `MockAdapter` ile uçtan uca senaryo testi: store'a yaz → flush → adapter doğru batch'i aldı

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

- [ ] `diffFeature(prev, next): number` — alan alan `Object.is`
- [ ] `diffLayer`, `diffBasemap`
- [ ] `mergeFeaturePatch(prev, patch)` — `style` / `props` / `meta` sığ birleştirme, diğerleri doğrudan
- [ ] Test: her alan doğru biti üretiyor; aynı nesne → 0; patch birleştirme

### 0.2.4 Store iskeleti ve okuma — `store/map-store.ts`

- [ ] `createMapStore({ now? })`
- [ ] İç yapılar: `features`, `layers`, `basemaps`, `childLayerIds`, `featureIdsByLayer`, `selection`, `hovered`, `updatedAt`
- [ ] Okuma API'si: `getFeature`, `getLayer`, `getBasemap`, `getChildLayerIds`, `getFeatureIds`, `getBasemaps`, `getSelection`, `getHovered`, `getUpdatedAt`, `stats`

### 0.2.5 Transaction ve unsur işlemleri

- [ ] `transaction(fn)` — iç içe çağrı dıştakine katılır
- [ ] `upsertFeatures` — ADD / UPDATE (değişiklik yoksa hiçbir şey)
- [ ] `patchFeatures` — olmayan id yok sayılır + `stats.ignoredPatches`
- [ ] `removeFeatures` — indeks, seçim ve hover'dan da düşer
- [ ] `layerId` değişimi — iki katmanın indeksi güncellenir, `LAYER` biti
- [ ] Yetim unsur kabul edilir ve indekslenir
- [ ] `rev` kuralı — eski/eşit `rev` düşürülür + `stats.droppedStale`
- [ ] `updatedAt` her yazmada `now()` ile güncellenir
- [ ] Testler: değişmezlik (yeni referans, eski nesne değişmemiş), `rev` senaryoları, patch birleştirme

### 0.2.6 Katman işlemleri

- [ ] `upsertLayers` — yeni katman ebeveynin sonuna; `parentId` değişirse taşınır
- [ ] `patchLayer`
- [ ] `moveLayer(id, parentId, index)` — döngü kontrolü (kendi altına taşınamaz → hata)
- [ ] `removeLayers` — cascade (alt katmanlar + unsurları)
- [ ] `structure` bayrağı ekle/sil/taşı'da set edilir
- [ ] `childLayerIds` dizileri değişince yeni referans
- [ ] Testler: sıra, taşıma, döngü reddi, cascade silme

### 0.2.7 Altlık işlemleri

- [ ] `upsertBasemaps`, `patchBasemap`, `removeBasemaps`
- [ ] `exclusiveGroup`: biri açılınca aynı gruptakiler kapanır
- [ ] `getBasemaps()` `order`'a göre sıralı, değişince yeni referans

### 0.2.8 Snapshot — `replaceLayerContents`

- [ ] Katmanın doğrudan unsurlarını snapshot ile eşitle (olmayan → REMOVE, olan → upsert, `rev` kontrolü yok)
- [ ] Başka katmana ait unsur snapshot'ta → reddet ve raporla
- [ ] Test: diğer katmanlara dokunulmadığını doğrula

### 0.2.9 Seçim ve hover

- [ ] `select(ids, mode)` — `replace` / `add` / `remove` / `toggle`
- [ ] `clearSelection`, `setHovered`
- [ ] `selectable === false` (unsur veya katman) atlanır
- [ ] `selection` her değişimde yeni `Set`
- [ ] Günlükte yalnız seçimi **değişen** id'ler

### 0.2.10 Abonelik

- [ ] `subscribeFeature`, `subscribeLayer`, `subscribeBasemap`, `subscribeLayerContents`
- [ ] `subscribeStructure`, `subscribeSelection`, `subscribeHover`, `subscribeChanges`
- [ ] Bildirimler transaction sonunda; id başına bir kez
- [ ] Dinleyici hatası diğerlerini durdurmaz
- [ ] Dinleyici içinden yeni transaction → ayrı dalga
- [ ] Testler: çağrı sayıları (100 değişiklik → 1 çağrı), abonelikten çıkma, hata izolasyonu

### 0.2.11 `drainChanges`

- [ ] Birden fazla transaction boyunca biriken günlüğü döner ve sıfırlar
- [ ] Test: iki transaction + tek drain → birleşmiş sonuç

## 0.3 MapSync ve sunum aşaması

Tasarım: [design/04-sync-and-rendering.md](../design/04-sync-and-rendering.md#mapsyncin-görevleri) · Klasör: `src/sync/` · Durum: ⬜

> Önkoşul: 0.5'teki `RenderBatch` / `RenderFeature` tipleri (önce tipleri yazın).

- [ ] Zamanlayıcı arayüzü (`schedule(cb)`) — varsayılan rAF + `maxApplyHz`; testte elle tetiklenen
- [ ] `subscribeChanges` → flush planla; flush başına tek `drainChanges`
- [ ] Efektif görünürlük (katman zinciri + `hidden` + zoom aralığı), katman başına önbellek + alt ağaç geçersizleştirme
- [ ] Efektif opaklık (ataların çarpımı)
- [ ] Render group çözümü (en yakın `renderGroup` ata, yoksa kökün çocuğu)
- [ ] zIndex (derinlik-öncelikli katman sırası + `feature.z`)
- [ ] Katman aç/kapa → alt ağaçtaki unsurlar için ADD/REMOVE
- [ ] Yetim unsur görünmez; katmanı gelince görünür olur
- [ ] META-only değişiklik batch'e girmez
- [ ] Seçim/hover → `FeatureStatePatch`
- [ ] Zoom eşiği geçişi (`setView` / `viewchange` girdisi) → ilgili katmanları yeniden değerlendir
- [ ] `PresentationStage` arayüzü + aşama zinciri (varsayılan boş; batch aynen geçer)
- [ ] (Sonra) bayatlık zamanlayıcısı → `stale` yamaları
- [ ] Testler (`MockAdapter` ile): her madde için senaryo

## 0.4 EventRouter

Tasarım: [design/05-adapter-and-events.md](../design/05-adapter-and-events.md#eventrouter-global--hedefli-abonelik) · Klasör: `src/events/` · Durum: ⬜

- [ ] `MAP_EVENT` sabitleri + olay tipleri (`MapEvent`, `MapEventTarget`)
- [ ] `on(type, cb, target?)` → abonelikten çıkma fonksiyonu
- [ ] `emit(event)` — unsur → katman zinciri (store'dan) → global; `stopPropagation`
- [ ] Sentetik id (`cluster:…`) kabarmaz
- [ ] `MapEventSink` arayüzü (adapter'ın gördüğü yüz)
- [ ] Testler: dağıtım sırası, `stopPropagation`, hedefsiz/hedefli, abonelikten çıkma

## 0.5 Adapter sözleşmesi ve MockAdapter

Tasarım: [design/05-adapter-and-events.md](../design/05-adapter-and-events.md) · Klasör: `src/adapter/` · Durum: ⬜

- [ ] `MapCapabilities`, `MapAdapter`, `MountOptions` tipleri
- [ ] `RenderBatch`, `Diff`, `RenderFeature`, `RenderGroup`, `FeatureStatePatch`, `FeatureVisualState`
- [ ] `RenderContextBase`, `ImageAtlas` arayüzleri
- [ ] `DrawSession` / `EditSession` için yer tutucu tipler (Faz 2'de doldurulur)
- [ ] `MockAdapter`: batch'leri kaydeder, kamera durumunu tutar, `emit` ile sahte olay üretir
- [ ] Uçtan uca test: store → MapSync → MockAdapter

## 0.6 Registry'ler

Tasarım: [design/08-extensibility-symbology.md](../design/08-extensibility-symbology.md#registryler) · Klasör: `src/registry/` · Durum: ⬜

- [ ] `FeatureKindRegistry` (`validate`, `defaultStyle`, `defaultProps`, `bounds`, `fallback`)
- [ ] `BasemapProviderRegistry`
- [ ] `SymbologyRegistry` arayüzü + `SymbologyProvider`, `SymbolImage` tipleri
- [ ] Testler: kayıt, çakışan id, fallback zinciri

## 0.7 Paketleme

- [ ] `src/index.ts` genel API listesi gözden geçirildi
- [ ] Paket README'si: kısa kullanım örneği (store + MockAdapter)
