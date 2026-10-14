# 08 — Genişletilebilirlik, semboloji, koordinatlar

← [Plan ana sayfası](../README.md) · Faz: [0.6](../phases/phase-0-core.md#06-registryler), [3](../phases/phase-3-symbology.md)

## Registry'ler

1. **`FeatureKindRegistry`** (çekirdek, motor-bağımsız):
   `kind → { validate, defaultStyle, defaultProps, bounds(f), fallback(f) }`.
   `fallback`: motor bu kind'i desteklemiyorsa daha basit bir kind'e çevirir (model3d → marker).
   Sonra eklenecek: `clusterKey(f)` (sembol-farkında kümeleme, [04](04-sync-and-rendering.md#sunum-aşaması-kümeleme-için-genişleme-noktası)).
2. **Adapter renderer'ları:** `adapter.registerRenderer(kind, renderer)` ([05](05-adapter-and-events.md#renderer-türleri)).
3. **`BasemapProviderRegistry`:** firma-özel auth, URL dönüşümü, `custom:*` kaynak tipleri.
4. **`SymbologyRegistry`:** aşağıda.

Uygulama ayrıntıları (kod: `src/registry/`):

- Tüm registry'ler aynı kuralı izler: aynı anahtarı ikinci kez kaydetmek **hata**; bilinçli
  değiştirme `{ replace: true }` ile. `register` geri alma fonksiyonu döner (yalnız hâlâ aynı
  nesne kayıtlıysa siler).
- `FeatureKindRegistry.withDefaults(f)`: `defaultStyle` / `defaultProps` unsurun değerleriyle sığ
  birleşir (unsurun değeri baskın); varsayılan yoksa aynı referans döner.
- `FeatureKindRegistry.resolveFor(f, isSupported)`: motorun desteklediği kind'e ulaşana kadar
  fallback zincirini izler (en fazla 8 adım; döngülü tanımlar sonsuza gitmez), ulaşılamazsa `null`.
- `bounds` verilmezse `geometryBounds(geometry)` kullanılır (daire: metreden yaklaşık derece).
- `BasemapProviderRegistry.resolveSource(basemap)`: `custom:*` için sağlayıcı önce altlığın
  `provider` alanından, yoksa tip adından (`custom:firma-a` → `firma-a`) bulunur; çözülemezse `null`.

## Askeri semboloji

```ts
export interface SymbologyProvider<TModifiers = Record<string, unknown>> {
  id: string; // 'app6d', '2525e', 'c2-custom'
  validate(code: string): boolean;
  cacheKey(code: string, mods: TModifiers, sizePx: number): string;
  render(code: string, mods: TModifiers, opts: { sizePx: number; pixelRatio: number }):
    Promise<SymbolImage> | SymbolImage;
}
export type SymbolImage = {
  image: ImageData | ImageBitmap;
  width: number;
  height: number;
  anchor: [number, number];
};
```

- `milsym` kind props: `{ standard: 'app6d', code: '...', modifiers: {...} }`.
- `cacheKey` yalnız görüntüyü gerçekten değiştiren ve **birlikler arasında paylaşılan**
  alanları içerir. Birliğe özel metin değiştiricileri (ör. benzersiz tanıtıcı) etikete gider.
- APP-6(D) SIDC 20 hanelidir: `sürüm|bağlam|kimlik|sembol seti|durum|KH/GK|kademe|varlık|değiştiriciler`
  (spike: `100${kimlik}1000${kademe}${varlık}0000`).
- İlk sağlayıcı `@c2/map-symbology-app6` (`milsymbol`, APP-6 D). Kurum içi semboloji =
  aynı arayüzü uygulayan yeni paket.
- Görüntüler lazy üretilir ve önbelleklenir ([04](04-sync-and-rendering.md#askeri-semboller-ve-ikonlar)).

## Composite unsur: İHA

> 2026-10-14 — Faz 4.1'den öne alındı; ilk örnek `kind: 'uav'`. Kod: `map-core/src/geo/sensor.ts`,
> `map-maplibre/src/deck/uav-renderer.ts`; demo `apps/map-spike` (`react.html`, "İHA'lara git (3B)").

**Composite = store'da TEK unsur, haritada birden çok görsel parça.** Backend yalnız unsuru
günceller (konum, yön, irtifa, sensör); parçalar her güncellemede renderer'da yeniden üretilir.
Seçim / hover / sağ tık / izinler unsurun kendisine aittir (parçalara değil).

```ts
{ id: 'iha-1', layerId: 'ihalar', kind: 'uav',
  geometry: { kind: 'point', coord: [lon, lat] },
  props: {
    headingDeg: 329,          // burun yönü (kuzeyden saat yönü)
    altitudeM: 2800,          // yerden yükseklik
    callsign: 'TB2-3',
    sensor: { panDeg: 45, tiltDeg: 53, hfovDeg: 18, vfovDeg: 12, maxRangeM: 25000 },
  } }
```

| Parça | deck.gl katmanı | Kaynak |
|---|---|---|
| 3B model | `ScenegraphLayer` (glTF) | konum + irtifa + `headingDeg` |
| Sensör konisi | `SolidPolygonLayer` (`_full3d`), 4 yarı saydam üçgen | tepe İHA'da, taban zemindeki iz |
| Zemindeki iz | `SolidPolygonLayer` | `sensorFootprint` köşeleri |
| Çizgiler | `LineLayer` | koni kenarları, bakış ekseni (kırmızı), İHA → zemin dikey çizgi |
| Etiket | `TextLayer` | çağrı adı + irtifa |

- **Sensör izi çekirdekte** (`sensorFootprint`, saf, motor bilmez): bakış azimutu = burun + pan;
  eğim = ufkun altına bakış; görüş dörtgeninin dört köşe ışını yerel ENU'da kurulup düz zeminle
  kesiştirilir. Ufka yakın / üstüne bakan ışın `maxRangeM`'de kesilir (`clipped`). Cesium da aynı
  köşeleri kullanır.
- **deck.gl "katman renderer'ı"** (`DeckLayersRenderer`, `type: 'layers'`): ikon yolunun (50k,
  typed array) yanında ikinci tür. Az sayıda zengin unsur için: unsurlarından kendi katmanlarını
  üretir, `load()` mount'ta beklenir (katman sınıfları + glTF yükleyici dinamik import). Seçim için
  veri nesneleri `featureId` taşır. Grup sırası (`beforeId`) ve seçim halkası denetleyiciden gelir.
- **Model ekseni:** glTF +Z burun, +Y yukarı kabul edilir; dönüş `[0, 180 + yawOffset − heading, 90]`
  (tarayıcıda doğrulandı). Farklı eksenli model `yawOffsetDeg` ile düzeltilir. Ölçek
  `modelScale` (birim → metre) + uzaktan görünürlük için `minPixels`.
- **Yarı saydam yüzeyler** derinliğe yazmaz (`depthWriteEnabled: false`): koni yüzleri birbirini
  ve modeli kesip delik bırakmasın.
- **3B görünüm** MapLibre eğimiyle (2,5B): arazi yok, irtifa düz zemine göre. Gerçek arazi / küre
  Faz 5 (Cesium).
- Model: "Predator Drone" — sftwr314r8, Poly Pizza, CC BY 3.0 (`apps/map-spike/public/models/ATTRIBUTION.md`).

## Koordinat sistemleri

- Kanonik: WGS84 `[lon, lat, alt?]`. Adapter kendi projeksiyonunu yönetir.
- `@c2/map-core` `geo/` (Faz 2.3 ✅):
  - **UTM** — Krüger serisi (6. derece), elle yazıldı: zone içinde nm düzeyinde gidiş-dönüş.
    Kapsam -80°..84° (kutuplar UPS ister, kapsam dışı). Norveç / Svalbard zone istisnaları.
    Metin **bant harfiyle** yazılır ("36S 684296 4420004"): "S" güney değil S bandıdır (Türkiye).
  - **MGRS** — rakamlar kesilir (yuvarlanmaz); okuma karenin merkezini ve güneybatı köşesini
    döner. Satır harfi 2000 km periyotlu olduğundan kuzey, bandın güney kenarından bulunur.
    Doğrulama: `mgrs` kütüphanesi yalnız testte referans (çalışma zamanı bağımlılığı değil).
  - **DD / DM / DMS** — yön harfleri İngilizce (N S E W) veya Türkçe (K G D B). İnsan metni
    **enlem önce**; fonksiyonlar `[lon, lat]` döner. `parseCoordinate` "koordinata git"
    kutusu içindir: MGRS, UTM, DD, DM, DMS; virgüllü ondalık; yön harfi yoksa enlem önce.
- Mesafe / yön / hedef nokta / alan: **`geographiclib-geodesic`** (Karney; çekirdeğin tek
  çalışma zamanı bağımlılığı). Küre formülleri (haversine) %0,3'e kadar hata verir — menzil ve
  alan ölçümünde kabul edilmez. `CIRCLE.radiusM` metredir; MapLibre'de encode sırasında
  poligona çevrilir (zoom'dan bağımsız doğru yarıçap). Çekirdekte `geodesicCircle` de var.
