# Faz 4 — Composite ve ölçek

← [Plan ana sayfası](../README.md) · Durum: ⬜ · Önkoşul: Faz 3

**Amaç:** Bileşik unsurlar, kümeleme ve büyük ölçekte kalan darboğazlar.

## Açık kararlar (başlamadan)
- [ ] #13 Vektör stil altlıkları

## 4.1 Composite
Tasarım: [04](../design/04-sync-and-rendering.md#composite)
- [ ] `composite` kind: çok parçalı encode, `_fid` ile hit-test, seçim tüm parçalara

## 4.2 Kümeleme
Tasarım: [04](../design/04-sync-and-rendering.md#sunum-aşaması-kümeleme-için-genişleme-noktası)
- [ ] `ClusterStage` (sunum aşaması olarak; supercluster)
- [ ] Sentetik `cluster:…` id'leri, `CLUSTER_CLICK` olayı
- [ ] Sembol-farkında kümeleme (`clusterKey(f)`)
- [ ] Seçili unsur içeren kümenin vurgulanması

## 4.3 Vektör stil altlıkları
- [ ] Style birleştirme (id öneki), glyph/sprite çakışma çözümü

## 4.4 Ölçek
- [ ] (Gerekirse) akıcı hareketin ara konum hesabını shader'a taşıma
- [ ] Hedef donanımda 50k ölçümü
