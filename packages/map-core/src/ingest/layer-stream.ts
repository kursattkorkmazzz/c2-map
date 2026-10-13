// ── Katman akışı: backend → store ────────────────────────────────
// Tasarım: plan/design/03-store.md#canlı-veri-girişi-ingest
//
// Bir backend akışı (WS/SSE) bir katmanı besler. Bu yardımcı, ham mesajları store işlemlerine
// çevirir: her paket TEK transaction; yeniden bağlanmada snapshot → `replaceLayerContents`.
//
// Mesaj formatı (karar #10) akış bazında AÇIKÇA verilir — mesajdan tahmin edilmez:
//   full  : her mesaj unsurun tamamı (eksik alan = yok). En kötü durum, varsayılan.
//   patch : yalnız değişen alanlar (eksik alan = değişmedi).
// Tahmin güvenilir değil: `{ id, kind, geometry }` hem tam nesne hem kind değiştiren bir patch
// olabilir; yanlış tahmin tam nesnede alan silmek, patch'te veri kaybı demektir.

import type { Feature } from "../model/feature";
import type { FeaturePatch } from "../store/diff";
import type { MapStore, MapTx } from "../store/map-store";

export const STREAM_FORMAT = {
  FULL: "full",
  PATCH: "patch",
} as const;
export type StreamFormat = (typeof STREAM_FORMAT)[keyof typeof STREAM_FORMAT];

/** Unsurun silindiğini bildiren mesaj (normalize bunu döndürebilir). */
export type FeatureRemoval = { id: string; removed: true };

/** Tam nesnede `layerId` verilmezse akışın katmanı kullanılır. */
export type FullFeature = Omit<Feature, "layerId"> & { layerId?: string };

/** `normalize`'ın döndürebileceği: güncelleme, silme veya `null` (mesajı atla). */
export type StreamItem = FullFeature | FeaturePatch | FeatureRemoval;

export type LayerStreamOptions<Raw> = {
  /** Akışın beslediği katman. */
  layerId: string;
  /** Varsayılan mesaj formatı. Varsayılan: `full` (en kötü durum). */
  format?: StreamFormat;
  /**
   * Ham backend mesajını modele çevirir (alan adları, koordinat sırası, SIDC alanı…).
   * `null` dönerse mesaj atlanır. Verilmezse mesajlar zaten model biçiminde kabul edilir.
   */
  normalize?: (raw: Raw) => StreamItem | null;
};

export type LayerStreamStats = {
  /** Alınan ham mesaj sayısı (snapshot dahil). */
  readonly received: number;
  /** `normalize`'ın `null` döndürdüğü (atlanan) mesajlar. */
  readonly skipped: number;
  /** `layerId`'si başka katmanı gösteren tam nesneler (atlanır). */
  readonly wrongLayer: number;
};

export interface LayerStream<Raw> {
  readonly layerId: string;
  readonly stats: LayerStreamStats;
  /** Bir paket (ör. bir WS mesajı içindeki güncellemeler) → tek transaction. Sıra korunur. */
  update(messages: readonly Raw[], format?: StreamFormat): void;
  /** Id listesiyle silme → tek transaction. */
  remove(ids: readonly string[]): void;
  /** Yeniden bağlanma: katmanın tamamı. Listede olmayanlar silinir; diğer katmanlara dokunulmaz. */
  snapshot(messages: readonly Raw[]): void;
}

export function createLayerStream<Raw = StreamItem>(
  store: MapStore,
  options: LayerStreamOptions<Raw>,
): LayerStream<Raw> {
  const { layerId } = options;
  const defaultFormat = options.format ?? STREAM_FORMAT.FULL;
  const normalize = options.normalize ?? ((raw: Raw) => raw as unknown as StreamItem);
  const stats = { received: 0, skipped: 0, wrongLayer: 0 };

  /** Tam nesneyi katmana bağlar; başka katmanı gösteriyorsa `null`. */
  const toFeature = (item: FullFeature): Feature | null => {
    if (item.layerId === undefined) return { ...item, layerId };
    if (item.layerId !== layerId) {
      stats.wrongLayer++;
      return null;
    }
    return item as Feature;
  };

  return {
    layerId,

    get stats(): LayerStreamStats {
      return { ...stats };
    },

    update(messages, format = defaultFormat) {
      store.transaction((tx) => {
        // Ardışık aynı türden öğeler tek çağrıda gruplanır; sıra korunur.
        let kind: GroupKind | null = null;
        let group: unknown[] = [];
        const flush = () => {
          if (group.length > 0) apply(tx, kind!, group);
          group = [];
        };

        for (const raw of messages) {
          stats.received++;
          const item = normalize(raw);
          if (item === null) {
            stats.skipped++;
            continue;
          }

          let next: GroupKind;
          let value: unknown;
          if ("removed" in item && item.removed === true) {
            next = "remove";
            value = item.id;
          } else if (format === STREAM_FORMAT.PATCH) {
            next = "patch";
            value = item;
          } else {
            const feature = toFeature(item as FullFeature);
            if (!feature) continue;
            next = "upsert";
            value = feature;
          }

          if (next !== kind) {
            flush();
            kind = next;
          }
          group.push(value);
        }
        flush();
      });
    },

    remove(ids) {
      store.transaction((tx) => tx.removeFeatures(ids));
    },

    snapshot(messages) {
      const features: Feature[] = [];
      for (const raw of messages) {
        stats.received++;
        const item = normalize(raw);
        if (item === null || ("removed" in item && item.removed === true)) {
          stats.skipped++;
          continue;
        }
        const feature = toFeature(item as FullFeature);
        if (feature) features.push(feature);
      }
      store.transaction((tx) => tx.replaceLayerContents(layerId, features));
    },
  };
}

type GroupKind = "upsert" | "patch" | "remove";

function apply(tx: MapTx, kind: GroupKind, group: unknown[]): void {
  if (kind === "upsert") tx.upsertFeatures(group as Feature[]);
  else if (kind === "patch") tx.patchFeatures(group as FeaturePatch[]);
  else tx.removeFeatures(group as string[]);
}
