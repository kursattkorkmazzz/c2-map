# 09 — Etkileşim, çizim ve düzenleme

← [Plan ana sayfası](../README.md) · Faz: [2](../phases/phase-2-interaction.md)

## Etkileşim

- **Seçim:** tek/çoklu; `store.selection` ↔ feature-state ↔ LayerTree.
- **Hover/tooltip:** `pointerenter/leave` + `<MapOverlay>`.
- **Context menu:** `contextmenu` → UI `DropdownMenu`.

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

Modelde bunun için yalnız `Feature.rev` gerekir. Taslak mekanizması Faz 2'de tasarlanır;
store'a mı (ör. `drafts` haritası) yoksa ayrı bir `EditSession`'a mı ait olacağı o zaman kararlaştırılır.
