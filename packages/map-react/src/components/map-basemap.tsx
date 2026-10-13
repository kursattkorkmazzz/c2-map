import type { Basemap, BasemapSource } from '@c2/map-core';
import { compact } from './compact';
import { useDeclarative, type DeclarativeOps } from './use-declarative';

export type MapBasemapProps = {
  id: string;
  name?: string;
  source: BasemapSource;
  /** Varsayılan `true`. `exclusiveGroup` kuralıyla store başkasını kapatabilir; prop yalnız değişince yazılır. */
  visible?: boolean;
  /** Varsayılan 1. */
  opacity?: number;
  /** Varsayılan 0. Üstteki yüksek. */
  order?: number;
  provider?: string;
  exclusiveGroup?: string;
  attribution?: string;
  thumbnail?: string;
};

const basemapOps: DeclarativeOps<Basemap> = {
  upsert: (tx, basemap) => tx.upsertBasemaps([basemap]),
  patch: (tx, id, changed) => tx.patchBasemap(id, changed),
  remove: (tx, id) => tx.removeBasemaps([id]),
};

export function MapBasemap(props: MapBasemapProps) {
  const basemap = compact<Basemap>({
    id: props.id,
    name: props.name ?? props.id,
    source: props.source,
    visible: props.visible ?? true,
    opacity: props.opacity ?? 1,
    order: props.order ?? 0,
    provider: props.provider,
    exclusiveGroup: props.exclusiveGroup,
    attribution: props.attribution,
    thumbnail: props.thumbnail,
  });
  useDeclarative('<MapBasemap>', basemap, basemapOps);
  return null;
}
