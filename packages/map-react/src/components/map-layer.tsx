import type { Layer } from '@c2/map-core';
import { useContext, type ReactNode } from 'react';
import { LayerContext } from '../context';
import { compact } from './compact';
import { useDeclarative, type DeclarativeOps } from './use-declarative';

export type MapLayerProps = {
  id: string;
  name?: string;
  /** Varsayılan `true`. Yalnız prop değişince yazılır (LayerTree'deki değişikliği ezmez). */
  visible?: boolean;
  /** Varsayılan 1. */
  opacity?: number;
  /** `true` → motor bu alt ağaç için ayrı kaynak/katman açar (ör. canlı birlikler). */
  renderGroup?: boolean;
  selectable?: boolean;
  interactive?: boolean;
  /** `false` → alt ağaçtaki unsurlar düzenlenemez (varsayılan açık). */
  editable?: boolean;
  /** `false` → alt ağaçtaki unsurlar silinemez (varsayılan açık). */
  deletable?: boolean;
  minZoom?: number;
  maxZoom?: number;
  meta?: Record<string, unknown>;
  /** Alt katmanlar ve unsurlar. */
  children?: ReactNode;
};

const layerOps: DeclarativeOps<Layer> = {
  upsert: (tx, layer) => tx.upsertLayers([layer]),
  patch: (tx, id, changed) => tx.patchLayer(id, changed),
  remove: (tx, id) => tx.removeLayers([id]),
};

/**
 * Katman (grup). İç içe kullanılabilir; ebeveyn, saran <MapLayer>'dır. Yeni katman kardeşlerinin
 * sonuna eklenir (sonradan koşullu render edilen katman JSX'teki yerine değil sona girer;
 * sıralama LayerTree / `tx.moveLayer` işidir). Unmount → katman alt ağacıyla silinir.
 */
export function MapLayer({ children, ...props }: MapLayerProps) {
  const parentId = useContext(LayerContext);
  const layer = compact<Layer>({
    id: props.id,
    name: props.name ?? props.id,
    parentId,
    visible: props.visible ?? true,
    opacity: props.opacity ?? 1,
    renderGroup: props.renderGroup,
    selectable: props.selectable,
    interactive: props.interactive,
    editable: props.editable,
    deletable: props.deletable,
    minZoom: props.minZoom,
    maxZoom: props.maxZoom,
    meta: props.meta,
  });
  useDeclarative('<MapLayer>', layer, layerOps);
  return <LayerContext.Provider value={props.id}>{children}</LayerContext.Provider>;
}
