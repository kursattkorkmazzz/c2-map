// ── BasemapProviderRegistry ──────────────────────────────────────
// Firma-özel auth (header), URL dönüşümü ve `custom:*` kaynak tiplerini standart tiplere
// çevirme için genişleme noktası. Adapter altlığı çizmeden önce buradan geçirir.

import type { Basemap, BasemapProvider, BasemapSource } from "../model/basemap";
import { Registry, type RegisterOptions } from "./registry";

const CUSTOM_PREFIX = "custom:";
const MAX_RESOLVE_DEPTH = 8;

export const isCustomSource = (source: BasemapSource): boolean => source.type.startsWith(CUSTOM_PREFIX);

export class BasemapProviderRegistry {
  private readonly registry = new Registry<BasemapProvider>("altlık sağlayıcısı", (p) => p.id);

  register(provider: BasemapProvider, options?: RegisterOptions): () => void {
    return this.registry.register(provider, options);
  }

  get(id: string): BasemapProvider | undefined {
    return this.registry.get(id);
  }

  has(id: string): boolean {
    return this.registry.has(id);
  }

  /**
   * `custom:*` kaynağı standart bir tipe çevirir. Sağlayıcı: önce altlığın `provider` alanı,
   * yoksa tipteki ad (`custom:firma-a` → `firma-a`). Standart kaynak aynen döner.
   * Çevrilemiyorsa `null` (adapter altlığı çizmez).
   */
  resolveSource(basemap: Basemap): BasemapSource | null {
    let source = basemap.source;
    for (let depth = 0; isCustomSource(source); depth++) {
      if (depth >= MAX_RESOLVE_DEPTH) return null;
      const provider =
        (basemap.provider !== undefined ? this.get(basemap.provider) : undefined) ??
        this.get(source.type.slice(CUSTOM_PREFIX.length));
      if (!provider?.resolve) return null;
      const next = provider.resolve(source);
      if (next === source) return null; // ilerleme yok
      source = next;
    }
    return source;
  }

  /** İstek URL'sini (tile vb.) altlığın sağlayıcısından geçirir: auth header, imzalı URL… */
  transformRequest(basemap: Basemap, url: string): { url: string; headers?: Record<string, string> } {
    const provider = basemap.provider !== undefined ? this.get(basemap.provider) : undefined;
    return provider?.transformRequest?.(url) ?? { url };
  }
}
