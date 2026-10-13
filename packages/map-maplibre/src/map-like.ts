// ── MapLike: adapter'ın MapLibre'den kullandığı alt küme ──────────
// Adapter doğrudan `maplibregl.Map`'e değil bu arayüze bağlıdır: testlerde sahte bir harita
// (src/testing/fake-map.ts) verilir; gerçek uygulamada `maplibregl.Map` bu arayüzü karşılar.

import type {
  FeatureIdentifier,
  GeoJSONSourceDiff,
  LayerSpecification,
  LngLatLike,
  SourceSpecification,
} from 'maplibre-gl';

export interface GeoJSONSourceLike {
  updateData(diff: GeoJSONSourceDiff): unknown;
}

/** Görüntü kaynağı: `map.addImage`'in kabul ettiği türler. */
export type MapImage = ImageData | ImageBitmap | HTMLImageElement | { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

export interface MapLike {
  // Kaynak / katman
  addSource(id: string, source: SourceSpecification): unknown;
  getSource(id: string): unknown;
  removeSource(id: string): unknown;
  addLayer(layer: LayerSpecification, beforeId?: string): unknown;
  getLayer(id: string): unknown;
  moveLayer(id: string, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  setPaintProperty(layerId: string, name: string, value: unknown): unknown;
  setLayoutProperty(layerId: string, name: string, value: unknown): unknown;

  // Durum ve sorgu
  setFeatureState(feature: FeatureIdentifier, state: Record<string, unknown>): unknown;
  queryRenderedFeatures(
    point: [number, number],
    options: { layers: string[] },
  ): ReadonlyArray<{ properties: Record<string, unknown> | null }>;

  // Görüntüler
  addImage(id: string, image: MapImage, options?: { pixelRatio?: number }): unknown;
  hasImage(id: string): boolean;
  removeImage(id: string): unknown;
  setMissingStyleImageResolver(resolver: ((id: string) => void | Promise<void>) | null): unknown;

  // Olaylar
  on(type: string, listener: (event: any) => void): unknown;
  off(type: string, listener: (event: any) => void): unknown;

  // Kamera
  jumpTo(options: { center?: LngLatLike; zoom?: number; bearing?: number; pitch?: number }): unknown;
  flyTo(options: { center?: LngLatLike; zoom?: number; bearing?: number; pitch?: number; duration?: number }): unknown;
  fitBounds(bounds: [number, number, number, number], options?: { padding?: number }): unknown;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
  project(lngLat: [number, number]): { x: number; y: number };
  unproject(point: [number, number]): { lng: number; lat: number };

  // Yaşam döngüsü
  resize(): unknown;
  remove(): void;
  getCanvas(): { style: { cursor: string } };
}
