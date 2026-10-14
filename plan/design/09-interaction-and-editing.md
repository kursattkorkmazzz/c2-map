# 09 — Etkileşim, çizim ve düzenleme

← [Plan ana sayfası](../README.md) · Faz: [2](../phases/phase-2-interaction.md)

## Etkileşim

- **Seçim:** tek/çoklu; `store.selection` ↔ feature-state ↔ LayerTree. Varsayılan kural
  (`applyClickSelection`): tıkla = yalnız bu, Ctrl/⌘ = toggle, Shift = ekle, boşa tıkla = temizle
  (değiştiriciyle boşa tıklama seçimi korur). Değiştirici tuşlar olayda motordan bağımsız
  `modifiers` alanıyla gelir; adapter orijinal olaydan doldurur.
- **Hover/tooltip:** `<MapTooltip>{id => …}</MapTooltip>` — store'daki hover'a bakar; React yalnız
  hover edilen unsur değişince render olur, imleç takibi `POINTER_MOVE` ile DOM'a doğrudan.
- **Context menu:** `<MapContextMenu>{menu => …}</MapContextMenu>` — başsız (görünüm uygulamanın
  `DropdownMenu`'sü); `{ featureId?, coord, screen, close }`. Kapanma: Esc, dışarı basma, harita
  tıklaması, harita hareketi. Adapter tarayıcının kendi menüsünü bastırır (`suppressContextMenu`).
- **Overlay hizalaması:** `<MapOverlay align>` — kaydırma kutunun kendisine uygulanır. İçerik CSS
  `transform` ile kaydırılırsa kutunun eski yeri haritanın üstünde görünmez engel olur ve
  tıklamaları yutar (tarayıcı testinde bulundu).

## Çizim mimarisi (öneri)

> Karar #8 — onay bekliyor (2026-10-14).

Sözleşme çekirdekte, uygulama adapter'da: `MapAdapter.startDraw(kind) → DrawSession`,
`editFeature(id)`, `capabilities.draw`. Asıl soru, işin ne kadarının çekirdekte olacağı:

- **A) Kalın adapter:** çekirdek yalnız sözleşme + ortak geometri hesapları + taslak; çizimi
  adapter yapar (içeride terra-draw veya kendi kodu). Cesium'da yeniden yazılır.
- **B) İnce adapter (önerilen):** çizim araçları (nokta / çizgi / poligon / daire / dikdörtgen,
  askeri tedbirler) çekirdekte TS durum makineleri. Çizilen şekil store'da taslak unsur olarak
  durur, mevcut renderer'larla çizilir. Adapter'dan yalnız işaretçi olayları (koordinatlı; sürükleme
  eklenecek) ve "çizerken haritayı kaydırma" kilidi istenir. Her motor çizimi bedavaya alır.
  Bedeli: tutamaç / snapping bizim; çizim önizlemesi MapSync'in 10 Hz sınırına takılmamalı
  (taslağa öncelik).
- B'de de bir motor kütüphanesi (ör. terra-draw) aynı `DrawSession` sözleşmesini uygulayan
  alternatif olarak adapter içine takılabilir.

## Çizim kütüphanesi

Aday: **terra-draw** (MIT, motor-bağımsız, MapLibre adapter'ı var; nokta/çizgi/poligon/daire/
dikdörtgen/serbest + seç/düzenle modları). Alternatifler: `@mapbox/mapbox-gl-draw` (MapLibre
ile çalışır, eskiyor), Geoman MapLibre (free/pro lisans).

Açık sorular ([karar #8](../decisions.md)): daire çıktısı merkez+yarıçap olarak alınabiliyor mu;
askeri kontrol tedbiri (ok, faz hattı) için özel mod; snapping.

## Düzenleme ve eşzamanlılık

Sorun: kullanıcı bir poligonu düzenlerken backend aynı poligon için güncelleme yollayabilir.
Unsurun "kaynağı" sabit değildir (kullanıcı çizer → backend'e kaydedilir → backend'den geri
gelir → kullanıcı yine düzenler), bu yüzden çözüm unsura etiket koymak değil, **düzenleme
oturumu**dur.

**Taslak (draft) yaklaşımı:**

1. Düzenleme başlayınca unsurun bir **taslak kopyası** oluşur; kullanıcı taslağı görür ve değiştirir.
   Taslak, asıl kaydın üstünde ayrı bir sunum katmanıdır (store'daki asıl kayıt değişmez).
2. Bu sırada backend'den gelen güncellemeler **asıl kaydı** günceller; taslak etkilenmez,
   kullanıcının elinin altından kaymaz. UI isterse "bu unsur başkası tarafından değiştirildi"
   uyarısı gösterebilir (asıl kaydın `rev`'i taslağın başlangıç `rev`'inden büyükse).
3. Kullanıcı kaydedince taslak, **düzenlemeye başladığı andaki `rev`** ile backend'e gider.
   Backend aradaki değişikliği reddedebilir veya birleştirebilir (backend'in kararı).
4. Onay gelince taslak kalkar; asıl kayıt backend'den gelen yeni `rev` ile güncellenir.
   İptalde taslak atılır.

Modelde bunun için yalnız `Feature.rev` gerekir. **Karar #20 (2026-10-14): taslak store'da
`drafts` haritasında yaşar** — motor bağımsız; MapSync taslağı olan unsur için taslağı çizer;
React hook'ları taslağı okuyabilir; "başkası değiştirdi" uyarısı `rev` karşılaştırmasıyla.
