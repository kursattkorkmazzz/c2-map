import type { LngLat } from "./geometry";

export const BASEMAP_SOURCE = {
  XYZ: "xyz", // {z}/{x}/{y} raster
  WMTS: "wmts",
  WMS: "wms",
  TILEJSON: "tilejson",
  VECTOR_STYLE: "vector-style", // MapLibre style.json (sokak görünümü vb.)
  IMAGE: "image", // kendi yüklediğimiz, 4 köşe ile georeferanslı görüntü
} as const;
export type BasemapSourceType =
  (typeof BASEMAP_SOURCE)[keyof typeof BASEMAP_SOURCE];

export type BasemapSource =
  | {
      type: typeof BASEMAP_SOURCE.XYZ;
      urlTemplate: string;
      tileSize?: number;
      minZoom?: number;
      maxZoom?: number;
    }
  | {
      type: typeof BASEMAP_SOURCE.WMTS;
      url: string;
      layer: string;
      tileMatrixSet: string;
      format?: string;
    }
  | {
      type: typeof BASEMAP_SOURCE.WMS;
      url: string;
      layers: string;
      format?: string;
      params?: Record<string, string>;
    }
  | { type: typeof BASEMAP_SOURCE.TILEJSON; url: string }
  | { type: typeof BASEMAP_SOURCE.VECTOR_STYLE; styleUrl: string }
  | {
      type: typeof BASEMAP_SOURCE.IMAGE;
      url: string;
      corners: readonly [LngLat, LngLat, LngLat, LngLat];
    } // TL, TR, BR, BL
  | { type: `custom:${string}`; config: unknown }; // BasemapProviderRegistry ile

export type Basemap = {
  id: string;
  name: string;
  provider?: string; // 'firma-a', 'firma-b', 'local' … (gruplama/auth için)
  source: BasemapSource;
  visible: boolean;
  opacity: number;
  order: number; // altlıklar arası sıra (üstteki yüksek)
  exclusiveGroup?: string; // aynı gruptan yalnız biri açık (radyo davranışı), ops.
  attribution?: string;
  thumbnail?: string;
};

// Firma bazlı auth / URL dönüşümü / özel tipler için genişleme noktası
export interface BasemapProvider {
  id: string;
  transformRequest?(url: string): {
    url: string;
    headers?: Record<string, string>;
  };
  resolve?(source: BasemapSource): BasemapSource; // custom:* → standart tipe çevir
}
