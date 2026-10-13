import { Map as MaplibreMap, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { SymbolCache } from './symbology';

// MapLibre 6 worker'ı kendi yanında arar; Vite paketleyince bu yol kırılır → açıkça veriyoruz.
setWorkerUrl(workerUrl);

export const UNITS_SOURCE = 'units';
export const UNITS_ICON_LAYER = 'units-icon';
const UNITS_HALO_LAYER = 'units-halo';

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

export function createMap(
  container: HTMLElement,
  symbols: SymbolCache,
  options: { unitLayers?: boolean } = {},
): Promise<MaplibreMap> {
  const map = new MaplibreMap({
    container,
    style,
    center: [32.85, 39.9],
    zoom: 6.5,
  });

  // Tembel sembol üretimi: MapLibre, stilde adı geçen ama henüz eklenmemiş bir ikonla karşılaşınca
  // bu fonksiyonu çağırır. Sembolü o anda üretip ekliyoruz → ekranda hiç görünmeyen sembol hiç üretilmez.
  // (MapLibre 6: eski `styleimagemissing` olayı artık ikonu o istek için sağlayamıyor; resolver şart.)
  map.setMissingStyleImageResolver((id) => {
    if (map.hasImage(id)) return;
    const img = symbols.get(id);
    const ctx = img.canvas.getContext('2d')!;
    map.addImage(id, ctx.getImageData(0, 0, img.canvas.width, img.canvas.height), {
      pixelRatio: img.pixelRatio,
    });
  });

  return new Promise((resolve) => {
    map.once('load', () => {
      // Çekirdek sayfası (core.html) kendi kaynağını kurar; eski spike sayfası bu katmanları kullanır.
      if (options.unitLayers !== false) addUnitLayers(map);
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

function addUnitLayers(map: MaplibreMap): void {
  // Unsur id'leri sayısal (feature.id) → hem updateData hem feature-state için güvenli.
  map.addSource(UNITS_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Her unsur yalnız `icon: <SIDC>` taşır; görüntü önbellekten gelir.
  map.addLayer({
    id: UNITS_ICON_LAYER,
    type: 'symbol',
    source: UNITS_SOURCE,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  // Seçim / hover halkası (sembolün üstünde): feature-state ile boyanır, veriye dokunmaz.
  map.addLayer({
    id: UNITS_HALO_LAYER,
    type: 'circle',
    source: UNITS_SOURCE,
    paint: {
      'circle-radius': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 24,
        ['boolean', ['feature-state', 'hovered'], false], 20,
        0,
      ],
      'circle-color': 'rgba(0,0,0,0)',
      // Yarıçap 0 olsa da çerçeve çizilir → seçili/hover dışındakilerde tamamen saydam yap.
      'circle-stroke-opacity': [
        'case',
        ['any', ['boolean', ['feature-state', 'selected'], false], ['boolean', ['feature-state', 'hovered'], false]], 1,
        0,
      ],
      'circle-stroke-width': 2,
      'circle-stroke-color': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], '#ffffff',
        '#9ad0ff',
      ],
    },
  });
}
