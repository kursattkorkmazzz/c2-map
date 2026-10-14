// @c2/map-maplibre — MapLibre GL JS adapter'ı (@c2/map-core MapAdapter sözleşmesi).

export {
  BASEMAP_ANCHOR_LAYER,
  createMaplibreAdapter,
  MaplibreAdapter,
  type MapInit,
  type MaplibreAdapterOptions,
  type MaplibreAdapterStats,
  type ResolvedImage,
} from './adapter';
export {
  deckIconRenderer,
  loadDeckModules,
  type DeckKindRenderer,
  type DeckModules,
  type DeckOverlayLike,
  type DeckStats,
  type DeckTiming,
} from './deck/deck-controller';
export type { DeckIcon } from './deck/deck-group';
export { MOTION_MODE, MotionGovernor, type MotionAutoOptions, type MotionMode } from './deck/motion';
export { SUPPORTED_BASEMAP_SOURCES, toSourceSpec, type BasemapStats } from './basemaps';
export { STANDARD_PROPS, type EncodedPart, type PropertyValue } from './encode';
export { representativePoint, toGeoJSONGeometry } from './geometry';
export type { GeoJSONSourceLike, MapImage, MapLike } from './map-like';
export { defaultMarkerRenderer, markerRenderer, type MarkerRendererOptions, type MarkerStyle } from './renderers/marker';
export {
  byState,
  NON_INTERACTIVE,
  SORT_KEY,
  withOpacity,
  type MaplibreEncodeContext,
  type MaplibreKindRenderer,
  type MaplibreLayerContext,
} from './renderers/types';
export { VECTOR_DEFAULTS, vectorRenderer, type VectorStyle } from './renderers/vector';
