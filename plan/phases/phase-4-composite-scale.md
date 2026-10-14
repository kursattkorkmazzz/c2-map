# Faz 4 — Composite ve ölçek

← [Plan ana sayfası](../README.md) · Durum: ⬜ · Önkoşul: Faz 3

**Amaç:** Bileşik unsurlar, kümeleme ve büyük ölçekte kalan darboğazlar.

## Açık kararlar (başlamadan)
- [ ] #13 Vektör stil altlıkları

## 4.1 Composite
Tasarım: [04](../design/04-sync-and-rendering.md#composite)
- [x] MapLibre: çok parçalı encode, `_fid` ile hit-test, seçim tüm parçalara (Faz 1.1'de geldi)
- [x] deck.gl katman renderer'ı (`DeckLayersRenderer`) + ilk composite: **İHA** (`kind: 'uav'`: 3B model, sensör konisi, zemin izi, etiket) — öne alındı 2026-10-14, [08](../design/08-extensibility-symbology.md#composite-unsur-iha)
- [ ] Composite parçalarında akıcı hareket (İHA şimdilik 5 Hz mesajla; deck transitions veya ara konum)
- [ ] `<CompositeFeature>` React kısayolu

## 4.2 Kümeleme
Tasarım: [04](../design/04-sync-and-rendering.md#sunum-aşaması-kümeleme-için-genişleme-noktası)
- [ ] `ClusterStage` (sunum aşaması olarak; supercluster)
- [ ] Sentetik `cluster:…` id'leri, `CLUSTER_CLICK` olayı
- [ ] Sembol-farkında kümeleme (`clusterKey(f)`)
- [ ] Seçili unsur içeren kümenin vurgulanması
- [ ] **Ölçüm** ([Faz 1.5](phase-1.5-perf.md) altyapısıyla): 50k'da kümeleme maliyeti (zoom değişiminde ve 1 Hz akışta)

## 4.3 Vektör stil altlıkları
- [ ] Style birleştirme (id öneki), glyph/sprite çakışma çözümü

## 4.4 Ölçek
- [ ] (Gerekirse) akıcı hareketin ara konum hesabını shader'a taşıma
- [ ] Hedef donanımda 50k ölçümü (LOD + kümeleme açıkken; Faz 1.5'teki ölçümün tekrarı)
