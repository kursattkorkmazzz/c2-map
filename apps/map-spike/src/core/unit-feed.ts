// Üretecin "backend mesajı" → model çevirisi. Hem ana thread'de (ingest=main) hem Worker'da
// (ingest=worker) aynı kod çalışır: ölçüm farkı yalnız işin NEREDE yapıldığından gelir.
//   full  : her mesaj birliğin TAMAMI (en kötü durum; props/meta/style her seferinde yeni nesne)
//   patch : yalnız değişen alanlar (konum + varsa yeni sembol)

import { GEOMETRY_KIND, STREAM_FORMAT, type Feature, type FeaturePatch, type StreamFormat, type StreamItem } from '@c2/map-core';
import type { UnitMessage } from '../generator';
import { buildSidc } from '../sidc';

export const UNIT_LAYER = 'birlikler';

/**
 * Gerçek backend'lerdeki kalabalık JSON'u taklit eder (`?payload=verbose`): haritanın kullanmadığı
 * telemetri + metin. Ana thread ingest'inde hepsi parse edilir; Worker'da ayıklanıp gönderilmez.
 */
export function toWire(msgs: readonly UnitMessage[], verbose: boolean): string {
  if (!verbose) return JSON.stringify(msgs);
  return JSON.stringify(
    msgs.map((m) => ({
      ...m,
      telemetry: { fuel: 72.5, speedKmh: 41.2, altM: 812, rpm: 2100, temp: 81.3, battery: 0.92, satellites: 11, hdop: 0.9, vdop: 1.2, pdop: 1.4 },
      status: { readiness: 'C1', comms: 'ok', ammo: [120, 40, 6], crew: 4, lastContact: '2026-10-14T21:00:00Z' },
      remarks: 'Birlik görev bölgesinde; ikmal noktasına yaklaşıyor. Muhabere normal, keşif raporu bekleniyor.',
      source: { system: 'TAK-GW', node: 'n-17', seq: m.id, schema: 'unit.v3' },
    })),
  );
}

const unitId = (n: number) => `u${n}`;

export class UnitFeed {
  entityOf: number[] = [];
  echelonOf: number[] = [];
  identityOf: number[] = [];

  constructor(public format: StreamFormat) {}

  /** Snapshot ile birlik kimliklerini kurar; katmanın tam listesini döner. */
  reset(snapshot: readonly UnitMessage[]): Feature[] {
    this.entityOf = snapshot.map((m) => m.entity ?? 0);
    this.echelonOf = snapshot.map((m) => m.echelon ?? 0);
    this.identityOf = snapshot.map((m) => m.identity ?? 0);
    return snapshot.map((m) => ({ ...(this.full(m) as Feature), layerId: UNIT_LAYER }));
  }

  full(m: UnitMessage): StreamItem {
    return {
      id: unitId(m.id),
      kind: 'milsym',
      geometry: { kind: GEOMETRY_KIND.POINT, coord: [m.lon, m.lat] },
      props: { sidc: buildSidc(this.identityOf[m.id] ?? 0, this.entityOf[m.id] ?? 0, this.echelonOf[m.id] ?? 0) },
      style: { size: 24 },
      meta: { hdg: m.hdg },
    };
  }

  normalize = (m: UnitMessage): StreamItem => {
    if (m.identity !== undefined) this.identityOf[m.id] = m.identity;
    if (this.format === STREAM_FORMAT.FULL) return this.full(m);
    const patch: FeaturePatch = {
      id: unitId(m.id),
      geometry: { kind: GEOMETRY_KIND.POINT, coord: [m.lon, m.lat] },
      meta: { hdg: m.hdg },
    };
    if (m.identity !== undefined) {
      patch.props = { sidc: buildSidc(m.identity, this.entityOf[m.id] ?? 0, this.echelonOf[m.id] ?? 0) };
    }
    return patch;
  };
}
