# Map Component — Plan (rev. 4)

**Framework- ve motor-bağımsız, genişletilebilir harita kütüphanesi.**
`@c2/map-core` + `@c2/map-react` + motor adapter paketleri (`@c2/map-maplibre`, sonra `@c2/map-cesium`).

> Amaç: Uygulama, arkada hangi harita motorunun (MapLibre, Cesium, …) çalıştığını
> **bilmeden** katmanları, altlıkları ve canlı güncellenen binlerce unsuru
> (vektör, ikon, askeri sembol, 3D model, composite) yönetir ve çizer.
> Motor, dışarıdan verilen bir **adapter** üzerinden değiştirilebilir.
> React yalnızca bir binding'dir; çekirdek saf TypeScript'tir.

## Nasıl okunur

- **İş takibi için:** [`phases/`](phases/) altındaki faz dosyaları. Her görev bir onay kutusu (`- [ ]`);
  bitince `- [x]` yapılır. Aşağıdaki durum tablosu da elle güncellenir.
- **"Neden böyle?" için:** [`design/`](design/) altındaki tasarım dokümanları. Faz dosyaları
  ilgili tasarım bölümüne link verir.
- **Kararlar ve açık sorular:** [`decisions.md`](decisions.md) (karar kaydı + açık kararlar).
- **Yapı ve akış diyagramları (Mermaid):** [`diagram/`](diagram/README.md) — core, MapLibre ve React yapısı,
  core'un nerede kullanıldığı, canlı veri / etkileşim / çizim akışları.
- **Ölçümler:** [`spike/findings.md`](spike/findings.md) — `apps/map-spike` **prototipinin** sonuçları
  (referans değerler). Gerçek paketlerle doğrulama Faz 1.5'te.

## Faz durumu

| Faz | Dosya | Kapsam | Durum |
|---|---|---|---|
| 0 | [phase-0-core.md](phases/phase-0-core.md) | `@c2/map-core`: modeller, MapStore, MapSync, EventRouter, adapter sözleşmesi, MockAdapter | ✅ (bayatlık zamanlayıcısı sonraya) |
| 1 | [phase-1-2d-mvp.md](phases/phase-1-2d-mvp.md) | Akış girişi (tam nesne / patch), MapLibre + deck.gl adapter, React binding, demo | ⬜ |
| 1.5 | [phase-1.5-perf.md](phases/phase-1.5-perf.md) | Performans doğrulaması (gerçek paketlerle; spike sayıları referans) | 🔄 (çekirdek ön ölçümleri yapıldı) |
| 1.6 | [phase-1.6-layer-tree.md](phases/phase-1.6-layer-tree.md) | Katman ağacı (LayerTree) | ⬜ (detaylandırılacak) |
| 2 | [phase-2-interaction.md](phases/phase-2-interaction.md) | Seçim, hover, olaylar, overlay, çizim/düzenleme, MGRS | ✅ |
| 3 | [phase-3-symbology.md](phases/phase-3-symbology.md) | APP-6 semboloji, etiket, LOD, ingest Worker | ⬜ |
| 4 | [phase-4-composite-scale.md](phases/phase-4-composite-scale.md) | Composite, kümeleme, vektör altlık birleştirme | ⬜ |
| 5 | [phase-5-3d.md](phases/phase-5-3d.md) | Cesium, 3D model, terrain | ⬜ |

Durum işaretleri: ⬜ başlamadı · 🔄 devam ediyor · ✅ bitti · ⏸ beklemede

## Dosyalar

| Dosya | İçerik |
|---|---|
| [design/01-overview.md](design/01-overview.md) | İlkeler, temel kararlar, mimari genel bakış, paket yapısı |
| [design/02-core-model.md](design/02-core-model.md) | Geometri, Layer, Feature, Basemap, kamera tipleri |
| [design/03-store.md](design/03-store.md) | MapStore: transaction, değişiklik günlüğü, birleştirme, abonelik, canlı veri girişi |
| [design/04-sync-and-rendering.md](design/04-sync-and-rendering.md) | MapSync, render group, encode/diff, deck.gl yolu, LOD, sunum aşaması |
| [design/05-adapter-and-events.md](design/05-adapter-and-events.md) | MapAdapter sözleşmesi, RenderBatch, EventRouter |
| [design/06-layer-tree.md](design/06-layer-tree.md) | Katman ağacı ve headless-tree köprüsü |
| [design/07-react-api.md](design/07-react-api.md) | React API ve neden reconciler yok |
| [design/08-extensibility-symbology.md](design/08-extensibility-symbology.md) | Registry'ler, askeri semboloji, koordinat sistemleri |
| [design/09-interaction-and-editing.md](design/09-interaction-and-editing.md) | Seçim, hover, çizim, düzenleme (taslak) |
| [design/10-testing.md](design/10-testing.md) | Test ve ölçüm stratejisi |
| [spike/findings.md](spike/findings.md) | Spike ölçümleri ve uyumluluk notları |
| [decisions.md](decisions.md) | Karar kaydı ve açık kararlar |
