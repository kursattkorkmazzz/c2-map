// ── Kümeleme: ClusterStage (sunum aşaması) ────────────────────────
// Tasarım: plan/design/04-sync-and-rendering.md#kümeleme-faz-42
//
//   MapStore → MapSync → RenderBatch → [ClusterStage] → adapter.applyBatch()
//
// Store'a dokunmaz; MapSync'in batch'ini dönüştürür: aynı hücreye düşen noktaları gizler, yerlerine
// sentetik bir küme unsuru (`cluster:…`, kind `cluster`) koyar. Motor bilmez: küme normal bir
// `RenderFeature` olarak akar; her adapter `cluster` kind'ını kendi renderer'ıyla çizer.
//
// Neden ızgara (supercluster değil): canlı akışta birlikler sürekli hareket eder. supercluster her
// değişiklikte tüm noktalarla indeksi baştan kurar (50k'da onlarca ms). Izgara artımlıdır: hareket eden
// nokta yalnız eski ve yeni hücresini kirletir; hücre üyeliği değişmedikçe hiçbir unsur gizlenip
// açılmaz. Hücreler dünyaya sabittir (Web Mercator, tam sayı zoom): kaydırma hiçbir şeyi değiştirmez,
// yalnız tam sayı zoom eşiği geçilince baştan kurulur.
//
// Kurallar (04 — sunum aşaması):
//   - küme id'si `cluster:` önekli, store'a yazılmaz; EventRouter katman zincirine kabartmaz
//   - seçim / hover gerçek id'lerde kalır; seçili unsuru içeren küme `selected` durumuyla vurgulanır
//   - gizlenen unsurun görsel durumu saklanır, yeniden göründüğünde gönderilir
//   - sembol-farkında: `clusterKey(f)` farklıysa aynı hücrede ayrı küme (ör. dost / düşman)

import type { Bounds } from "../model/camera";
import type { CameraView } from "../model/camera";
import type { Feature } from "../model/feature";
import type { LngLat } from "../model/geometry";
import { FEATURE_CHANGE } from "../store/change";
import {
  RENDER_CHANGE_ALL,
  type FeatureStatePatch,
  type FeatureVisualState,
  type RenderBatch,
  type RenderFeature,
} from "../adapter/types";
import { CLUSTER_ID_PREFIX } from "../events/event-router";
import type { PresentationContext, PresentationStage } from "../sync/presentation";

/** Küme unsurlarının kind'ı (adapter bu kind için renderer kaydeder). */
export const CLUSTER_KIND = "cluster";

/** Küme unsurunun props'u. */
export type ClusterProps = {
  /** Kümedeki unsur sayısı. */
  count: number;
  /** `clusterKey` sonucu (sembol-farkında kümelemede renk / simge seçimi için). */
  key: string;
};

/** `getCluster` / `CLUSTER_CLICK` olayının verisi. */
export type ClusterInfo = {
  id: string;
  count: number;
  key: string;
  /** Kümedeki gerçek unsur id'leri. */
  ids: readonly string[];
  center: LngLat;
  bounds: Bounds;
  /** Kümenin kurulduğu (tam sayı) zoom. */
  zoom: number;
};

export type ClusterStageOptions = {
  /** Hangi unsurlar kümelenir. Varsayılan: nokta geometrili her unsur. */
  filter?: (feature: Feature) => boolean;
  /** Sembol-farkında kümeleme: anahtarı farklı unsurlar aynı hücrede ayrı kümelenir. Varsayılan: tek küme. */
  clusterKey?: (feature: Feature) => string;
  /** Hücre boyu (CSS px, tam sayı zoom'da). Varsayılan 64. */
  cellPx?: number;
  /** Küme olmak için en az unsur. Varsayılan 2. */
  minPoints?: number;
  /** Bu zoom ve üstünde kümeleme yok. Varsayılan 13. */
  maxZoom?: number;
  /** Küme unsurlarının kind'ı. Varsayılan `cluster`. */
  kind?: string;
  /**
   * Sembol-farkında kümelemede aynı hücredeki farklı anahtarlı kümeler üst üste biner: anahtara göre
   * ekranda kaydırma (CSS px, [sağ, aşağı]). Ör. dost sol üst, düşman sağ üst. Varsayılan: yok.
   */
  keyOffsetPx?: (key: string) => readonly [number, number] | undefined;
};

type Cell = {
  key: string;
  groupId: string;
  clusterKey: string;
  cx: number;
  cy: number;
  ids: Set<string>;
  sumLon: number;
  sumLat: number;
};

type Point = {
  rf: RenderFeature;
  lon: number;
  lat: number;
  cell: Cell | null;
  /** Adapter'da mı: `true` gösteriliyor, `false` gizli (kümede), `null` bilinmiyor (ilk kez görüldü). */
  shown: boolean | null;
};

type ShownCluster = { cell: Cell; count: number; lon: number; lat: number; selected: boolean };

/** MapLibre ile aynı: zoom z'de dünya 512·2^z piksel. */
const TILE_PX = 512;
const RAD = Math.PI / 180;

export class ClusterStage implements PresentationStage {
  readonly id = "cluster";

  private readonly filter: (feature: Feature) => boolean;
  private readonly keyOf: (feature: Feature) => string;
  private readonly cellPx: number;
  private readonly minPoints: number;
  private readonly maxZoom: number;
  private readonly kind: string;
  private readonly keyOffsetPx: ClusterStageOptions["keyOffsetPx"];

  private readonly points = new Map<string, Point>();
  private readonly cells = new Map<string, Cell>();
  private readonly shownClusters = new Map<string, ShownCluster>();
  /** İzlenen unsurların görsel durumu (gizliyken saklanır). */
  private readonly states = new Map<string, Partial<FeatureVisualState>>();
  private readonly selectedIds = new Set<string>();
  /** Kümeleme zoom'u; `null` → kümeleme yok (görünüm bilinmiyor veya `maxZoom` üstü). */
  private zoom: number | null = null;
  private initialized = false;

  constructor(options: ClusterStageOptions = {}) {
    this.filter = options.filter ?? ((f) => f.geometry.kind === "point");
    this.keyOf = options.clusterKey ?? (() => "");
    this.cellPx = options.cellPx ?? 64;
    this.minPoints = Math.max(options.minPoints ?? 2, 2);
    this.maxZoom = options.maxZoom ?? 13;
    this.kind = options.kind ?? CLUSTER_KIND;
    this.keyOffsetPx = options.keyOffsetPx;
  }

  /** Şu an kümelenen (gizli) unsur sayısı ve küme sayısı — ölçüm / panel için. */
  get stats(): { tracked: number; hidden: number; clusters: number; zoom: number | null } {
    let hidden = 0;
    for (const p of this.points.values()) if (p.shown === false) hidden++;
    return { tracked: this.points.size, hidden, clusters: this.shownClusters.size, zoom: this.zoom };
  }

  /** Ekrandaki kümenin içeriği (yoksa `null`). */
  getCluster(id: string): ClusterInfo | null {
    const shown = this.shownClusters.get(id);
    if (!shown || this.zoom === null) return null;
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const pid of shown.cell.ids) {
      const p = this.points.get(pid)!;
      minLon = Math.min(minLon, p.lon);
      maxLon = Math.max(maxLon, p.lon);
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
    }
    return {
      id,
      count: shown.cell.ids.size,
      key: shown.cell.clusterKey,
      ids: [...shown.cell.ids],
      center: [shown.lon, shown.lat],
      bounds: { min: [minLon, minLat], max: [maxLon, maxLat] },
      zoom: this.zoom,
    };
  }

  /** Ekrandaki tüm kümeler (ör. yan panelde liste). */
  getClusters(): ClusterInfo[] {
    return [...this.shownClusters.keys()].map((id) => this.getCluster(id)!);
  }

  // ── PresentationStage ──────────────────────────────────────────

  process(batch: RenderBatch, context: PresentationContext): RenderBatch {
    if (!this.initialized) {
      this.initialized = true;
      this.zoom = this.zoomOf(context.view);
    }
    const out = new Output();
    /** Bu batch'te kirlenen hücreler → batch başındaki üye sayısı (eşik geçildi mi?). */
    const dirty = new Map<Cell, number>();
    const markDirty = (cell: Cell | null) => {
      if (cell && !dirty.has(cell)) dirty.set(cell, cell.ids.size);
    };
    /** Bu batch'te güncellenen izlenen unsurlar. */
    const touched = new Set<string>();

    for (const id of batch.features?.remove ?? []) {
      const p = this.points.get(id);
      if (!p) {
        out.remove(id);
        continue;
      }
      markDirty(p.cell);
      this.detach(id, p);
      this.points.delete(id);
      this.states.delete(id);
      this.selectedIds.delete(id);
      if (p.shown !== false) out.remove(id);
    }

    for (const rf of batch.features?.upsert ?? []) {
      const id = rf.feature.id;
      let p = this.points.get(id);
      const coord = rf.feature.geometry.kind === "point" ? rf.feature.geometry.coord : null;
      if (!coord || !this.filter(rf.feature)) {
        // İzlenmiyor (veya artık izlenmiyor): aynen geçer; gizliyse adapter'da yok → tüm bitlerle.
        if (p) {
          markDirty(p.cell);
          this.detach(id, p);
          this.points.delete(id);
          if (p.shown === false) {
            out.upsert({ ...rf, changed: RENDER_CHANGE_ALL });
            this.restoreState(id, out);
          } else out.upsert(rf);
          this.states.delete(id);
          this.selectedIds.delete(id);
        } else out.upsert(rf);
        continue;
      }
      const [lon, lat] = coord;
      if (!p) {
        p = { rf, lon, lat, cell: null, shown: null };
        this.points.set(id, p);
      }
      p.rf = rf;
      const next = this.cellFor(rf, lon, lat, p.cell);
      if (next !== p.cell) {
        markDirty(p.cell);
        markDirty(next);
        this.detach(id, p);
        p.lon = lon;
        p.lat = lat;
        this.attach(id, p, next);
      } else if (p.lon !== lon || p.lat !== lat) {
        // Aynı hücrede hareket: yalnız küme merkezi değişir.
        if (p.cell) {
          markDirty(p.cell);
          p.cell.sumLon += lon - p.lon;
          p.cell.sumLat += lat - p.lat;
        }
        p.lon = lon;
        p.lat = lat;
      }
      touched.add(id);
    }

    // Görünürlük: güncellenen unsurlar + eşiği geçen hücrelerin tüm üyeleri
    for (const id of touched) {
      const p = this.points.get(id);
      if (p) this.evaluate(id, p, true, out);
    }
    for (const [cell, before] of dirty) {
      if (before >= this.minPoints === cell.ids.size >= this.minPoints) continue;
      for (const id of cell.ids) if (!touched.has(id)) this.evaluate(id, this.points.get(id)!, false, out);
    }

    // Görsel durum: gizli unsurunki saklanır, kümesi vurgulanır
    const selectionCells = new Set<Cell>();
    for (const patch of batch.state ?? []) {
      const p = this.points.get(patch.id);
      if (!p) {
        out.state(patch.id, patch.state);
        continue;
      }
      this.states.set(patch.id, { ...this.states.get(patch.id), ...patch.state });
      if (patch.state.selected === true) this.selectedIds.add(patch.id);
      else if (patch.state.selected === false) this.selectedIds.delete(patch.id);
      if (p.shown === false) {
        if (p.cell && patch.state.selected !== undefined) selectionCells.add(p.cell);
      } else out.state(patch.id, patch.state);
    }

    for (const cell of dirty.keys()) this.updateCluster(cell, out, true);
    for (const cell of selectionCells) if (!dirty.has(cell)) this.updateCluster(cell, out, false);

    return out.toBatch(batch);
  }

  onViewChange(view: CameraView, _context: PresentationContext): RenderBatch | null {
    this.initialized = true;
    const zoom = this.zoomOf(view);
    if (zoom === this.zoom) return null;
    this.zoom = zoom;
    return this.rebuild();
  }

  onRemove(_context: PresentationContext): RenderBatch | null {
    const remove = [...this.shownClusters.keys()];
    this.points.clear();
    this.cells.clear();
    this.shownClusters.clear();
    this.states.clear();
    this.selectedIds.clear();
    this.initialized = false;
    this.zoom = null;
    return remove.length > 0 ? { features: { upsert: [], remove } } : null;
  }

  // ── İç ─────────────────────────────────────────────────────────

  /** Tam sayı zoom değişti: hücreler baştan, gizlenen / açılan unsurlar ve kümeler farkla. */
  private rebuild(): RenderBatch {
    const out = new Output();
    const previous = new Set(this.shownClusters.keys());
    this.shownClusters.clear();
    this.cells.clear();
    for (const [id, p] of this.points) {
      p.cell = null;
      this.attach(id, p, this.cellFor(p.rf, p.lon, p.lat));
    }
    for (const [id, p] of this.points) this.evaluate(id, p, false, out);
    for (const cell of this.cells.values()) this.updateCluster(cell, out, true);
    for (const id of previous) if (!this.shownClusters.has(id)) out.remove(id);
    return out.toBatch({});
  }

  /** Unsurun son görünürlüğünü adapter'a yansıtır. `updated`: bu batch'te güncellendi (iletilmeli). */
  private evaluate(id: string, p: Point, updated: boolean, out: Output): void {
    const hidden = p.cell !== null && p.cell.ids.size >= this.minPoints;
    if (hidden) {
      if (p.shown !== false) out.remove(id); // ilk kez görülen de: adapter'da olabilir (aşama sonradan eklendi)
      p.shown = false;
      return;
    }
    if (p.shown === false) {
      out.upsert({ ...p.rf, changed: RENDER_CHANGE_ALL });
      this.restoreState(id, out);
    } else if (updated) {
      out.upsert(p.rf);
    }
    p.shown = true;
  }

  /** Hücrenin kümesini oluşturur / günceller / kaldırır. `geometry`: üyelik veya konum değişmiş olabilir. */
  private updateCluster(cell: Cell, out: Output, geometry: boolean): void {
    const id = this.clusterId(cell);
    const shown = this.shownClusters.get(id);
    const count = cell.ids.size;
    if (count < this.minPoints || this.zoom === null) {
      if (shown) {
        out.remove(id);
        this.shownClusters.delete(id);
      }
      if (count === 0) this.cells.delete(cell.key);
      return;
    }
    const selected = this.cellHasSelected(cell);
    let lon = cell.sumLon / count;
    let lat = cell.sumLat / count;
    // Üyeler hareket ettikçe merkez sürekli kayar: ~2 px'ten az kaydıysa küme güncellenmez (ekranda fark yok,
    // adapter'a binlerce gereksiz güncelleme gitmez).
    const eps = (2 * 360) / (TILE_PX * 2 ** this.zoom);
    const moved = !shown || Math.abs(shown.lon - lon) > eps || Math.abs(shown.lat - lat) > eps;
    if (shown && !moved) {
      lon = shown.lon;
      lat = shown.lat;
    }
    if (geometry && (!shown || shown.count !== count || moved)) {
      const sample = this.points.get(cell.ids.values().next().value!)!.rf;
      const changed = !shown
        ? RENDER_CHANGE_ALL
        : (shown.count !== count ? FEATURE_CHANGE.PROPS : 0) | (shown.lon !== lon || shown.lat !== lat ? FEATURE_CHANGE.GEOMETRY : 0);
      const props: ClusterProps = { count, key: cell.clusterKey };
      out.upsert({
        feature: { id, layerId: sample.feature.layerId, kind: this.kind, geometry: { kind: "point", coord: this.displayCoord(lon, lat, cell.clusterKey) }, props },
        groupId: cell.groupId,
        opacity: sample.opacity,
        zIndex: sample.zIndex,
        changed,
      });
    }
    if (!shown ? selected : shown.selected !== selected) out.state(id, { selected });
    this.shownClusters.set(id, { cell, count, lon, lat, selected });
  }

  /** Ekranda gösterilecek konum: merkez + anahtarın piksel kaydırması (kümeleme zoom'unda). */
  private displayCoord(lon: number, lat: number, key: string): LngLat {
    const offset = this.keyOffsetPx?.(key);
    if (!offset || this.zoom === null) return [lon, lat];
    const world = TILE_PX * 2 ** this.zoom;
    const s = Math.min(Math.max(Math.sin(lat * RAD), -0.9999), 0.9999);
    const x = ((lon + 180) / 360) * world + offset[0];
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world + offset[1];
    const outLon = (x / world) * 360 - 180;
    const outLat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world))) * 180) / Math.PI;
    return [outLon, outLat];
  }

  private cellHasSelected(cell: Cell): boolean {
    for (const id of this.selectedIds) if (this.points.get(id)?.cell === cell) return true;
    return false;
  }

  private restoreState(id: string, out: Output): void {
    const state = this.states.get(id);
    if (state && Object.keys(state).length > 0) out.state(id, state);
  }

  private zoomOf(view: CameraView | null): number | null {
    if (!view || view.zoom === undefined) return null;
    const zoom = Math.floor(view.zoom);
    return zoom >= this.maxZoom ? null : Math.max(zoom, 0);
  }

  /** Noktanın hücresi (kümeleme kapalıysa `null`). Hücre render group'a ve anahtara özeldir. */
  private cellFor(rf: RenderFeature, lon: number, lat: number, current: Cell | null = null): Cell | null {
    if (this.zoom === null) return null;
    const world = TILE_PX * 2 ** this.zoom;
    const x = ((lon + 180) / 360) * world;
    const s = Math.min(Math.max(Math.sin(lat * RAD), -0.9999), 0.9999);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
    const cx = Math.floor(x / this.cellPx);
    const cy = Math.floor(y / this.cellPx);
    const clusterKey = this.keyOf(rf.feature);
    // Sıcak yol: canlı akışta nokta çoğu güncellemede aynı hücrede kalır → anahtar metni kurulmaz.
    if (current && current.cx === cx && current.cy === cy && current.groupId === rf.groupId && current.clusterKey === clusterKey) {
      return current;
    }
    const key = `${rf.groupId}|${clusterKey}|${cx}|${cy}`;
    let cell = this.cells.get(key);
    if (!cell) {
      cell = { key, groupId: rf.groupId, clusterKey, cx, cy, ids: new Set(), sumLon: 0, sumLat: 0 };
      this.cells.set(key, cell);
    }
    return cell;
  }

  private attach(id: string, p: Point, cell: Cell | null): void {
    p.cell = cell;
    if (!cell) return;
    cell.ids.add(id);
    cell.sumLon += p.lon;
    cell.sumLat += p.lat;
  }

  private detach(id: string, p: Point): void {
    const cell = p.cell;
    p.cell = null;
    if (!cell || !cell.ids.delete(id)) return;
    cell.sumLon -= p.lon;
    cell.sumLat -= p.lat;
  }

  private clusterId(cell: Cell): string {
    return `${CLUSTER_ID_PREFIX}${this.zoom}|${cell.key}`;
  }
}

/** Batch çıktısı: aynı unsur için son karar geçerli (sil → ekle sırası adapter'da korunur). */
class Output {
  private readonly upserts = new Map<string, RenderFeature>();
  private readonly removes = new Set<string>();
  private readonly states = new Map<string, Partial<FeatureVisualState>>();

  upsert(rf: RenderFeature): void {
    const prev = this.upserts.get(rf.feature.id);
    this.upserts.set(rf.feature.id, prev ? { ...rf, changed: prev.changed | rf.changed } : rf);
  }

  remove(id: string): void {
    this.upserts.delete(id);
    this.removes.add(id);
  }

  state(id: string, state: Partial<FeatureVisualState>): void {
    this.states.set(id, { ...this.states.get(id), ...state });
  }

  toBatch(input: RenderBatch): RenderBatch {
    const batch: RenderBatch = { ...input };
    delete batch.features;
    delete batch.state;
    if (this.upserts.size > 0 || this.removes.size > 0) {
      batch.features = { upsert: [...this.upserts.values()], remove: [...this.removes] };
    }
    if (this.states.size > 0) {
      batch.state = [...this.states].map(([id, state]): FeatureStatePatch => ({ id, state }));
    }
    return batch;
  }
}
