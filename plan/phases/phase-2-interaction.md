# Faz 2 — Etkileşim, çizim ve düzenleme

← [Plan ana sayfası](../README.md) · Durum: ⬜ · Önkoşul: Faz 1

**Amaç:** Operasyonel etkileşim: seçim, hover, bağlam menüsü, overlay, çizim ve güvenli düzenleme.

## Açık kararlar (başlamadan)
- [ ] #8 Çizim kütüphanesi (aday terra-draw)
- [ ] #20 Taslak (draft) nerede yaşar

## 2.1 Seçim ve hover
Tasarım: [09](../design/09-interaction-and-editing.md#etkileşim)
- [ ] Tek/çoklu seçim (store ↔ feature-state ↔ LayerTree)
- [ ] Hover + tooltip (`<MapOverlay>`)
- [ ] Bağlam menüsü (`contextmenu`)

## 2.2 `<MapOverlay>`
- [ ] Koordinata sabit React DOM; `viewchange` + rAF ile konum

## 2.3 Koordinat yardımcıları
Tasarım: [08](../design/08-extensibility-symbology.md#koordinat-sistemleri)
- [ ] MGRS ↔ lon/lat, UTM, DMS/DD format
- [ ] Mesafe / alan (jeodezik)

## 2.4 Çizim
- [ ] Kütüphane entegrasyonu (adapter `startDraw`, `capabilities.draw`)
- [ ] Nokta / çizgi / poligon / daire (merkez + yarıçap) / dikdörtgen
- [ ] `useMapDraw()`
- [ ] `DRAW_UPDATE` / `DRAW_COMPLETE` olayları

## 2.5 Düzenleme ve eşzamanlılık
Tasarım: [09](../design/09-interaction-and-editing.md#düzenleme-ve-eşzamanlılık)
- [ ] Taslak (draft) mekanizması — asıl kayıt backend'den güncellenirken taslak etkilenmez
- [ ] "Başkası değiştirdi" tespiti (`rev` karşılaştırması)
- [ ] Kaydet: başlangıç `rev`'i ile gönder; onayda taslağı kaldır; iptalde at
- [ ] `editFeature(id)` / `EditSession`
