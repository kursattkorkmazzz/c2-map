// Sahte backend: N birlik, her biri saniyede `perUnitHz` kez konum mesajı yollar.
// Gerçek hayattaki WebSocket akışını taklit eder: mesajlar küçük paketler halinde gelir.

import { ECHELONS, ENTITIES, IDENTITIES } from './sidc';

export type UnitMessage = {
  id: number;
  lon: number;
  lat: number;
  hdg: number; // derece, kuzeyden saat yönünde
  identity?: number; // IDENTITIES indeksi; yalnız değiştiğinde gelir
  entity?: number; // ENTITIES indeksi; yalnız ilk durumda (snapshot)
  echelon?: number; // ECHELONS indeksi; yalnız ilk durumda (snapshot)
};

type SimUnit = {
  lon: number;
  lat: number;
  hdg: number;
  speedMps: number;
  identity: number;
  entity: number;
  echelon: number;
};

const randInt = (n: number): number => Math.floor(Math.random() * n);

const TICK_MS = 50; // WS "paket" aralığı
const CENTER: readonly [number, number] = [32.85, 39.9];
const SPREAD_DEG = 3;
const M_PER_DEG_LAT = 111_320;
const IDENTITY_CHANGE_PROB = 0.01; // mesajların %1'inde kimlik (→ sembol) değişir

export class UnitGenerator {
  private units: SimUnit[] = [];
  private cursor = 0; // round-robin: sıradaki güncellenecek birlik
  private carry = 0; // kesirli mesaj birikimi
  private timer: ReturnType<typeof setInterval> | undefined;

  perUnitHz = 1;

  constructor(private readonly onMessages: (msgs: UnitMessage[]) => void) {}

  /** Birlikleri sıfırdan üretir ve ilk durumu (snapshot) döner. */
  reset(count: number): UnitMessage[] {
    this.units = Array.from({ length: count }, () => ({
      lon: CENTER[0] + (Math.random() - 0.5) * SPREAD_DEG * 1.4,
      lat: CENTER[1] + (Math.random() - 0.5) * SPREAD_DEG,
      hdg: Math.random() * 360,
      // Hareket gözle görülsün diye hızlandırılmış (200–600 m/s)
      speedMps: 200 + Math.random() * 400,
      identity: randInt(IDENTITIES.length),
      entity: randInt(ENTITIES.length),
      echelon: randInt(ECHELONS.length),
    }));
    this.cursor = 0;
    this.carry = 0;
    return this.units.map((u, id) => ({
      id,
      lon: u.lon,
      lat: u.lat,
      hdg: u.hdg,
      identity: u.identity,
      entity: u.entity,
      echelon: u.echelon,
    }));
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    const n = this.units.length;
    if (n === 0) return;

    this.carry += (n * this.perUnitHz * TICK_MS) / 1000;
    const count = Math.floor(this.carry);
    this.carry -= count;

    const dtSec = 1 / this.perUnitHz; // her birlik son mesajından bu yana bu kadar ilerledi
    const msgs: UnitMessage[] = new Array(count);

    for (let i = 0; i < count; i++) {
      const id = this.cursor;
      this.cursor = (this.cursor + 1) % n;
      const u = this.units[id]!;

      u.hdg = (u.hdg + (Math.random() - 0.5) * 20 + 360) % 360;
      const rad = (u.hdg * Math.PI) / 180;
      const dist = u.speedMps * dtSec;
      u.lat += (Math.cos(rad) * dist) / M_PER_DEG_LAT;
      u.lon += (Math.sin(rad) * dist) / (M_PER_DEG_LAT * Math.cos((u.lat * Math.PI) / 180));

      // Alanın dışına çıkanı geri döndür
      if (Math.abs(u.lon - CENTER[0]) > SPREAD_DEG || Math.abs(u.lat - CENTER[1]) > SPREAD_DEG * 0.7) {
        u.hdg = (u.hdg + 180) % 360;
      }

      const msg: UnitMessage = { id, lon: u.lon, lat: u.lat, hdg: u.hdg };
      if (Math.random() < IDENTITY_CHANGE_PROB) {
        u.identity = (u.identity + 1) % IDENTITIES.length;
        msg.identity = u.identity;
      }
      msgs[i] = msg;
    }

    this.onMessages(msgs);
  }
}
