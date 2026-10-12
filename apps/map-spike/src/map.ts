import { Map as MaplibreMap, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { UNIT_STATUS_COUNT } from './generator';

// MapLibre 6 worker'ı kendi yanında arar; Vite paketleyince bu yol kırılır → açıkça veriyoruz.
setWorkerUrl(workerUrl);

export const UNITS_SOURCE = 'units';
export const UNITS_ICON_LAYER = 'units-icon';
const UNITS_HALO_LAYER = 'units-halo';

export const STATUS_COLORS =['#3d8bfd', '#ff4d4f', '#52c41a', '#fadb14'] as const;

export const iconName = (status: number): string => `unit-${status}`;

const style: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#1d232b' } },
    { id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-opacity': 0.55, 'raster-saturation': -0.6 } },
  ],
};

export function createMap(container: HTMLElement): Promise<MaplibreMap> {
  const map = new MaplibreMap({
    container,
    style,
    center: [32.85, 39.9],
    zoom: 6.5,
  });
  return new Promise((resolve) => {
    map.once('load', () => {
      addUnitIcons(map);
      addUnitLayers(map);
      resolve(map);
    });
  });
}

export function getUnitsSource(map: MaplibreMap): GeoJSONSource {
  const src = map.getSource<GeoJSONSource>(UNITS_SOURCE);
  if (!src) throw new Error('units source yok');
  return src;
}

export function setBasemapVisible(map: MaplibreMap, visible: boolean): void {
  map.setLayoutProperty('osm', 'visibility', visible ? 'visible' : 'none');
}

/** deck.gl modunda MapLibre'nin kendi birlik katmanları gizlenir. */
export function setUnitLayersVisible(map: MaplibreMap, visible: boolean): void {
  for (const id of [UNITS_HALO_LAYER, UNITS_ICON_LAYER]) {
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

/** Çakışma (collision) hesabını aç/kapat. Açıkken üst üste binen ikonlar gizlenir ama CPU maliyeti artar. */
export function setIconCollision(map: MaplibreMap, enabled: boolean): void {
  map.setLayoutProperty(UNITS_ICON_LAYER, 'icon-allow-overlap', !enabled);
  map.setLayoutProperty(UNITS_ICON_LAYER, 'icon-ignore-placement', !enabled);
}

// Her durum rengi için TEK bir ok ikonu üretilir; 10k birlik bu 4 görüntüyü paylaşır.
function addUnitIcons(map: MaplibreMap): void {
  const ratio = 2;
  const size = 22 * ratio;
  for (let s = 0; s < UNIT_STATUS_COUNT; s++) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.translate(size / 2, size / 2);
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.42);
    ctx.lineTo(size * 0.3, size * 0.36);
    ctx.lineTo(0, size * 0.18);
    ctx.lineTo(-size * 0.3, size * 0.36);
    ctx.closePath();
    ctx.fillStyle = STATUS_COLORS[s] ?? '#fff';
    ctx.strokeStyle = '#0b0e12';
    ctx.lineWidth = 2 * ratio;
    ctx.fill();
    ctx.stroke();
    map.addImage(iconName(s), ctx.getImageData(0, 0, size, size), { pixelRatio: ratio });
  }
}

function addUnitLayers(map: MaplibreMap): void {
  // Unsur id'leri sayısal (feature.id) → hem updateData hem feature-state için güvenli.
  map.addSource(UNITS_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Seçim / hover halkası: feature-state ile boyanır, veriye dokunmaz.
  map.addLayer({
    id: UNITS_HALO_LAYER,
    type: 'circle',
    source: UNITS_SOURCE,
    paint: {
      'circle-radius': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 16,
        ['boolean', ['feature-state', 'hovered'], false], 12,
        0,
      ],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 2,
      'circle-stroke-color': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], '#ffffff',
        '#9ad0ff',
      ],
    },
  });

  map.addLayer({
    id: UNITS_ICON_LAYER,
    type: 'symbol',
    source: UNITS_SOURCE,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-rotate': ['get', 'hdg'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
}
