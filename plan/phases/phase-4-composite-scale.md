# Faz 4 — Composite ve ölçek

← [Plan ana sayfası](../README.md) · Durum: 🔄 · Önkoşul: Faz 3

**Amaç:** Bileşik unsurlar, kümeleme ve büyük ölçekte kalan darboğazlar.

## Açık kararlar (başlamadan)
- [ ] #13 Vektör stil altlıkları

## 4.1 Composite
Tasarım: [04](../design/04-sync-and-rendering.md#composite)
- [x] MapLibre: çok parçalı encode, `_fid` ile hit-test, seçim tüm parçalara (Faz 1.1'de geldi)
- [x] deck.gl katman renderer'ı (`DeckLayersRenderer`) + ilk composite: **İHA** (`kind: 'uav'`: 3B model, sensör konisi, zemin izi, etiket) — öne alındı 2026-10-14, [08](../design/08-extensibility-symbology.md#composite-unsur-iha)
- [x] Composite parçalarında akıcı hareket: renderer'ın `interpolate(from, to, t)` kancası (İHA: konum, irtifa, burun yönü ve pan en kısa açıdan, eğim, FOV); süre = mesajlar arası süre (50 ms – 2 sn); yolun ortasında yeni mesaj ekrandaki hâlden devam eder; `off / on / auto` hareket modu geçerli. Tarayıcı: `off`'ta ardışık karelerin %21'i değişti (5 Hz mesaj), `on`'da %71
- [x] `<CompositeFeature id kind position|geometry props>` React kısayolu; spike'ta JSX'ten sürülen "GÖZCÜ" İHA'sı (kamera pan'ı kaydırıcıdan)

## 4.2 Kümeleme
Tasarım: [04 — Kümeleme](../design/04-sync-and-rendering.md#kümeleme-faz-42) · Ölçüm: [findings](../spike/findings.md#kümeleme-faz-42-2026-10-16)
- [x] `ClusterStage` (sunum aşaması) — **ızgara, artımlı** (supercluster yerine: canlı akışta indeksi her güncellemede baştan kurmamak için, [karar](../decisions.md)); `MapSync.setStages` + aşama sözleşmesine `onRemove`
- [x] Sentetik `cluster:…` id'leri (kind `cluster`, props `{ count, key }`), `CLUSTER_CLICK` olayı (`bindClusterEvents`, veri: üye id'leri + sınır kutusu)
- [x] Sembol-farkında kümeleme (`clusterKey(f)`) + aynı hücredeki anahtarların ekranda kaydırılması (`keyOffsetPx`)
- [x] Seçili unsur içeren kümenin vurgulanması (gizli unsurun durumu saklanır, küme açılınca geri gelir)
- [x] React: `<Map stages>` (yerinde değişir), varsayılan etkileşim: kümeye tıklama → yakınlaş (`zoomToCluster`), seçim değişmez
- [x] Rozet (`clusterBadge`, sınırlı etiket kümesi) + renderer'lar: MapLibre deck ikon yolu (`clusterIconRenderer`), Cesium billboard (`cesiumClusterRenderer`); demo `react.html` / `cesium.html`
- [x] **Ölçüm:** 50k, 1 Hz: aşama ~42 ms/sn, deck.gl işi 3–5 kat az; flush başına adapter işlemi 5000 → 3 (z6); zoom değişimi ~100 ms (Node)
- [ ] Ekran-uzayı kümeleme (Cesium eğik görünümde ufka doğru kümeler sıklaşıyor)
- [ ] Küme üzerine gelince içerik özeti (tooltip) — şimdilik panelde son tıklanan küme

## 4.3 Vektör stil altlıkları
- [ ] Style birleştirme (id öneki), glyph/sprite çakışma çözümü

## 4.4 Ölçek
- [ ] (Gerekirse) akıcı hareketin ara konum hesabını shader'a taşıma
- [ ] Hedef donanımda 50k ölçümü (LOD + kümeleme açıkken; Faz 1.5'teki ölçümün tekrarı)
