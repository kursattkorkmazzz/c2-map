// ── `marker` kind: ikonlu nokta ──────────────────────────────────
// İkon id'si verilirse sembol olarak, verilmezse daire olarak çizilir. Nokta olmayan geometride
// temsilci nokta (sınır kutusu merkezi) kullanılır. İkon görüntüleri adapter'ın `resolveImage`
// seçeneğiyle (veya stilin sprite'ından) tembel olarak yüklenir.

import type { Feature } from '@c2/map-core';
import type { LayerSpecification } from 'maplibre-gl';
import { representativePoint } from '../geometry';
import {
  byState,
  HOVER_COLOR,
  NON_INTERACTIVE,
  SELECTED_COLOR,
  SORT_KEY,
  withOpacity,
  type MaplibreKindRenderer,
} from './types';

export type MarkerStyle = {
  /** İkon yoksa çizilen dairenin rengi. */
  color?: string;
  /** İkon yoksa çizilen dairenin yarıçapı (px). İkon boyutu unsur başına DEĞİL, renderer seçeneğidir. */
  size?: number;
  /** Derece, kuzeyden saat yönünde (yalnız yönlü ikonlar için). */
  rotation?: number;
};

export type MarkerRendererOptions = {
  /** Unsurdan ikon (görüntü) id'si. Varsayılan: `props.icon`. Boş/undefined → daire. */
  icon?: (feature: Feature) => string | undefined;
  /**
   * İkon ölçeği, katmandaki TÜM ikonlar için sabit (1 = görüntünün kendi boyutu).
   * Bilinçli olarak veri güdümlü değil: MapLibre'de unsur başına `icon-size` (['get', …]) sık
   * güncellenen kaynakta kare hızını çökertiyor (ölçüm: 10k birlikte ~120 → 1–2 FPS).
   * Farklı boyutlar gerekiyorsa ayrı kind / renderer kullanın.
   */
  iconSize?: number;
};

const defaultIcon = (f: Feature) => (f.props as { icon?: string } | undefined)?.icon;

export function markerRenderer(options: MarkerRendererOptions = {}): MaplibreKindRenderer {
  const iconOf = options.icon ?? defaultIcon;
  const iconSize = options.iconSize ?? 1;

  return {
    layers(ctx) {
      const source = ctx.sourceId;
      const filterKind = ['==', ['get', '_kind'], ctx.kind];
      const hasIcon = ['!=', ['get', '_icon'], ''];
      return [
        {
          id: ctx.layerId('icon'),
          type: 'symbol',
          source,
          filter: ['all', filterKind, hasIcon],
          layout: {
            'icon-image': ['get', '_icon'],
            'icon-size': iconSize, // sabit: veri güdümlü icon-size kare hızını çökertir (bkz. iconSize)
            'icon-rotate': ['get', '_rot'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'symbol-sort-key': SORT_KEY,
          },
          paint: { 'icon-opacity': withOpacity(1) },
        },
        {
          id: ctx.layerId('dot'),
          type: 'circle',
          source,
          filter: ['all', filterKind, ['!', hasIcon]],
          layout: { 'circle-sort-key': SORT_KEY },
          paint: {
            'circle-color': ['get', '_color'],
            'circle-radius': ['get', '_size'],
            'circle-opacity': withOpacity(1),
          },
        },
        {
          // Seçim / hover halkası. Yarıçap 0 olsa da çerçeve çizildiği için seçili/hover
          // dışındakilerde çerçeve tamamen saydam (spike bulgusu).
          id: ctx.layerId('halo'),
          type: 'circle',
          source,
          filter: filterKind,
          metadata: NON_INTERACTIVE,
          paint: {
            'circle-radius': byState(22, 18, 0),
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-width': 2,
            'circle-stroke-color': byState(SELECTED_COLOR, HOVER_COLOR, HOVER_COLOR),
            'circle-stroke-opacity': byState(1, 1, 0),
          },
        },
      ] as unknown as LayerSpecification[]; // ifadeler (expression) MapLibre tiplerinde dar tanımlı
    },

    encode(rf, ctx) {
      const feature: Feature = ctx.kinds.withDefaults(rf.feature);
      const style = (feature.style ?? {}) as MarkerStyle;
      const icon = iconOf(feature) ?? '';
      return [
        {
          geometry: representativePoint(feature.geometry),
          properties: {
            _icon: icon,
            _size: style.size ?? 5, // yalnız ikonsuz dairenin yarıçapı
            _rot: style.rotation ?? 0,
            _color: style.color ?? '#3d8bfd',
          },
        },
      ];
    },
  };
}

/** Varsayılan ayarlarla marker renderer'ı (`props.icon`). */
export const defaultMarkerRenderer = markerRenderer();
