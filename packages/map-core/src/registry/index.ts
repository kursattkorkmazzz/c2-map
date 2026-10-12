// Registry'lerin genel API'si. Ortak `Registry<T>` temel sınıfı iç ayrıntıdır.

export type { RegisterOptions } from "./registry";
export { geometryBounds } from "./bounds";
export { FeatureKindRegistry, type FeatureKindDefinition } from "./feature-kind-registry";
export { BasemapProviderRegistry, isCustomSource } from "./basemap-provider-registry";
export {
  SymbologyRegistry,
  type SymbolImage,
  type SymbologyProvider,
  type SymbolRenderOptions,
} from "./symbology-registry";
