// ── Sahte İHA backend'i (3B) ─────────────────────────────────────
// react sayfasındaki uav-sim'in 3B hâli: irtifa DENİZ SEVİYESİNDEN (MSL, gerçek telemetri gibi)
// ve hem geometride (z) hem props'ta gelir. Her İHA bir yörüngede uçar, tırmanıp alçalır,
// kamerası sağa-sola tarar. Sayı ayarlanabilir. Mesajlar TAM nesne (en kötü durum, karar #10).
// React'ten geçmez: createLayerStream → store.

import {
  ALTITUDE_REF,
  createLayerStream,
  destination,
  GEOMETRY_KIND,
  STREAM_FORMAT,
  type MapStore,
  type StreamItem,
  type UavProps,
} from '@c2/map-core';

export const UAV_LAYER = 'ihalar';

const CALLSIGNS = ['ANKA', 'AKINCI', 'TB2', 'TB3', 'AKSUNGUR', 'KIZILELMA'];

type Orbit = {
  id: string;
  callsign: string;
  center: [number, number];
  radiusM: number;
  speedMs: number;
  /** Ortalama irtifa (MSL, m) */
  baseAltM: number;
  /** Tırmanma / alçalma genliği (m) */
  climbM: number;
  phase: number;
  dir: 1 | -1;
};

/** Tekrarlanabilir rastgele (sayfa yenilense de aynı İHA'lar). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function orbits(count: number): Orbit[] {
  const rand = seeded(42);
  return Array.from({ length: count }, (_, i) => ({
    id: `iha-${i + 1}`,
    callsign: `${CALLSIGNS[i % CALLSIGNS.length]}-${i + 1}`,
    center: [32.85 + (rand() - 0.5) * 1.6, 39.9 + (rand() - 0.5) * 1.0],
    radiusM: 4000 + rand() * 9000,
    speedMs: 40 + rand() * 50,
    baseAltM: 2200 + rand() * 3500,
    climbM: 200 + rand() * 600,
    phase: rand() * 6.28,
    dir: rand() < 0.5 ? 1 : -1,
  }));
}

function message(orbit: Orbit, t: number): StreamItem {
  const angularDeg = ((orbit.speedMs / orbit.radiusM) * t * 180) / Math.PI;
  const theta = orbit.phase * 57.3 + orbit.dir * angularDeg;
  const [lon, lat] = destination(orbit.center, theta, orbit.radiusM);
  const heading = (((theta + orbit.dir * 90) % 360) + 360) % 360;
  const altitude = orbit.baseAltM + orbit.climbM * Math.sin(t / 25 + orbit.phase);
  const props: UavProps = {
    callsign: orbit.callsign,
    headingDeg: heading,
    altitudeM: altitude,
    altitudeRef: ALTITUDE_REF.SEA,
    sensor: {
      panDeg: 70 * Math.sin(t / 6 + orbit.phase),
      tiltDeg: 40 + 15 * Math.sin(t / 9 + orbit.phase),
      hfovDeg: 18,
      vfovDeg: 12,
      maxRangeM: 25_000,
    },
  };
  // Yükseklik geometride de: [boylam, enlem, irtifa (MSL)]
  return { id: orbit.id, kind: 'uav', geometry: { kind: GEOMETRY_KIND.POINT, coord: [lon, lat, altitude] }, props };
}

/** Akışı başlatır; durdurma fonksiyonu döner. */
export function startUavFeed(store: MapStore, options: { count: number; hz: number }): () => void {
  const stream = createLayerStream<StreamItem>(store, { layerId: UAV_LAYER, format: STREAM_FORMAT.FULL, normalize: (m) => m });
  const list = orbits(options.count);
  const start = performance.now();
  // Önceki çalıştırmadan kalan (sayı azaldıysa fazla) İHA'lar: snapshot katmanı baştan kurar.
  stream.snapshot(list.map((o) => message(o, 0)));
  const tick = () => stream.update(list.map((o) => message(o, (performance.now() - start) / 1000)));
  const timer = setInterval(tick, 1000 / options.hz);
  return () => clearInterval(timer);
}

/** İHA'ların görüldüğü 3B kamera. */
export const UAV_VIEW = { center: [32.85, 39.75] as [number, number], zoom: 9.2, pitchDeg: 62, bearingDeg: -15 };
