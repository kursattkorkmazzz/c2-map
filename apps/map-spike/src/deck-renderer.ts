import type { LayersList } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { STATUS_COLORS } from './map';
import { CHANGE, type UnitStore } from './store';

// deck.gl ile çizim: birliklerin konum/açı/renkleri GPU'ya doğrudan giden düz sayı dizilerinde
// (typed array) tutulur. MapLibre'deki "işçiye gönder → yeniden indeksle" adımı yoktur.

const UNITS_LAYER_ID = 'deck-units';
const ICON_PX = 22;

type Rgba = [number, number, number, number];
const STATUS_RGBA: Rgba[] = STATUS_COLORS.map((hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
  255,
]);

// Beyaz ok; `mask: true` sayesinde deck.gl onu getColor ile boyar → tek görüntü, tüm renkler.
function createArrowAtlas(): string {
  const size = ICON_PX * 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(size / 2, size / 2);
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.42);
  ctx.lineTo(size * 0.3, size * 0.36);
  ctx.lineTo(0, size * 0.18);
  ctx.lineTo(-size * 0.3, size * 0.36);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  return canvas.toDataURL();
}
const ICON_ATLAS = createArrowAtlas();
const ICON_MAPPING = { arrow: { x: 0, y: 0, width: ICON_PX * 2, height: ICON_PX * 2, mask: true } };

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

/** deck.gl'in açısı saat yönünün tersine; bizim yönümüz kuzeyden saat yönüne. */
const toDeckAngle = (hdg: number): number => -hdg;

export class DeckUnitRenderer {
  private readonly overlay = new MapboxOverlay({ interleaved: true, layers: [] });
  private active = false;

  // Birlik başına düz diziler (id = indeks)
  private n = 0;
  private pos = new Float64Array(0); // ekranda gösterilen konum [lon, lat, ...]
  private ang = new Float32Array(0); // ekranda gösterilen açı
  private color = new Uint8Array(0); // RGBA
  // Akıcı hareket için: nereden → nereye, ne zaman başladı
  private fromPos = new Float64Array(0);
  private toPos = new Float64Array(0);
  private fromAng = new Float32Array(0);
  private toAng = new Float32Array(0);
  private tStart = new Float64Array(0);

  // deck.gl aynı nesne referansını görünce güncellemeyi atlar; sürüm sayaçları + yeni sarmalayıcılar
  // ile "şu dizi değişti" diye haber veriyoruz. Böylece ikon atlası her seferinde yeniden kurulmaz.
  private data: {
    length: number;
    attributes: Record<string, { value: Float64Array | Float32Array | Uint8Array; size: number; normalized?: boolean }>;
  } = {
    length: 0,
    attributes: {},
  };
  private posVersion = 0;
  private colorVersion = 0;

  private selectedId: number | null = null;

  smooth = true;
  durationMs = 1000;

  constructor(
    map: MaplibreMap,
    private readonly store: UnitStore,
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
    this.ang = new Float32Array(n);
    this.color = new Uint8Array(n * 4);
    this.fromPos = new Float64Array(n * 2);
    this.toPos = new Float64Array(n * 2);
    this.fromAng = new Float32Array(n);
    this.toAng = new Float32Array(n);
    this.tStart = new Float64Array(n);

    for (const u of units) {
      const i = u.id;
      this.pos[i * 2] = this.fromPos[i * 2] = this.toPos[i * 2] = u.lon;
      this.pos[i * 2 + 1] = this.fromPos[i * 2 + 1] = this.toPos[i * 2 + 1] = u.lat;
      this.ang[i] = this.fromAng[i] = this.toAng[i] = toDeckAngle(u.hdg);
      this.color.set(STATUS_RGBA[u.status] ?? STATUS_RGBA[0]!, i * 4);
    }
    this.store.drainChanges();

    // Birlik sayısı değişti → yeni data nesnesi (tam yeniden kurulum, yalnız bu anda).
    this.data = { length: n, attributes: {} };
    this.touchPositions();
    this.touchColors();
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

    let colorChanged = false;
    for (const [id, mask] of changes) {
      const u = this.store.get(id);
      if (!u) continue;
      if (mask & CHANGE.GEOMETRY) {
        const a = toDeckAngle(u.hdg);
        if (this.smooth) {
          // Şu an ekranda olduğu yerden yeni konuma doğru kaymaya başla
          this.fromPos[id * 2] = this.pos[id * 2]!;
          this.fromPos[id * 2 + 1] = this.pos[id * 2 + 1]!;
          this.fromAng[id] = this.ang[id]!;
          this.tStart[id] = now;
        } else {
          this.pos[id * 2] = u.lon;
          this.pos[id * 2 + 1] = u.lat;
          this.ang[id] = a;
        }
        this.toPos[id * 2] = u.lon;
        this.toPos[id * 2 + 1] = u.lat;
        this.toAng[id] = a;
      }
      if (mask & CHANGE.PROPS) {
        this.color.set(STATUS_RGBA[u.status] ?? STATUS_RGBA[0]!, id * 4);
        colorChanged = true;
      }
    }

    if (!this.smooth) this.touchPositions();
    if (colorChanged) this.touchColors();
    if (!this.smooth || colorChanged) this.push();
    return changes.size;
  }

  /** Akıcı modda her karede çağrılır: tüm birlikleri ara konuma taşır. */
  animate(now: number): void {
    if (!this.smooth) return;
    const { pos, ang, fromPos, toPos, fromAng, toAng, tStart, durationMs } = this;
    for (let i = 0; i < this.n; i++) {
      const t = Math.min(1, (now - tStart[i]!) / durationMs);
      pos[i * 2] = fromPos[i * 2]! + (toPos[i * 2]! - fromPos[i * 2]!) * t;
      pos[i * 2 + 1] = fromPos[i * 2 + 1]! + (toPos[i * 2 + 1]! - fromPos[i * 2 + 1]!) * t;
      // En kısa yoldan dön (350° → 10° = +20°, -340° değil)
      const d = ((((toAng[i]! - fromAng[i]!) % 360) + 540) % 360) - 180;
      ang[i] = fromAng[i]! + d * t;
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
    this.data.attributes.getAngle = { value: this.ang, size: 1 };
    this.posVersion++;
  }

  private touchColors(): void {
    this.data.attributes.getColor = { value: this.color, size: 4, normalized: true };
    this.colorVersion++;
  }

  private push(): void {
    const layers: LayersList = [
      new IconLayer({
        id: UNITS_LAYER_ID,
        data: this.data,
        iconAtlas: ICON_ATLAS,
        iconMapping: ICON_MAPPING,
        getIcon: () => 'arrow',
        getSize: ICON_PX,
        sizeUnits: 'pixels',
        billboard: false, // harita düzleminde yatar → harita döndükçe yön doğru kalır
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 200],
        updateTriggers: {
          getPosition: this.posVersion,
          getAngle: this.posVersion,
          getColor: this.colorVersion,
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
          getRadius: 16,
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
