import type { GeoJSONSource } from 'maplibre-gl';
import type { UnitMessage } from './generator';
import { CHANGE, type Unit, type UnitStore } from './store';

type GeoJSONFeatureDiff = NonNullable<Parameters<GeoJSONSource['updateData']>[0]['update']>[number];

// Haritaya veri göndermenin yolları. Spike'ın amacı bunları yan yana ölçmek.
export const RENDER_MODE = {
  /** Her mesaj geldiği anda haritaya tek tek gönder. (Kötü yol) */
  NAIVE: 'naive',
  /** Biriktir, saniyede X kez TÜM veriyi yeniden gönder (setData). */
  BATCH_FULL: 'batch-full',
  /** Biriktir, saniyede X kez YALNIZ değişenleri gönder (updateData). Plandaki yol. */
  BATCH_DIFF: 'batch-diff',
  /** Biriktir, deck.gl ile doğrudan GPU dizilerine yaz (bkz. deck-renderer.ts). */
  DECK: 'deck',
} as const;
export type RenderMode = (typeof RENDER_MODE)[keyof typeof RENDER_MODE];

const toGeometry = (u: { lon: number; lat: number }): GeoJSON.Point => ({
  type: 'Point',
  coordinates: [u.lon, u.lat],
});

// Haritaya yalnız stilin okuduğu alan gider: sembol kodu. Askeri semboller döndürülmez.
const toFeature = (u: Unit): GeoJSON.Feature<GeoJSON.Point> => ({
  type: 'Feature',
  id: u.id,
  geometry: toGeometry(u),
  properties: { icon: u.sidc },
});

export class UnitRenderer {
  constructor(
    private readonly source: GeoJSONSource,
    private readonly store: UnitStore,
  ) {}

  /** Tüm veriyi baştan yükler (ilk açılış / birlik sayısı değişimi). */
  loadAll(): void {
    this.source.setData({ type: 'FeatureCollection', features: this.store.all().map(toFeature) });
  }

  /** NAIVE mod: tek mesaj → tek updateData çağrısı. */
  applyMessage(msg: UnitMessage, mask: number): void {
    if (mask === 0) return;
    const u = this.store.get(msg.id);
    if (!u) return;
    void this.source.updateData({
      update: [
        {
          id: msg.id,
          newGeometry: toGeometry(u),
          addOrUpdateProperties: mask & CHANGE.PROPS ? [{ key: 'icon', value: u.sidc }] : undefined,
        },
      ],
    });
  }

  /** Biriken değişiklikleri tek seferde haritaya gönderir. Gönderilen unsur sayısını döner. */
  flush(mode: RenderMode): number {
    const changes = this.store.drainChanges();
    if (changes.size === 0) return 0;

    if (mode === RENDER_MODE.BATCH_FULL) {
      this.loadAll();
      return this.store.size;
    }

    // BATCH_DIFF: yalnız değişen unsurlar, yalnız değişen alanlar.
    const update: GeoJSONFeatureDiff[] = [];
    for (const [id, mask] of changes) {
      const u = this.store.get(id);
      if (!u) continue;
      update.push({
        id,
        newGeometry: mask & CHANGE.GEOMETRY ? toGeometry(u) : undefined,
        addOrUpdateProperties: mask & CHANGE.PROPS ? [{ key: 'icon', value: u.sidc }] : undefined,
      });
    }
    void this.source.updateData({ update });
    return update.length;
  }

  /** NAIVE modda biriken listeyi boşalt (mesajlar zaten tek tek gönderildi). */
  discardPending(): void {
    this.store.drainChanges();
  }
}
