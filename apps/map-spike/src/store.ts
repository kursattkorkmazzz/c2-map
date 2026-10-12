import type { UnitMessage } from './generator';

// Planın MapStore'unun en sade hali: veriyi tutar ve "son flush'tan beri ne değişti"
// listesini (dirty set) biriktirir. Haritaya hiç dokunmaz.

export const CHANGE = {
  GEOMETRY: 1, // konum / yön
  PROPS: 2, // görünümü etkileyen alanlar (durum → ikon rengi)
} as const;

export type Unit = {
  id: number;
  lon: number;
  lat: number;
  hdg: number;
  status: number;
  updatedAt: number;
};

export class UnitStore {
  private units: Unit[] = [];
  // id → değişen alan maskesi. Aynı id 10 kez gelse de burada tek kayıt olur (coalescing).
  private dirty = new Map<number, number>();

  get size(): number {
    return this.units.length;
  }

  get(id: number): Unit | undefined {
    return this.units[id];
  }

  all(): readonly Unit[] {
    return this.units;
  }

  replaceAll(snapshot: UnitMessage[]): void {
    const now = performance.now();
    this.units = snapshot.map((m) => ({
      id: m.id,
      lon: m.lon,
      lat: m.lat,
      hdg: m.hdg,
      status: m.status ?? 0,
      updatedAt: now,
    }));
    this.dirty.clear();
  }

  /** Bir mesajı uygular. Ucuzdur: yalnız bellekte alan günceller. Değişen alanların maskesini döner. */
  apply(msg: UnitMessage): number {
    const u = this.units[msg.id];
    if (!u) return 0;

    let mask = 0;
    if (u.lon !== msg.lon || u.lat !== msg.lat || u.hdg !== msg.hdg) {
      u.lon = msg.lon;
      u.lat = msg.lat;
      u.hdg = msg.hdg;
      mask |= CHANGE.GEOMETRY;
    }
    if (msg.status !== undefined && msg.status !== u.status) {
      u.status = msg.status;
      mask |= CHANGE.PROPS;
    }
    u.updatedAt = performance.now();

    if (mask !== 0) this.dirty.set(msg.id, (this.dirty.get(msg.id) ?? 0) | mask);
    return mask;
  }

  /** Biriken değişiklikleri al ve listeyi sıfırla. */
  drainChanges(): Map<number, number> {
    const changes = this.dirty;
    this.dirty = new Map();
    return changes;
  }

  get pendingCount(): number {
    return this.dirty.size;
  }
}
