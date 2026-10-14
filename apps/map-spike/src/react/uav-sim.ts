// ── Sahte İHA backend'i ──────────────────────────────────────────
// Her İHA bir yörüngede uçar; irtifası yavaşça değişir, kamerası (gimbal) sağa-sola tarar ve
// bakış açısı değişir. Mesajlar saniyede `hz` kez, TAM nesne olarak gelir (en kötü durum, karar #10);
// store değişeni kendisi ayıklar. React'ten geçmez: createLayerStream → store.

import { createLayerStream, destination, GEOMETRY_KIND, STREAM_FORMAT, type MapStore, type StreamItem } from '@c2/map-core';
import type { UavProps } from '@c2/map-maplibre';

export const UAV_LAYER = 'ihalar';

type Orbit = {
  id: string;
  callsign: string;
  center: [number, number];
  radiusM: number;
  speedMs: number;
  baseAltM: number;
  phase: number;
  /** +1 saat yönü, -1 tersi */
  dir: 1 | -1;
};

const ORBITS: Orbit[] = [
  { id: 'iha-1', callsign: 'ANKA-1', center: [33.35, 39.75], radiusM: 9000, speedMs: 55, baseAltM: 4200, phase: 0, dir: 1 },
  { id: 'iha-2', callsign: 'AKINCI-2', center: [32.55, 40.05], radiusM: 12000, speedMs: 70, baseAltM: 6000, phase: 2, dir: -1 },
  { id: 'iha-3', callsign: 'TB2-3', center: [33.05, 39.45], radiusM: 6000, speedMs: 40, baseAltM: 3000, phase: 4, dir: 1 },
];

/** Görüntüleme için bir İHA'nın t anındaki tam mesajı. */
function message(orbit: Orbit, t: number): StreamItem {
  const angularDeg = ((orbit.speedMs / orbit.radiusM) * t * 180) / Math.PI;
  const theta = orbit.phase * 57.3 + orbit.dir * angularDeg; // merkezden yön (derece)
  const coord = destination(orbit.center, theta, orbit.radiusM);
  const heading = (((theta + orbit.dir * 90) % 360) + 360) % 360; // yörüngeye teğet
  const props: UavProps = {
    callsign: orbit.callsign,
    headingDeg: heading,
    altitudeM: orbit.baseAltM + 250 * Math.sin(t / 20 + orbit.phase),
    sensor: {
      panDeg: 75 * Math.sin(t / 6 + orbit.phase), // sağa-sola tarama (buruna göre)
      tiltDeg: 42 + 14 * Math.sin(t / 9 + orbit.phase),
      hfovDeg: 18,
      vfovDeg: 12,
      maxRangeM: 25_000,
    },
  };
  return { id: orbit.id, kind: 'uav', geometry: { kind: GEOMETRY_KIND.POINT, coord }, props };
}

/** Akışı başlatır; durdurma fonksiyonu döner. */
export function startUavStream(store: MapStore, hz = 5): () => void {
  const stream = createLayerStream<StreamItem>(store, { layerId: UAV_LAYER, format: STREAM_FORMAT.FULL, normalize: (m) => m });
  const start = performance.now();
  const tick = () => stream.update(ORBITS.map((o) => message(o, (performance.now() - start) / 1000)));
  tick();
  const timer = setInterval(tick, 1000 / hz);
  return () => clearInterval(timer);
}

/** İHA'ların görüldüğü 3B kamera. */
export const UAV_VIEW = { center: [32.95, 39.75] as [number, number], zoom: 9.3, pitchDeg: 58, bearingDeg: -20 };
