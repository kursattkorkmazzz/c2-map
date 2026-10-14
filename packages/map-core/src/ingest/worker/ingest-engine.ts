// ── IngestEngine: Worker içindeki birleştirici (saf, DOM / Worker bilmez) ──
// Tasarım: plan/design/03-store.md#ingest-worker-faz-36
//
//   ham mesaj → normalize → (tam nesne ise) son hâlle karşılaştır → patch
//   aynı unsurun ara mesajları birleşir → ana thread istediğinde TEK paket (`drain`)
//
// Ana thread'in işi paketi tek transaction'da uygulamak olur: JSON parse, normalize ve tam nesne
// karşılaştırması (ölçüm: tam nesne ≈ 2× kısmi patch) ana thread'den çıkar. Bellek O(unsur sayısı):
// ana thread yavaşsa ara mesajlar birleşir, kuyruk büyümez.

import type { Feature } from "../../model/feature";
import { mergeFeaturePatch, type FeaturePatch } from "../../store/diff";
import { STREAM_FORMAT, type FullFeature, type StreamFormat, type StreamItem } from "../layer-stream";
import { canMergePatches, featureDelta, mergePatches } from "./feature-delta";

export type IngestStreamConfig<Raw = unknown> = {
  /** Varsayılan mesaj formatı (varsayılan `full`, en kötü durum). */
  format?: StreamFormat;
  /** Ham mesaj → model (createLayerStream ile aynı sözleşme). `null` → atla. */
  normalize?: (raw: Raw) => StreamItem | null;
};

export type IngestEngineOptions = {
  /** Katman id → akış ayarı. */
  streams: Record<string, IngestStreamConfig<any>>;
  /**
   * Tam nesne akışında içeriği değişmeyen unsur için bu sürede bir "canlı" (`{ id }`) patch'i gönderilir:
   * store unsurun tazelik zamanını (`getUpdatedAt`, bayatlık) güncel tutar. Varsayılan 5000 ms; 0 → hiç.
   */
  touchIntervalMs?: number;
  now?: () => number;
};

/** Ana thread'e giden paket: katman başına, uygulama sırası snapshot → silme → ekleme → patch. */
export type IngestPacket = {
  streams: StreamPacket[];
};

export type StreamPacket = {
  layerId: string;
  /** Yeniden bağlanma: katmanın tamamı (`replaceLayerContents`). Diğerlerinden önce uygulanır. */
  snapshot?: Feature[];
  removes: string[];
  /** Ana thread'in bilmediği veya kind'ı değişen unsurlar (tam nesne). */
  upserts: Feature[];
  patches: FeaturePatch[];
};

export type IngestEngineStats = {
  readonly received: number;
  readonly skipped: number;
  readonly wrongLayer: number;
  /** Tam nesne akışında içeriği aynı olduğu için gönderilmeyen mesajlar. */
  readonly unchanged: number;
  readonly sentFull: number;
  readonly sentPatches: number;
  readonly sentTouches: number;
  readonly packets: number;
};

/**
 * Bekleyen işlem (unsur başına, paket penceresi içinde):
 *   dirty   — tam nesne akışı: pencere başındaki hâl (`base`, ana thread'in sahip olduğu) saklanır;
 *             paket çıkarken `base` → son hâl farkı BİR KEZ hesaplanır (ara mesajlar kayıpsız birleşir)
 *   touch   — tam nesne akışı: içerik aynı, yalnız canlılık
 *   upsert  — patch akışında tam nesne (patch'ler üstüne birleşir)
 *   patches — patch akışı: sırayla uygulanacak patch'ler (kayıpsız birleşebilenler birleşik)
 *   remove
 */
type Op =
  | { type: "dirty"; base: Feature | undefined }
  | { type: "touch"; rev: number | undefined }
  | { type: "upsert"; feature: Feature }
  | { type: "patches"; list: FeaturePatch[] }
  | { type: "remove" };

type StreamState = {
  layerId: string;
  format: StreamFormat;
  normalize: (raw: unknown) => StreamItem | null;
  /** Tam nesne akışı: ana thread'in (paketler uygulandıktan sonra) sahip olacağı son hâl. */
  known: Map<string, Feature>;
  /** Son gönderim zamanı (canlılık patch'i için). */
  sentAt: Map<string, number>;
  snapshot: Feature[] | null;
  ops: Map<string, Op>;
};

export class IngestEngine {
  private readonly streams = new Map<string, StreamState>();
  private readonly touchInterval: number;
  private readonly now: () => number;
  private readonly counters = { received: 0, skipped: 0, wrongLayer: 0, unchanged: 0, sentFull: 0, sentPatches: 0, sentTouches: 0, packets: 0 };

  constructor(options: IngestEngineOptions) {
    this.touchInterval = options.touchIntervalMs ?? 5000;
    this.now = options.now ?? (() => Date.now());
    for (const [layerId, config] of Object.entries(options.streams)) {
      this.streams.set(layerId, {
        layerId,
        format: config.format ?? STREAM_FORMAT.FULL,
        normalize: (config.normalize as (raw: unknown) => StreamItem | null) ?? ((raw) => raw as StreamItem),
        known: new Map(),
        sentAt: new Map(),
        snapshot: null,
        ops: new Map(),
      });
    }
  }

  get stats(): IngestEngineStats {
    return { ...this.counters };
  }

  /** Bir paket ham mesaj (sıra korunur). */
  update(layerId: string, messages: readonly unknown[], format?: StreamFormat): void {
    const stream = this.require(layerId);
    const asPatch = (format ?? stream.format) === STREAM_FORMAT.PATCH;
    const now = this.now();
    for (const raw of messages) {
      this.counters.received++;
      const item = stream.normalize(raw);
      if (item === null) {
        this.counters.skipped++;
        continue;
      }
      if ("removed" in item && item.removed === true) {
        stream.known.delete(item.id);
        stream.sentAt.delete(item.id);
        stream.ops.set(item.id, { type: "remove" });
        continue;
      }
      if (asPatch) {
        this.queuePatch(stream, item as FeaturePatch);
        continue;
      }
      const feature = this.toFeature(stream, item as FullFeature);
      if (feature) this.ingestFull(stream, feature, now);
    }
  }

  /** Yeniden bağlanma: katmanın tamamı. Bekleyen işlemler atılır; son hâl snapshot'tan kurulur. */
  snapshot(layerId: string, messages: readonly unknown[]): void {
    const stream = this.require(layerId);
    const features: Feature[] = [];
    const now = this.now();
    for (const raw of messages) {
      this.counters.received++;
      const item = stream.normalize(raw);
      if (item === null || ("removed" in item && item.removed === true)) {
        this.counters.skipped++;
        continue;
      }
      const feature = this.toFeature(stream, item as FullFeature);
      if (feature) features.push(feature);
    }
    stream.snapshot = features;
    stream.ops.clear();
    stream.known = new Map(features.map((f) => [f.id, f]));
    stream.sentAt = new Map(features.map((f) => [f.id, now]));
  }

  remove(layerId: string, ids: readonly string[]): void {
    const stream = this.require(layerId);
    for (const id of ids) {
      stream.known.delete(id);
      stream.sentAt.delete(id);
      stream.ops.set(id, { type: "remove" });
    }
  }

  /** Bekleyen her şey tek pakette; yoksa `null`. */
  drain(): IngestPacket | null {
    const streams: StreamPacket[] = [];
    for (const stream of this.streams.values()) {
      if (!stream.snapshot && stream.ops.size === 0) continue;
      const packet: StreamPacket = { layerId: stream.layerId, removes: [], upserts: [], patches: [] };
      if (stream.snapshot) packet.snapshot = stream.snapshot;
      const now = this.now();
      for (const [id, op] of stream.ops) {
        if (op.type === "remove") packet.removes.push(id);
        else if (op.type === "upsert") packet.upserts.push(op.feature);
        else if (op.type === "patches") packet.patches.push(...op.list);
        else if (op.type === "touch") {
          packet.patches.push(op.rev === undefined ? { id } : { id, rev: op.rev });
          this.counters.sentTouches++;
        } else {
          const final = stream.known.get(id);
          if (!final) continue;
          const delta = op.base ? featureDelta(op.base, final) : ({ type: "full" } as const);
          if (delta.type === "same") continue; // pencerede değişip eski hâline döndü
          if (delta.type === "full") packet.upserts.push(final);
          else packet.patches.push(delta.patch);
          stream.sentAt.set(id, now);
        }
      }
      if (packet.removes.length + packet.upserts.length + packet.patches.length === 0 && !packet.snapshot) {
        stream.ops = new Map();
        continue;
      }
      this.counters.sentFull += packet.upserts.length + (packet.snapshot?.length ?? 0);
      this.counters.sentPatches += packet.patches.length;
      stream.snapshot = null;
      stream.ops = new Map();
      streams.push(packet);
    }
    if (streams.length === 0) return null;
    this.counters.packets++;
    return { streams };
  }

  // ── İç ─────────────────────────────────────────────────────────

  private ingestFull(stream: StreamState, feature: Feature, now: number): void {
    const id = feature.id;
    const prev = stream.known.get(id);
    stream.known.set(id, feature);
    const pending = stream.ops.get(id);

    if (pending?.type === "dirty") return; // taban zaten saklı; fark paket çıkarken
    if (pending?.type === "remove" || !prev) {
      // Yeni unsur ya da pencerede silinip geri gelen: tam nesne
      stream.ops.set(id, { type: "dirty", base: undefined });
      return;
    }
    if (featureDelta(prev, feature).type !== "same") {
      stream.ops.set(id, { type: "dirty", base: prev }); // `prev` = ana thread'in sahip olacağı hâl
      return;
    }
    this.counters.unchanged++;
    // İçerik aynı: yalnız ara sıra "canlı" bildirimi (bayatlık); `rev` de ilerlesin.
    const last = stream.sentAt.get(id) ?? 0;
    if (pending?.type === "touch") pending.rev = feature.rev;
    else if (this.touchInterval > 0 && now - last >= this.touchInterval) {
      stream.ops.set(id, { type: "touch", rev: feature.rev });
      stream.sentAt.set(id, now);
    }
  }

  /** Patch akışı: backend'in patch'i. Kayıpsız birleşebiliyorsa birleşir, değilse sıraya eklenir. */
  private queuePatch(stream: StreamState, patch: FeaturePatch): void {
    const pending = stream.ops.get(patch.id);
    if (!pending) stream.ops.set(patch.id, { type: "patches", list: [patch] });
    else if (pending.type === "patches") {
      const last = pending.list[pending.list.length - 1]!;
      if (canMergePatches(last, patch)) pending.list[pending.list.length - 1] = mergePatches(last, patch);
      else pending.list.push(patch);
    } else if (pending.type === "upsert") pending.feature = mergeFeaturePatch(pending.feature, patch);
    // silinmiş unsura patch: store da yok sayar → at
  }

  private toFeature(stream: StreamState, item: FullFeature): Feature | null {
    if (item.layerId === undefined) return { ...item, layerId: stream.layerId } as Feature;
    if (item.layerId !== stream.layerId) {
      this.counters.wrongLayer++;
      return null;
    }
    return item as Feature;
  }

  private require(layerId: string): StreamState {
    const stream = this.streams.get(layerId);
    if (!stream) throw new Error(`Ingest: tanımsız akış "${layerId}" (streams'e ekleyin).`);
    return stream;
  }
}
