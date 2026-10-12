# Faz 1 — 2D MVP

← [Plan ana sayfası](../README.md) · Durum: ⬜ · Önkoşul: Faz 0

**Amaç:** Canlı akışı çizen, LayerTree ile yönetilen ilk çalışan sürüm.

**Bitti sayılması için:** demo uygulamasında 10k canlı birlik + kontrol tedbirleri + altlıklar;
LayerTree'den katman aç/kapa; [bütçeler](../design/04-sync-and-rendering.md#hedef-bütçeler) tutuyor.

## Açık kararlar (başlamadan)
- [ ] #10 Backend mesaj formatı ([decisions](../decisions.md))
- [ ] #11 Güncelleme frekansı
- [ ] #14 Unsurlar LayerTree'de mi?

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

## 1.5 LayerTree köprüsü
Tasarım: [06](../design/06-layer-tree.md)
- [ ] `@c2/map-react/layer-tree`: dataLoader, controlled seçim, `onDrop` / `onRename`
- [ ] Görünürlük için controlled checkbox (`checked` / `mixed`)
- [ ] Throttle'lı `rebuildTree`; satır bazlı abonelik
- [ ] (Karar #14'e göre) sanallaştırılmış unsur satırları

## 1.6 Demo ve ölçüm
Tasarım: [10](../design/10-testing.md)
- [ ] Demo uygulaması (spike'tan yük üreteci + ölçüm paneli)
- [ ] Akış bağlantısı örneği: delta → transaction, reconnect → `replaceLayerContents`
- [ ] Gerçek GPU ile otomatik perf testi (Playwright)
