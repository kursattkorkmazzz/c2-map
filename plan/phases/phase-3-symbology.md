# Faz 3 — Semboloji, etiket, LOD

← [Plan ana sayfası](../README.md) · Durum: ⬜ · Önkoşul: Faz 1 (Faz 2 ile paralel olabilir)

**Amaç:** APP-6 birlikler canlı ve her zoom'da okunur.

## Açık kararlar (başlamadan)
- [ ] #17 LOD eşikleri — 3.5'teki ölçümle belirlenir (önce ölç, sonra karar ver)
- [ ] #18 Etiketler: hangi zoom, hangi motor

## 3.1 `@c2/map-symbology`
Tasarım: [08](../design/08-extensibility-symbology.md#askeri-semboloji)
- [ ] Sağlayıcılar için ortak önbellek + çapa ortalama + rasterize yardımcıları
  (`SymbologyProvider` arayüzü ve `SymbologyRegistry` çekirdekte hazır — Faz 0.6)

## 3.2 `@c2/map-symbology-app6`
- [ ] `milsymbol` tabanlı APP-6(D) sağlayıcısı
- [ ] `cacheKey`: yalnız paylaşılan değiştiriciler

## 3.3 `milsym` renderer'ları
Tasarım: [04](../design/04-sync-and-rendering.md#askeri-semboller-ve-ikonlar)
- [ ] MapLibre: `setMissingStyleImageResolver` ile lazy üretim
- [ ] deck.gl: otomatik atlas + birlik başına boyut dizisi
- [ ] Image atlas ref-count + LRU

## 3.4 Etiket katmanı
- [ ] Karar #18'e göre (MapLibre symbol / deck.gl `TextLayer`)
- [ ] Zoom eşiği

## 3.5 LOD
Tasarım: [04](../design/04-sync-and-rendering.md#zooma-göre-gösterim-lod)
- [ ] Uzak zoom: nokta (`ScatterplotLayer`), yakın zoom: sembol
- [ ] Eşikler kind/katman bazında; geçişte veri yeniden gönderilmez
- [ ] **Ölçüm** ([Faz 1.5](phase-1.5-perf.md) altyapısıyla): nokta modunda 50k'da çizim/sn, sembol ↔ nokta
      geçiş eşiği adayları; sonuç → karar #17 ve [spike/findings.md](../spike/findings.md)

## 3.6 Ingest Worker
Tasarım: [03](../design/03-store.md#canlı-veri-girişi-ingest)
- [ ] WS + JSON parse + normalize + birleştirme Worker'da
- [ ] Ana thread'e kare başına tek paket
- [ ] Tam nesne akışında (karar #10) son durumu Worker tutar ve ana thread'e yalnız **patch** gönderir
      → içerik karşılaştırması ana thread'den çıkar (ölçüm: tam nesne ≈ 2× kısmi patch, [spike](../spike/findings.md#tam-nesne--kısmi-patch-2026-10-13))
