# 01 — Genel bakış

← [Plan ana sayfası](../README.md)

## İlkeler

1. **Motor bağımsızlığı (kesin sınır):** `@c2/map-core` ve `@c2/map-react` hiçbir motoru
   import etmez. MapLibre / deck.gl / Cesium yalnızca adapter paketlerindedir.
2. **Framework bağımsızlığı:** Tüm durum, olay yönlendirme ve senkronizasyon `@c2/map-core`
   içinde (saf TS). React, Vue vb. yalnız ince binding.
3. **Tek doğruluk kaynağı = `MapStore`:** Katmanlar, altlıklar, unsurlar, seçim, hover.
   Harita motoru da LayerTree UI da bu store'un **aboneleridir**.
4. **Sıcak yol React dışında:** Backend → store → (kare başına toplu) adapter.
   React yalnızca ekranda gösterdiği dilime (seçili birim kartı, görünen ağaç satırları)
   id bazlı abone olur.
5. **Genişletilebilirlik (registry):** Yeni unsur türleri (`kind`), altlık sağlayıcıları,
   sembolojiler ve motorlar çekirdeği değiştirmeden eklenir.
6. **Yetenek müzakeresi (capabilities) + zarif düşüş.**
7. **Repo konvansiyonları:** `enum` yok (const nesne + türetilmiş tip), `import type`,
   `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (bkz. `tsconfig.base.json`).

## Temel kararlar

| Konu | Karar | Ayrıntı |
|---|---|---|
| v1 motoru | MapLibre GL JS 6.x | |
| Canlı birlikler | deck.gl (`IconLayer`, MapLibre içine interleaved) — **karma model** | [04](04-sync-and-rendering.md#deckgl-yolu), [spike](../spike/findings.md) |
| Statik / seyrek unsurlar | MapLibre (altlık, kontrol tedbirleri, poligonlar, etiketler) | [04](04-sync-and-rendering.md#maplibre-render-group) |
| Cesium | Model + `MapAdapter` + store oturduktan sonra (Faz 5) | |
| Paketleme | Ayrı paketler | aşağıda |
| Koordinat | WGS84, GeoJSON sırası `[lon, lat, alt?]` | [02](02-core-model.md) |
| Veri ölçeği | min. 3.000, tasarım hedefi **50.000** canlı unsur | [spike](../spike/findings.md) |
| Sıcak yol | React dışında: Store → MapSync → Adapter | [03](03-store.md), [04](04-sync-and-rendering.md) |
| Reconciler | Yok; deklaratif bileşenler store'a yazar | [07](07-react-api.md) |
| Store | Amaca özel `MapStore`; zustand yalnız uygulama UI durumu için | [03](03-store.md) |
| Unsur kaynağı | `Feature.origin` **yok**; silme kapsamı katman/akış bazında | [02](02-core-model.md#neden-featureorigin-yok), [karar kaydı](../decisions.md) |
| Askeri sembol | Genişletilebilir symbology registry; ilk sağlayıcı APP-6(D) | [08](08-extensibility-symbology.md) |
| Sembol önbelleği | Kod başına tek görüntü; birliğe özel metin görüntüye gömülmez | [04](04-sync-and-rendering.md#askeri-semboller-ve-ikonlar) |
| LOD | Zorunlu: uzak zoom'da nokta/küme, yakın zoom'da tam sembol | [04](04-sync-and-rendering.md#zooma-göre-gösterim-lod) |
| Kümeleme | İlk sürümde yok; boş "sunum aşaması" genişleme noktası bugünden konur | [04](04-sync-and-rendering.md#sunum-aşaması-kümeleme-için-genişleme-noktası) |
| Akıcı hareket | `off` / `on` / `auto` (çizim hızına göre, histerezisli) | [04](04-sync-and-rendering.md#akıcı-hareket) |

## Mimari

```
 Backend (WS/SSE)                                  React / UI
      │ delta + snapshot                            │  <Map>, <MapLayer>, <MapFeature>
      ▼                                             │  useFeature(id), useLayer(id) …
┌──────────────┐  batch   ┌───────────────────────────────────────────────┐
│ Ingest       │────────▶ │ MapStore (@c2/map-core)                       │
│ (ops. Worker)│          │  layers · basemaps · features · selection     │
└──────────────┘          │  ├─ id bazlı abonelik (React satırları, kartlar)│
                          │  └─ değişiklik günlüğü (ChangeJournal)        │
                          └───────────────┬───────────────────────────────┘
                                          │ kare başına 1 flush (birleştirilmiş)
                          ┌───────────────▼───────────────────────────────┐
                          │ MapSync (@c2/map-core)                        │
                          │  efektif görünürlük/opaklık/z, RenderBatch    │
                          │  → [sunum aşamaları: varsayılan boş]          │
                          └───────────────┬───────────────────────────────┘
                                          │ adapter.applyBatch(batch)
       ┌──────────────────────────────────▼────────────────────────────────┐
       │ MapAdapter (sözleşme)                                             │
       │  @c2/map-maplibre: statik kind'ler → GeoJSON updateData(diff)     │
       │                    canlı kind'ler → deck.gl IconLayer (typed array)│
       │                    seçim/hover → feature-state / highlight         │
       │  @c2/map-cesium (sonra): Primitive/Billboard koleksiyonları       │
       │  MockAdapter (test)                                               │
       └──────────────────────────────────┬────────────────────────────────┘
                                          │ ham etkileşim (hit-test sonucu)
                          ┌───────────────▼───────────────────────────────┐
                          │ EventRouter (@c2/map-core)                    │
                          │  feature → üst katmanlar → map (kabarma)      │
                          │  hedefli (id bazlı) + global dinleyiciler     │
                          └───────────────────────────────────────────────┘
```

## Paket yapısı

| Paket | İçerik | Bağımlılık |
|---|---|---|
| `@c2/map-core` | Tipler, `MapStore`, `MapSync`, sunum aşaması arayüzü, `EventRouter`, `MapAdapter` sözleşmesi, `FeatureKindRegistry`, `BasemapProviderRegistry`, `SymbologyRegistry` arayüzü, koordinat util, `MockAdapter` | yok (ops. `mgrs`) |
| `@c2/map-react` | `<Map>`, `<MapLayer>`, `<MapFeature>`, `<MapBasemap>`, `<MapOverlay>`, hook'lar. Ayrı entry: `@c2/map-react/layer-tree` | `@c2/map-core`, react (peer) |
| `@c2/map-maplibre` | MapLibre adapter'ı; statik kind encoder'ları; image atlas; canlı kind'ler için deck.gl renderer'ı; çizim entegrasyonu | `maplibre-gl`, `@deck.gl/*`, `@c2/map-core` |
| `@c2/map-symbology` | `SymbologyProvider` arayüzü + ortak önbellek/rasterize yardımcıları | `@c2/map-core` |
| `@c2/map-symbology-app6` | `milsymbol` tabanlı APP-6(D) sağlayıcısı | `milsymbol`, `@c2/map-symbology` |
| `@c2/map-cesium` (sonra) | Cesium adapter'ı | `cesium` |
| `@c2/ui` (asıl monorepo) | Stilli kompozisyonlar: `MapLayerTree`, harita kontrolleri, overlay kartları | `@c2/map-react` |

> `@c2/ui` motor import etmez. Adapter'lar uygulama kökünde lazy import edilir:
> `const { createMaplibreAdapter } = await import('@c2/map-maplibre')`.
>
> Bu repo (`c2-map`) bir deneme alanıdır; paketler olgunlaşınca asıl monorepo'ya taşınır.
