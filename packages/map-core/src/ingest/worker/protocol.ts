// ── Ana thread ↔ ingest Worker mesajları ─────────────────────────
// Tasarım: plan/design/03-store.md#ingest-worker-faz-36

import type { StreamFormat } from "../layer-stream";
import type { IngestEngineStats, IngestPacket } from "./ingest-engine";

/** Ana thread → Worker */
export type IngestInbound =
  /**
   * "Hazırım, bekleyeni gönder" — kare başına en fazla bir kez (geri basınç).
   * `transport`: paket nasıl gelsin — `clone` (structured clone, varsayılan) veya `json` (metin).
   */
  | { type: "pull"; transport?: PacketTransport }
  /** Ana thread'den ham mesaj (ör. bağlantı ana thread'deyse). */
  | { type: "push"; layerId: string; messages: unknown[]; format?: StreamFormat }
  | { type: "snapshot"; layerId: string; messages: unknown[] }
  | { type: "remove"; layerId: string; ids: string[] }
  /** Uygulamaya özel komut (`config.onCommand`), ör. abonelik değiştir. */
  | { type: "command"; command: unknown }
  | { type: "stop" };

export type SocketStatus = "connecting" | "open" | "closed";

export type PacketTransport = "clone" | "json";

/** Worker → ana thread */
export type IngestOutbound =
  /** `pull`'un cevabı: bekleyen paket (yoksa `null`). */
  | { type: "packet"; packet: IngestPacket | string | null; stats: IngestEngineStats }
  | { type: "status"; status: SocketStatus; attempt: number }
  | { type: "error"; message: string };

/** Worker / MessagePort'un kullanılan yüzü (test için sahte verilebilir). */
export interface MessageEndpoint<In, Out> {
  postMessage(message: Out): void;
  addEventListener(type: "message", listener: (event: { data: In }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: In }) => void): void;
}
