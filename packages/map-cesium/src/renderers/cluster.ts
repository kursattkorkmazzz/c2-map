// ── Küme renderer'ı (Cesium billboard) ───────────────────────────
// `ClusterStage`'in `cluster` kind'ı: rozet (çekirdekteki `clusterBadge`) billboard olarak, birliklerle
// aynı yoldan (araziye oturur, tepe arkasında kaybolmaz, seçim halkası).
//
// Kullanım: createCesiumAdapter({ renderers: { …, cluster: cesiumClusterRenderer({ color }) } })

import { clusterBadge, type ClusterBadgeOptions, type ClusterProps } from '@c2/map-core';
import { billboardRenderer, type BillboardRendererOptions } from './billboard';
import type { CesiumKindRenderer } from './types';

export function cesiumClusterRenderer(
  options: ClusterBadgeOptions & Pick<BillboardRendererOptions, 'clampToGround' | 'scaleByDistance'> = {},
): CesiumKindRenderer<unknown> {
  return billboardRenderer({
    clampToGround: options.clampToGround,
    // Küme zaten "uzak görünüm"; uzaklaştıkça küçülmesin
    scaleByDistance: options.scaleByDistance ?? null,
    image: (feature) => {
      const props = feature.props as ClusterProps | undefined;
      if (!props) return undefined;
      const badge = clusterBadge(props.count, props.key, options);
      return { key: badge.id, image: badge.canvas, width: badge.size, height: badge.size };
    },
  }) as CesiumKindRenderer<unknown>;
}
