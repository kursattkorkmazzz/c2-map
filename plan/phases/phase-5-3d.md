# Faz 5 — 3D (Cesium)

← [Plan ana sayfası](../README.md) · Durum: ⬜ · Önkoşul: Faz 1–3 (sözleşme oturmuş olmalı)

**Amaç:** Aynı uygulama kodu ile 3D motor; desteklenmeyen özelliklerde zarif düşüş.

- [ ] `@c2/map-cesium` adapter'ı (`MapAdapter` sözleşmesi)
- [ ] İmperatif renderer'lar: Billboard / Primitive koleksiyonları
- [ ] `model3d` kind (2,5B ön örnek MapLibre + deck.gl `ScenegraphLayer` ile İHA'da: [08](../design/08-extensibility-symbology.md#composite-unsur-iha))
- [ ] Terrain
- [ ] Yetenek müzakeresi: `FeatureKindRegistry.fallback` (ör. model3d → marker)
- [ ] 2D ↔ 3D geçiş (kamera durumunun aktarılması)
