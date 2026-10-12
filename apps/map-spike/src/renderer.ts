import type { GeoJSONSource } from 'maplibre-gl';

type GeoJSONFeatureDiff = NonNullable<Parameters<GeoJSONSource['updateData']>[0]['update']>[number];
import type { UnitMessage } from './generator';
import { iconName } from './map';
import { CHANGE, type Unit, type UnitStore } from './store';

// Haritaya veri göndermenin üç yolu. Spike'ın amacı bunları yan yana ölçmek.
export const RENDER_MODE = {
  /** Her mesaj geldiği anda haritaya tek tek gönder. (Kötü yol) */
  NAIVE: 'naive',
  /** Biriktir, saniyede X kez TÜM veriyi yeniden gönder (setData). */
  BATCH_FULL: 'batch-full',
  /** Biriktir, saniyede X kez YALNIZ değişenleri gönder (updateData). Plandaki yol. */
  BATCH_DIFF: 'batch-diff',
} as const;
export type RenderMode = (typeof RENDER_MODE)[keyof typeof RENDER_MODE];

const toGeometry = (u: { lon: number; lat: number }): GeoJSON.Point => ({
  type: 'Point',
  coordinates: [u.lon, u.lat],
});

const toFeature = (u: Unit): GeoJSON.Feature<GeoJSON.Point> => ({
  type: 'Feature',
  id: u.id,
  geometry: toGeometry(u),
  properties: { icon: iconName(u.status), hdg: u.hdg },
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
    const props: { key: string; value: unknown }[] = [{ key: 'hdg', value: msg.hdg }];
    if (mask & CHANGE.PROPS && msg.status !== undefined) {
      props.push({ key: 'icon', value: iconName(msg.status) });
    }
    void this.source.updateData({
      update: [{ id: msg.id, newGeometry: toGeometry(msg), addOrUpdateProperties: props }],
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
      const props: { key: string; value: unknown }[] = [];
      if (mask & CHANGE.GEOMETRY) props.push({ key: 'hdg', value: u.hdg });
      if (mask & CHANGE.PROPS) props.push({ key: 'icon', value: iconName(u.status) });
      update.push({
        id,
        newGeometry: mask & CHANGE.GEOMETRY ? toGeometry(u) : undefined,
        addOrUpdateProperties: props,
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
