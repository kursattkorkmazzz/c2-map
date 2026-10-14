# Faz 2 — Etkileşim, çizim ve düzenleme

← [Plan ana sayfası](../README.md) · Durum: ⬜ · Önkoşul: Faz 1

**Amaç:** Operasyonel etkileşim: seçim, hover, bağlam menüsü, overlay, çizim ve güvenli düzenleme.

## Açık kararlar (başlamadan)
- [x] #8 Çizim → **B: sözleşme + araçlar çekirdekte, adapter yalnız girdi + kilit** ([09](../design/09-interaction-and-editing.md#çizim-mimarisi-öneri), 2026-10-14). Çizim arayüzü (araç çubuğu vb.) 2.4'e başlarken netleştirilecek
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
Durum: ✅ (kod: `packages/map-core/src/geo/`, 24 test; tarayıcıda `react.html` imleç koordinatı + "koordinata git")
- [x] UTM ↔ lon/lat (Krüger 6. derece; 5000 noktada gidiş-dönüş ≤ 5 nm); Norveç / Svalbard istisnaları; metin bant harfiyle ("36S …")
- [x] MGRS ↔ lon/lat (hassasiyet 0–5, kesme kuralı; okumada karenin merkezi + güneybatı köşesi); 2000 rastgele noktada `mgrs` kütüphanesiyle karşılaştırıldı (yalnız testte)
- [x] DD / DM / DMS biçimleri, İngilizce (N S E W) veya Türkçe (K G D B) yön harfleri
- [x] `parseCoordinate`: serbest metin (MGRS / UTM / DD / DM / DMS, virgüllü ondalık, enlem önce)
- [x] Mesafe / yön / hedef nokta / çizgi uzunluğu / poligon alanı (delikli) / jeodezik daire — `geographiclib-geodesic`
- [ ] (Sonraya) Kutuplar (UPS, |enlem| > 80–84°) kapsam dışı; MapLibre adapter'ın daire poligonu `geodesicCircle`'a geçirilebilir

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
