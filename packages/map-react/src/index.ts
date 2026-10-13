// @c2/map-react — @c2/map-core için React binding'i. Motor bilmez: adapter dışarıdan verilir.
// Tasarım: plan/design/07-react-api.md

export { Map, MapStoreProvider, type MapProps } from './map';
export type { MapHandle } from './map-handle';
export { MapLayer, type MapLayerProps } from './components/map-layer';
export {
  BUILTIN_KIND,
  Circle,
  MapFeature,
  Marker,
  MilSymbol,
  Polygon,
  Polyline,
  type MapFeatureProps,
} from './components/map-feature';
export { MapBasemap, type MapBasemapProps } from './components/map-basemap';
export { MapOverlay, type MapOverlayProps } from './components/map-overlay';
export {
  useBasemaps,
  useFeature,
  useHovered,
  useLayer,
  useLayerVisibility,
  useMap,
  useMapReady,
  useMapStore,
  useSelection,
  type SelectionApi,
} from './hooks/store-hooks';
export { useFeatureEvent, useLayerEvent, useMapEvent } from './hooks/event-hooks';
