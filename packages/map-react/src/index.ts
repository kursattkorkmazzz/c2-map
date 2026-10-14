// @c2/map-react — @c2/map-core için React binding'i. Motor bilmez: adapter dışarıdan verilir.
// Tasarım: plan/design/07-react-api.md

export { applyClickSelection, Map, MapStoreProvider, type MapProps } from './map';
export { isInLayer, MapTooltip, type MapTooltipProps } from './components/map-tooltip';
export { MapContextMenu, type ContextMenuState, type MapContextMenuProps } from './components/map-context-menu';
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
export { MapOverlay, OVERLAY_ALIGN, type MapOverlayProps, type OverlayAlign } from './components/map-overlay';
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
