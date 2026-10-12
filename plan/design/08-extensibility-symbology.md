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
- `@c2/map-core` util (Faz 2): MGRS ↔ lon/lat, UTM, DMS/DD format.
- Mesafe/alan: haversine + jeodezik. `CIRCLE.radiusM` metredir; MapLibre'de encode sırasında
  poligona çevrilir (zoom'dan bağımsız doğru yarıçap).
