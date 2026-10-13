# Faz 1.6 — Katman ağacı (LayerTree)

← [Plan ana sayfası](../README.md) · Durum: ⬜ (detaylandırılacak) · Önkoşul: Faz 1 (`@c2/map-react`)

**Amaç:** Katmanları, altlıkları ve (karar #14'e göre) unsurları yöneten ağaç: görünürlük,
sıra (sürükle-bırak), seçim, yeniden adlandırma — hepsi store üzerinden.

> Bu faz, Faz 1'den ayrıldı (karar: 2026-10-13). Kapsam ve maddeler ayrı bir oturumda
> detaylandırılacak; aşağıdaki maddeler tasarım dokümanından gelen başlangıç listesidir.

Tasarım: [design/06-layer-tree.md](../design/06-layer-tree.md)

## Detaylandırılacak sorular

- [ ] #14 Unsurlar ağaçta listelenecek mi; hangi katmanlarda, kaç satıra kadar? ([decisions](../decisions.md))
- [ ] Ağaç bileşeni: mevcut `layer-tree` (asıl monorepo) + headless-tree mi, başka bir çözüm mü?
- [ ] Altlıklar bölümü: grup (`exclusiveGroup`) radyo davranışı ağaçta nasıl görünür?
- [ ] Hangi işlemler ağaçtan yapılır (aç/kapa, opaklık, sıra, yeniden adlandırma, silme, "haritada göster")?
- [ ] Ağaç durumu (açık/kapalı dallar) kalıcı mı?

## Başlangıç maddeleri (tasarımdan)

- [ ] `@c2/map-react/layer-tree`: dataLoader store'dan okur, controlled seçim, `onDrop` → `moveLayer`, `onRename` → `patchLayer`
- [ ] Görünürlük için controlled checkbox (`checked` / `mixed`); `checkboxesFeature` kullanılmaz
- [ ] Yapısal değişiklikte throttle'lı `rebuildTree`; satır bazlı abonelik (`useLayerNode`)
- [ ] Sayaçlar (`12.430 birlik`) `subscribeLayerContents` ile
- [ ] (Karar #14'e göre) sanallaştırılmış unsur satırları
