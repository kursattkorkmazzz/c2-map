# Faz 5 — 3D (Cesium)

← [Plan ana sayfası](../README.md) · Durum: 🔄 · Önkoşul: Faz 1–3 (sözleşme oturmuş olmalı)

**Amaç:** Aynı uygulama kodu ile 3D motor; desteklenmeyen özelliklerde zarif düşüş.

> 2026-10-16 — İlk sürüm: `packages/map-cesium`, demo `apps/map-spike/cesium.html`. Çekirdek ve
> React binding'i **hiç değişmeden** Cesium ile çalışıyor (değişen tek şey adapter). Cesium ion
> kullanılmıyor. Ayrıntı: [04 — Cesium yolu](../design/04-sync-and-rendering.md#cesium-yolu),
> [08 — Cesium arazi](../design/08-extensibility-symbology.md#cesium-arazi), ölçüm:
> [findings](../spike/findings.md#cesium-adapterı-faz-5-2026-10-16).

- [x] `@c2/map-cesium` adapter'ı (`MapAdapter` sözleşmesi): mount (`CesiumWidget`, ion görüntüsü kapalı),
  `applyBatch`, kamera (zoom / bearing / pitch ↔ mesafe / heading / pitch), `project` / `unproject`,
  olaylar + hit-test (`scene.pick` → sahibi olan unsur), çizim modu + önizleme
- [x] İmperatif renderer'lar (`create` / `update` / `remove` / `setState`):
  - [x] `billboardRenderer` — birlikler: tek `BillboardCollection`, görüntü anahtarla paylaşılır, araziye oturur, seçim halkası
  - [x] `vectorRenderer` — kontrol tedbirleri / çizimler: Entity, araziye giydirilmiş poligon / çizgi, `zIndex`
  - [x] `cesiumUavRenderer` — composite İHA: glTF model, sensör konisi + iz (tek primitive), irtifa etiketi, akıcı hareket
- [x] Altlıklar → `ImageryLayer` (XYZ, WMTS, WMS, TileJSON, IMAGE; sıra / opaklık / görünürlük yerinde)
- [x] Terrain — ücretsiz Terrarium karoları (AWS Open Data, anahtarsız), `CustomHeightmapTerrainProvider`;
  zemin yüksekliği önbelleği (`GroundHeightCache`)
- [x] İrtifa referansı: `UavProps.altitudeRef` (`ground` / `sea`), `UavProps` + `interpolateUav` çekirdeğe taşındı
- [x] Görüntü kalitesi ön ayarı (`high` / `balanced` / `fast`, çalışırken `setQuality`)
- [x] Demo: rastgele birlikler + İHA'lar (sayı / mesaj hızı ayarlanabilir), uydu altlığı, arazi abartısı, çizim / düzenleme / silme
- [ ] `model3d` kind (İHA dışında genel 3B model unsuru; şimdilik composite İHA üzerinden)
- [ ] Yetenek müzakeresi testi: `FeatureKindRegistry.fallback` (ör. model3d → marker) — adapter fallback zincirini kullanıyor, örnek yok
- [ ] 2D ↔ 3D geçiş (aynı store'la adapter değiştirme, kamera durumunun aktarılması) — kamera eşlemesi hazır, geçiş arayüzü yok
- [ ] Birlik etiketleri (Cesium `LabelCollection`) ve LOD (Faz 3 ile birlikte)
- [ ] Çok sayıda birlikte (10k+) ölçüm ve gerekirse `PointPrimitiveCollection` LOD'u
- [ ] Cesium için ayrı adapter testleri (gerçek `CesiumWidget` gerektirir; şimdilik renderer'lar + saf parçalar test ediliyor, adapter tarayıcıda doğrulandı)
