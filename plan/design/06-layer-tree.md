# 06 — Katman ağacı (LayerTree)

← [Plan ana sayfası](../README.md) · Faz: [1](../phases/phase-1-2d-mvp.md)

## Ağaç yapısı

```
(kök)
├─ Altlıklar              ← sanal bölüm; Basemap düğümleri (Layer değil)
│   ├─ Firma A Uydu
│   ├─ Firma B Uydu
│   ├─ Sokak
│   └─ Yüklenen ortofoto
└─ Operasyonel katmanlar  ← Layer ağacı
    ├─ Harekât (Layer, renderGroup)
    │   ├─ Kontrol Tedbirleri (Layer)
    │   │   ├─ FH Altın (Feature)   ← isteğe bağlı: unsurlar ağaçta
    │   …
    └─ İstihbarat (Layer, renderGroup)
```

Store indeksleri ve türetilmiş değerler için bkz. [03](03-store.md#iç-veri-yapıları).
Efektif görünürlük/opaklık MapSync'te önbelleklenir; LayerTree de aynı hesaplayıcıyı kullanır.

## headless-tree köprüsü (`@c2/map-react/layer-tree`)

headless-tree **pull-based** (dataLoader) çalışır; kendi UI durumunu (expanded, focused,
drag, renaming) tutar. Bölüşüm:

| Durum | Sahibi | Bağlantı |
|---|---|---|
| Ağaç yapısı (çocuklar, ad, renk) | **MapStore** | `dataLoader.getItem/getChildren` store'dan okur |
| Görünürlük | **MapStore** | `LayerTreeItemVisibility` store'a bağlı (aşağıda) |
| Seçim | **MapStore** | headless-tree `state.selectedItems` **controlled** ↔ `store.selection` |
| Expanded / focused / drag / rename | headless-tree | iç durum (ops. kalıcı) |
| Sürükle-bırak sonucu | **MapStore** | `onDrop` → `tx.moveLayer(id, parentId, index)` |
| Yeniden adlandırma | **MapStore** | `onRename` → `tx.patchLayer(id, { name })` |

- **Görünürlük ve `checkboxesFeature`:** headless-tree'nin checkbox yayılımı "klasör = tüm
  yapraklar işaretli" mantığıyla çalışır; bizim modelimiz "her katmanın kendi `visible`
  bayrağı + efektif görünürlük = atalarla VE". Uyuşmaz. Görünürlük için `checkboxesFeature`
  **kullanılmaz**; `LayerTreeItemVisibility`'ye controlled `checked`/`onCheckedChange`
  (ve `mixed`) prop'ları eklenir, değer `useLayerVisibility(id)` ile gelir.
- **Yapısal değişiklikte** (ekle/sil/taşı) `tree.rebuildTree()` — rAF ile throttle'lı.
  Unsur konum/stil güncellemeleri ağacı **yeniden kurmaz**.
- **Satır bazlı abonelik:** her satır `useLayerNode(id)` ile yalnız kendi ad/renk/görünürlük/
  sayı alanına abone; bir katmanı kapatmak yalnız o satırı ve efektif görünürlüğü değişen
  alt satırları yeniden çizer.
- **Unsurları ağaçta göstermek** isteğe bağlı (`showFeaturesInTree` katman bazlı; [karar #14](../decisions.md)).
  Binlerce satır olabileceği için ağaç **sanallaştırılır** (headless-tree + `@tanstack/react-virtual`).
  Sayılar (`12 unsur`) `featureIdsByLayer` boyutundan gelir, ağacı gezmeden.
