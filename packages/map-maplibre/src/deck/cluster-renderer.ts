// ── Küme renderer'ı (deck.gl ikon yolu) ──────────────────────────
// `ClusterStage`'in ürettiği `cluster` kind'ı: rozet (renkli daire + sayı) birliklerle aynı ikon
// katmanında. Rozet çekirdekte (`clusterBadge`); burada data URL'e çevrilip ikon olarak verilir.
// Etiket kümesi sınırlı olduğu için ikon atlası şişmez. Seçim halkası ve hit-test ikon yolundan gelir.
//
// Kullanım: createMaplibreAdapter({ deckRenderers: { milsym: …, cluster: clusterIconRenderer({ color }) } })

import { clusterBadge, type ClusterBadgeOptions, type ClusterProps } from '@c2/map-core';
import type { DeckKindRenderer } from './deck-controller';
import type { DeckIcon } from './deck-group';

export function clusterIconRenderer(options: ClusterBadgeOptions = {}): DeckKindRenderer {
  const icons = new Map<string, DeckIcon>();
  return {
    icon(feature) {
      const props = feature.props as ClusterProps | undefined;
      if (!props) return undefined;
      const badge = clusterBadge(props.count, props.key, options);
      let icon = icons.get(badge.id);
      if (!icon) {
        icon = { id: badge.id, url: badge.canvas.toDataURL(), width: badge.canvas.width, height: badge.canvas.height };
        icons.set(badge.id, icon);
      }
      return icon;
    },
    size(feature) {
      const props = feature.props as ClusterProps | undefined;
      return props ? clusterBadge(props.count, props.key, options).size : 0;
    },
  };
}
