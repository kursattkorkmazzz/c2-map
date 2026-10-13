// Spike altlıkları: her kaynak tipinden gerçek bir örnek (Faz 1.2 doğrulaması).
// "altlik" grubundan aynı anda yalnız biri açık (exclusiveGroup); ortofoto bindirmesi bağımsız.

import { BASEMAP_SOURCE, type Basemap } from '@c2/map-core';

export const BASEMAP_GROUP = 'altlik';
export const ORTOFOTO_ID = 'ortofoto';

/** Georeferanslı görüntü örneği: tarayıcıda üretilen saydam ızgara (dış servise bağımlı değil). */
function gridImage(): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(255, 196, 0, 0.18)';
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = 'rgba(255, 196, 0, 0.9)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 512; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255, 196, 0, 1)';
  ctx.font = 'bold 40px system-ui';
  ctx.fillText('ORTOFOTO (IMAGE)', 70, 270);
  return canvas.toDataURL();
}

const group = { exclusiveGroup: BASEMAP_GROUP, order: 0, opacity: 0.6 } as const;

export const BASEMAPS: Basemap[] = [
  {
    id: 'osm',
    name: 'OpenStreetMap (XYZ)',
    source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 },
    attribution: '© OpenStreetMap contributors',
    visible: true,
    ...group,
  },
  {
    id: 'topo',
    name: 'OpenTopoMap (XYZ)',
    source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', maxZoom: 17 },
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
    visible: false,
    ...group,
  },
  {
    id: 'uydu',
    name: 'Esri World Imagery (XYZ)',
    source: {
      type: BASEMAP_SOURCE.XYZ,
      urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    },
    attribution: 'Tiles © Esri',
    visible: false,
    ...group,
  },
  {
    id: 'wms',
    name: 'terrestris OSM (WMS)',
    source: { type: BASEMAP_SOURCE.WMS, url: 'https://ows.terrestris.de/osm/service', layers: 'OSM-WMS' },
    attribution: '© terrestris, © OpenStreetMap contributors',
    visible: false,
    ...group,
  },
  {
    id: ORTOFOTO_ID,
    name: 'Ortofoto bindirmesi (IMAGE)',
    // Ankara çevresi; köşeler: sol üst, sağ üst, sağ alt, sol alt
    source: { type: BASEMAP_SOURCE.IMAGE, url: gridImage(), corners: [[32.3, 40.3], [33.4, 40.3], [33.4, 39.5], [32.3, 39.5]] },
    visible: false,
    opacity: 1,
    order: 10, // grup altlıklarının üstünde
  },
];
