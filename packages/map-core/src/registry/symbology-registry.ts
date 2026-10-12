// ── SymbologyRegistry ────────────────────────────────────────────
// Tasarım: plan/design/08-extensibility-symbology.md#askeri-semboloji
//
// Askeri semboloji sağlayıcılarının arayüzü. Çekirdek yalnız sözleşmeyi tanımlar; APP-6(D)
// sağlayıcısı (`milsymbol`) ayrı pakettedir (@c2/map-symbology-app6).

import { Registry, type RegisterOptions } from "./registry";

export type SymbolImage = {
  image: ImageData | ImageBitmap;
  /** CSS piksel boyutu. */
  width: number;
  height: number;
  /** Çapa noktası (görüntü içinde, CSS piksel). Ortalanmış görüntüde [width/2, height/2]. */
  anchor: readonly [number, number];
};

export type SymbolRenderOptions = { sizePx: number; pixelRatio: number };

export interface SymbologyProvider<TModifiers = Record<string, unknown>> {
  /** Standart adı: 'app6d', '2525e', 'c2-custom' … (`milsym` props'undaki `standard`). */
  id: string;
  validate(code: string): boolean;
  /**
   * Görüntü önbellek anahtarı. Yalnız görüntüyü değiştiren ve birlikler arasında PAYLAŞILAN
   * değiştiricileri içermeli; birliğe özel metin (benzersiz tanıtıcı vb.) girmemeli.
   */
  cacheKey(code: string, modifiers: TModifiers, sizePx: number): string;
  render(code: string, modifiers: TModifiers, options: SymbolRenderOptions): Promise<SymbolImage> | SymbolImage;
}

export class SymbologyRegistry {
  private readonly registry = new Registry<SymbologyProvider>("semboloji sağlayıcısı", (p) => p.id);

  register(provider: SymbologyProvider, options?: RegisterOptions): () => void {
    return this.registry.register(provider, options);
  }

  get(standard: string): SymbologyProvider | undefined {
    return this.registry.get(standard);
  }

  has(standard: string): boolean {
    return this.registry.has(standard);
  }

  standards(): string[] {
    return this.registry.keys();
  }
}
