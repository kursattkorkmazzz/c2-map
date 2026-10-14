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
