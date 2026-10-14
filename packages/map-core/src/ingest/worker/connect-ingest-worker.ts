// ── Ana thread tarafı: connectIngestWorker ───────────────────────
// Tasarım: plan/design/03-store.md#ingest-worker-faz-36
//
// Kare başına en fazla bir `pull`; gelen paket TEK transaction'da store'a yazılır. Bir paket
// uygulanmadan yenisi istenmez (geri basınç): ana thread yavaşlarsa veriler Worker'da birleşir.
//
//   const worker = new Worker(new URL('./ingest.worker.ts', import.meta.url), { type: 'module' });
//   const ingest = connectIngestWorker(store, worker);
//   …  ingest.stop();

import type { MapStore } from "../../store/map-store";
import type { StreamFormat } from "../layer-stream";
import type { IngestEngineStats, IngestPacket } from "./ingest-engine";
import type { IngestInbound, IngestOutbound, MessageEndpoint, PacketTransport, SocketStatus } from "./protocol";

export type IngestConnectionStats = {
  /** Uygulanan paket sayısı. */
  readonly packets: number;
  /** Uygulanan öğe sayısı (snapshot + ekleme + patch + silme). */
  readonly items: number;
  /** Paket uygulamada geçen toplam süre (ms, ana thread). */
  readonly applyMs: number;
  /** Worker'ın son bildirdiği sayaçlar. */
  readonly worker: IngestEngineStats | null;
  readonly socket: SocketStatus | null;
};

export type IngestConnectionOptions = {
  /** Kare zamanlayıcı (varsayılan `requestAnimationFrame`). */
  requestFrame?: (cb: () => void) => unknown;
  cancelFrame?: (handle: unknown) => void;
  now?: () => number;
  /** Her uygulanan paketten sonra (ölçüm paneli için). */
  onPacket?(info: { items: number; ms: number }): void;
  onStatus?(status: SocketStatus, attempt: number): void;
  onError?(message: string): void;
  /**
   * Paket taşıma biçimi. Varsayılan `json`: ölçümde structured clone'un ana thread'de açılması
   * JSON.parse'tan belirgin şekilde pahalıydı (50k/sn: ~246 → ~145 ms/sn). plan/spike/findings.md
   */
  transport?: PacketTransport;
};

export type IngestConnection = {
  readonly stats: IngestConnectionStats;
  push(layerId: string, messages: unknown[], format?: StreamFormat): void;
  snapshot(layerId: string, messages: unknown[]): void;
  remove(layerId: string, ids: string[]): void;
  command(command: unknown): void;
  /** Döngüyü durdurur; `terminateWorker` ise Worker'a `stop` gönderir. */
  stop(options?: { terminateWorker?: boolean }): void;
};

/** Paketi tek transaction'da uygular. Uygulanan öğe sayısını döner. */
export function applyIngestPacket(store: MapStore, packet: IngestPacket): number {
  let items = 0;
  store.transaction((tx) => {
    for (const s of packet.streams) {
      if (s.snapshot) {
        tx.replaceLayerContents(s.layerId, s.snapshot);
        items += s.snapshot.length;
      }
      if (s.removes.length) tx.removeFeatures(s.removes);
      if (s.upserts.length) tx.upsertFeatures(s.upserts);
      if (s.patches.length) tx.patchFeatures(s.patches);
      items += s.removes.length + s.upserts.length + s.patches.length;
    }
  });
  return items;
}

export function connectIngestWorker(
  store: MapStore,
  worker: MessageEndpoint<IngestOutbound, IngestInbound>,
  options: IngestConnectionOptions = {},
): IngestConnection {
  const requestFrame =
    options.requestFrame ?? (typeof requestAnimationFrame === "function" ? (cb: () => void) => requestAnimationFrame(cb) : (cb: () => void) => setTimeout(cb, 16));
  const cancelFrame =
    options.cancelFrame ??
    (typeof cancelAnimationFrame === "function" ? (h: unknown) => cancelAnimationFrame(h as number) : (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));

  const stats = { packets: 0, items: 0, applyMs: 0, worker: null as IngestEngineStats | null, socket: null as SocketStatus | null };
  let waiting = false;
  let stopped = false;
  let frame: unknown = null;

  const onMessage = (event: { data: IngestOutbound }) => {
    // Süre `event.data`'dan ÖNCE başlar: tarayıcı mesajı ilk erişimde kopyadan açar (structured
    // clone) ve bu ana thread işidir; ölçüme girmezse Worker'ın kazancı olduğundan büyük görünür.
    const t0 = now();
    const message = event.data;
    if (message.type === "packet") {
      waiting = false;
      stats.worker = message.stats;
      if (!message.packet || stopped) return;
      const packet = typeof message.packet === "string" ? (JSON.parse(message.packet) as IngestPacket) : message.packet;
      const items = applyIngestPacket(store, packet);
      const ms = now() - t0;
      stats.packets++;
      stats.items += items;
      stats.applyMs += ms;
      options.onPacket?.({ items, ms });
    } else if (message.type === "status") {
      stats.socket = message.status;
      options.onStatus?.(message.status, message.attempt);
    } else if (message.type === "error") {
      options.onError?.(message.message);
    }
  };
  worker.addEventListener("message", onMessage);

  const tick = () => {
    if (stopped) return;
    if (!waiting) {
      waiting = true;
      worker.postMessage({ type: "pull", transport: options.transport ?? "json" });
    }
    frame = requestFrame(tick);
  };
  frame = requestFrame(tick);

  return {
    get stats() {
      return { ...stats };
    },
    push: (layerId, messages, format) => worker.postMessage({ type: "push", layerId, messages, format }),
    snapshot: (layerId, messages) => worker.postMessage({ type: "snapshot", layerId, messages }),
    remove: (layerId, ids) => worker.postMessage({ type: "remove", layerId, ids }),
    command: (command) => worker.postMessage({ type: "command", command }),
    stop(stopOptions) {
      stopped = true;
      if (frame !== null) cancelFrame(frame);
      worker.removeEventListener("message", onMessage);
      if (stopOptions?.terminateWorker) worker.postMessage({ type: "stop" });
    },
  };
}
