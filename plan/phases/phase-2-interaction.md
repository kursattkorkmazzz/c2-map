# Faz 2 — Etkileşim, çizim ve düzenleme

← [Plan ana sayfası](../README.md) · Durum: ⬜ · Önkoşul: Faz 1

**Amaç:** Operasyonel etkileşim: seçim, hover, bağlam menüsü, overlay, çizim ve güvenli düzenleme.

## Açık kararlar (başlamadan)
- [ ] #8 Çizim: kütüphane mi, çekirdekte kendi araçlarımız mı → mimari önerisi [09](../design/09-interaction-and-editing.md#çizim-mimarisi-öneri) (onay bekliyor)
- [x] #20 Taslak (draft) nerede yaşar → **store'da `drafts` haritası** (2026-10-14)

## 2.1 Seçim ve hover
Tasarım: [09](../design/09-interaction-and-editing.md#etkileşim)
Durum: ✅ (çekirdek `PointerModifiers`, adapter sağ tık, React `<MapTooltip>` / `<MapContextMenu>`; gerçek tarayıcıda `react.html`)
- [x] Tek/çoklu seçim: tıkla = tek, Ctrl/⌘ = toggle, Shift = ekle; store ↔ feature-state (MapLibre) / halka (deck.gl). LayerTree tarafı → [Faz 1.6](phase-1.6-layer-tree.md)
- [x] Olaylarda değiştirici tuşlar (`modifiers`), motordan bağımsız
- [x] Hover + tooltip (`<MapTooltip>`: hover edilen unsur, imleci DOM üzerinden takip eder, katman süzgeci)
- [x] Bağlam menüsü (`<MapContextMenu>`, başsız; adapter tarayıcı menüsünü bastırır — `suppressContextMenu`)
- [x] Hata düzeltmesi: `<MapOverlay>` içeriği CSS ile kaydırılınca kutunun eski yeri tıklamaları yutuyordu → hizalama `align` prop'u ile kutunun kendisine
- [ ] (Sonraya) Kutu ile seçim (alan içindeki birlikler) — adapter'a dikdörtgen sorgusu gerekir

## 2.2 `<MapOverlay>`
Durum: ✅ — [Faz 1.4](phase-1-2d-mvp.md#14-c2map-react)'te öne alındı (seçili birlik kartı için)
- [x] Koordinata sabit React DOM; konum her karede `adapter.project` ile DOM'a doğrudan (React render'ı yok). `viewchange` yalnız hareket bitince geldiği için kullanılmadı: kart haritayla birlikte kayar

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
