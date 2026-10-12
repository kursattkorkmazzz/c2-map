import type { LayersList } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { CHANGE, type UnitStore } from './store';
import type { SymbolCache } from './symbology';

// deck.gl ile çizim: birliklerin konumları GPU'ya doğrudan giden düz sayı dizilerinde
// (typed array) tutulur. MapLibre'deki "işçiye gönder → yeniden indeksle" adımı yoktur.

const UNITS_LAYER_ID = 'deck-units';

type DeckIcon = { id: string; url: string; width: number; height: number };

/**
 * UYUMLULUK YAMASI: @deck.gl/mapbox 9.4, MapLibre'nin iç `map.transform` alanını okur.
 * MapLibre 6'da bu alan `map._camera.transform`'a taşındı → deck.gl her karede çöküyordu.
 * Spike için alanı geri bağlıyoruz. Gerçek pakette: deck.gl MapLibre 6'yı resmi olarak
 * destekleyene kadar ya bu yama ya da MapLibre 5'e sabitleme gerekir.
 */
function shimMaplibre6Transform(map: MaplibreMap): void {
  const m = map as unknown as { transform?: unknown; _camera?: { transform: unknown } };
  if (m.transform !== undefined || !m._camera) return;
  Object.defineProperty(map, 'transform', { get: () => m._camera!.transform, configurable: true });
}

export class DeckUnitRenderer {
  private readonly overlay = new MapboxOverlay({ interleaved: true, layers: [] });
  private active = false;

  // Birlik başına düz diziler (id = indeks)
  private n = 0;
  private pos = new Float64Array(0); // ekranda gösterilen konum [lon, lat, ...]
  private size = new Float32Array(0); // sembol yüksekliği (px) — semboller farklı boyda
  // Akıcı hareket için: nereden → nereye, ne zaman başladı
  private fromPos = new Float64Array(0);
  private toPos = new Float64Array(0);
  private tStart = new Float64Array(0);

  // deck.gl aynı nesne referansını görünce güncellemeyi atlar; sürüm sayaçları + yeni sarmalayıcılar
  // ile "şu dizi değişti" diye haber veriyoruz. Böylece değişmeyen öznitelikler yeniden kurulmaz.
  private data: {
    length: number;
    attributes: Record<string, { value: Float64Array | Float32Array; size: number }>;
  } = { length: 0, attributes: {} };
  private posVersion = 0;
  private iconVersion = 0;

  // Kod başına tek ikon tanımı (deck.gl atlasına her kod bir kez eklenir)
  private readonly icons = new Map<string, DeckIcon>();

  private selectedId: number | null = null;

  smooth = true;
  durationMs = 1000;

  constructor(
    map: MaplibreMap,
    private readonly store: UnitStore,
    private readonly symbols: SymbolCache,
  ) {
    shimMaplibre6Transform(map);
    map.addControl(this.overlay);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Store'daki mevcut durumdan dizileri baştan kurar ve katmanı gösterir. */
  activate(): void {
    this.active = true;
    const units = this.store.all();
    const n = (this.n = units.length);
    this.pos = new Float64Array(n * 2);
    this.size = new Float32Array(n);
    this.fromPos = new Float64Array(n * 2);
    this.toPos = new Float64Array(n * 2);
    this.tStart = new Float64Array(n);

    for (const u of units) {
      const i = u.id;
      this.pos[i * 2] = this.fromPos[i * 2] = this.toPos[i * 2] = u.lon;
      this.pos[i * 2 + 1] = this.fromPos[i * 2 + 1] = this.toPos[i * 2 + 1] = u.lat;
      this.size[i] = this.symbols.get(u.sidc).height;
    }
    this.store.drainChanges();

    // Birlik sayısı değişti → yeni data nesnesi (tam yeniden kurulum, yalnız bu anda).
    this.data = { length: n, attributes: {} };
    this.touchPositions();
    this.touchIcons();
    this.push();
  }

  deactivate(): void {
    this.active = false;
    this.overlay.setProps({ layers: [] });
  }

  setSelected(id: number | null): void {
    this.selectedId = id;
    if (this.active) this.push();
  }

  /** Biriken değişiklikleri dizilere yazar. Gönderilen unsur sayısını döner. */
  flush(now: number): number {
    const changes = this.store.drainChanges();
    if (changes.size === 0) return 0;

    let iconChanged = false;
    for (const [id, mask] of changes) {
      const u = this.store.get(id);
      if (!u) continue;
      if (mask & CHANGE.GEOMETRY) {
        if (this.smooth) {
          // Şu an ekranda olduğu yerden yeni konuma doğru kaymaya başla
          this.fromPos[id * 2] = this.pos[id * 2]!;
          this.fromPos[id * 2 + 1] = this.pos[id * 2 + 1]!;
          this.tStart[id] = now;
        } else {
          this.pos[id * 2] = u.lon;
          this.pos[id * 2 + 1] = u.lat;
        }
        this.toPos[id * 2] = u.lon;
        this.toPos[id * 2 + 1] = u.lat;
      }
      if (mask & CHANGE.PROPS) {
        this.size[id] = this.symbols.get(u.sidc).height;
        iconChanged = true;
      }
    }

    if (!this.smooth) this.touchPositions();
    if (iconChanged) this.touchIcons();
    if (!this.smooth || iconChanged) this.push();
    return changes.size;
  }

  /** Akıcı modda her karede çağrılır: tüm birlikleri ara konuma taşır. */
  animate(now: number): void {
    if (!this.smooth) return;
    const { pos, fromPos, toPos, tStart, durationMs } = this;
    for (let i = 0; i < this.n; i++) {
      const t = Math.min(1, (now - tStart[i]!) / durationMs);
      pos[i * 2] = fromPos[i * 2]! + (toPos[i * 2]! - fromPos[i * 2]!) * t;
      pos[i * 2 + 1] = fromPos[i * 2 + 1]! + (toPos[i * 2 + 1]! - fromPos[i * 2 + 1]!) * t;
    }
    this.touchPositions();
    this.push();
  }

  /** Ekran koordinatındaki en üstteki birlik. */
  pick(x: number, y: number): number | null {
    const info = this.overlay.pickObject({ x, y, radius: 4, layerIds: [UNITS_LAYER_ID] });
    return info && info.index >= 0 ? info.index : null;
  }

  private touchPositions(): void {
    this.data.attributes.getPosition = { value: this.pos, size: 2 };
    this.posVersion++;
  }

  private touchIcons(): void {
    this.data.attributes.getSize = { value: this.size, size: 1 };
    this.iconVersion++;
  }

  private iconFor(sidc: string): DeckIcon {
    let icon = this.icons.get(sidc);
    if (!icon) {
      const img = this.symbols.get(sidc);
      icon = { id: sidc, url: this.symbols.dataUrl(sidc), width: img.canvas.width, height: img.canvas.height };
      this.icons.set(sidc, icon);
    }
    return icon;
  }

  private push(): void {
    const layers: LayersList = [
      new IconLayer({
        id: UNITS_LAYER_ID,
        data: this.data,
        // Otomatik atlas: deck.gl her yeni kodun görüntüsünü bir kez yükleyip atlasa ekler.
        getIcon: (_: unknown, { index }: { index: number }) => this.iconFor(this.store.get(index)!.sidc),
        sizeUnits: 'pixels',
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 90],
        updateTriggers: {
          getPosition: this.posVersion,
          getIcon: this.iconVersion,
          getSize: this.iconVersion,
        },
      }),
    ];

    const sel = this.selectedId;
    if (sel !== null && sel < this.n) {
      layers.push(
        new ScatterplotLayer({
          id: 'deck-selected',
          data: [sel],
          getPosition: (i: number) => [this.pos[i * 2]!, this.pos[i * 2 + 1]!],
          getRadius: 24,
          radiusUnits: 'pixels',
          stroked: true,
          filled: false,
          getLineColor: [255, 255, 255, 255],
          lineWidthMinPixels: 2,
          updateTriggers: { getPosition: this.posVersion },
        }),
      );
    }

    this.overlay.setProps({ layers });
  }
}
