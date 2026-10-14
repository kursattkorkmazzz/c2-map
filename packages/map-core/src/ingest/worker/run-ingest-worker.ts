// ── Worker tarafı: runIngestWorker ───────────────────────────────
// Tasarım: plan/design/03-store.md#ingest-worker-faz-36
//
// Uygulamanın Worker dosyasında çağrılır (normalize fonksiyonları Worker'da yaşar; fonksiyon
// postMessage ile taşınamaz):
//
//   // ingest.worker.ts
//   import { runIngestWorker } from '@c2/map-core';
//   runIngestWorker({
//     streams: { birlikler: { format: 'full', normalize: (m) => ({ id: m.uid, kind: 'milsym', … }) } },
//     socket: {
//       url: 'wss://…/units',
//       onOpen: (ws, api) => ws.send(JSON.stringify({ subscribe: 'units' })),
//       onMessage: (data, api) => { const m = JSON.parse(data); api.update('birlikler', m.items); },
//     },
//   });
//
// Kütüphane Worker'ı kendisi oluşturmaz (paketleyiciye özel): uygulama
// `new Worker(new URL('./ingest.worker.ts', import.meta.url), { type: 'module' })` yapar.

import type { StreamFormat } from "../layer-stream";
import { IngestEngine, type IngestEngineOptions } from "./ingest-engine";
import type { IngestInbound, IngestOutbound, MessageEndpoint, SocketStatus } from "./protocol";

/** Worker içindeki kodun (soket / simülatör / komut) akışlara yazdığı yüz. */
export type IngestApi = {
  update(layerId: string, messages: readonly unknown[], format?: StreamFormat): void;
  snapshot(layerId: string, messages: readonly unknown[]): void;
  remove(layerId: string, ids: readonly string[]): void;
};

/** WebSocket'in kullanılan yüzü. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type IngestSocketConfig = {
  url: string;
  protocols?: string | string[];
  /** Bağlandı / yeniden bağlandı: abonelik, snapshot isteği vb. */
  onOpen?(socket: WebSocketLike, api: IngestApi): void;
  /** Her soket mesajı (genelde JSON metni): parse + `api.update / snapshot / remove`. */
  onMessage(data: unknown, api: IngestApi): void;
  /** Yeniden bağlanma beklemesi: her denemede ikiye katlanır. Varsayılan 500 ms – 15 sn. */
  reconnect?: { minMs?: number; maxMs?: number };
  /** Test için WebSocket sınıfı. Varsayılan: global `WebSocket`. */
  WebSocket?: new (url: string, protocols?: string | string[]) => WebSocketLike;
};

export type IngestWorkerConfig = IngestEngineOptions & {
  /** Worker kendi soketini açar (isteğe bağlı; yoksa veri `start` / ana thread `push` ile gelir). */
  socket?: IngestSocketConfig;
  /** Worker içinde ek kurulum (ör. simülatör). Dönen fonksiyon `stop`'ta çağrılır. */
  start?(api: IngestApi): void | (() => void);
  /** Ana thread'den `command` mesajı. */
  onCommand?(command: unknown, api: IngestApi): void;
  /** Test için zamanlayıcı. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

export type IngestWorkerHandle = {
  readonly engine: IngestEngine;
  readonly api: IngestApi;
  stop(): void;
};

export function runIngestWorker(
  config: IngestWorkerConfig,
  endpoint: MessageEndpoint<IngestInbound, IngestOutbound> = globalThis as unknown as MessageEndpoint<IngestInbound, IngestOutbound>,
): IngestWorkerHandle {
  const engine = new IngestEngine(config);
  const post = (message: IngestOutbound) => endpoint.postMessage(message);
  const api: IngestApi = {
    update: (layerId, messages, format) => engine.update(layerId, messages, format),
    snapshot: (layerId, messages) => engine.snapshot(layerId, messages),
    remove: (layerId, ids) => engine.remove(layerId, ids),
  };
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const socket = config.socket ? connectSocket(config, config.socket, api, post, guard) : null;
  let stopStart: void | (() => void);
  guard(() => (stopStart = config.start?.(api)));

  const onMessage = (event: { data: IngestInbound }) => {
    const message = event.data;
    switch (message.type) {
      case "pull": {
        const packet = engine.drain();
        post({ type: "packet", packet: packet && message.transport === "json" ? JSON.stringify(packet) : packet, stats: engine.stats });
        break;
      }
      case "push":
        guard(() => engine.update(message.layerId, message.messages, message.format));
        break;
      case "snapshot":
        guard(() => engine.snapshot(message.layerId, message.messages));
        break;
      case "remove":
        guard(() => engine.remove(message.layerId, message.ids));
        break;
      case "command":
        guard(() => config.onCommand?.(message.command, api));
        break;
      case "stop":
        handle.stop();
        break;
    }
  };
  endpoint.addEventListener("message", onMessage);

  const handle: IngestWorkerHandle = {
    engine,
    api,
    stop() {
      endpoint.removeEventListener("message", onMessage);
      socket?.stop();
      if (typeof stopStart === "function") stopStart();
    },
  };
  return handle;
}

/** Soket + artan beklemeyle yeniden bağlanma. */
function connectSocket(
  config: IngestWorkerConfig,
  options: IngestSocketConfig,
  api: IngestApi,
  post: (message: IngestOutbound) => void,
  guard: (fn: () => void) => void,
): { stop(): void } {
  const Socket = options.WebSocket ?? (globalThis as unknown as { WebSocket: IngestSocketConfig["WebSocket"] }).WebSocket;
  if (!Socket) throw new Error("Ingest Worker: WebSocket yok (ortam desteklemiyor ya da `socket.WebSocket` verilmeli).");
  const schedule = config.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel = config.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const minMs = options.reconnect?.minMs ?? 500;
  const maxMs = options.reconnect?.maxMs ?? 15_000;

  let ws: WebSocketLike | null = null;
  let attempt = 0;
  let timer: unknown = null;
  let stopped = false;
  const status = (s: SocketStatus) => post({ type: "status", status: s, attempt });

  const open = () => {
    if (stopped) return;
    status("connecting");
    const current = new Socket(options.url, options.protocols);
    ws = current;
    current.onopen = () => {
      attempt = 0;
      status("open");
      guard(() => options.onOpen?.(current, api));
    };
    current.onmessage = (event) => guard(() => options.onMessage(event.data, api));
    current.onerror = () => {}; // ardından onclose gelir
    current.onclose = () => {
      if (ws !== current) return;
      ws = null;
      status("closed");
      if (stopped) return;
      const delay = Math.min(maxMs, minMs * 2 ** attempt);
      attempt++;
      timer = schedule(open, delay);
    };
  };
  open();

  return {
    stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      const current = ws;
      ws = null;
      current?.close();
    },
  };
}
