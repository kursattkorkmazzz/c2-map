// ── Billboard renderer: ikonlu nokta unsurları (birlikler, işaretler) ─
// Tasarım: plan/design/04-sync-and-rendering.md#cesium-yolu
//
// Tek `BillboardCollection` (mount'ta): unsur başına bir billboard. Görüntü ANAHTARLA paylaşılır
// (`setImage(key, canvas)`): 10k birlik birkaç yüz sembolü tek doku atlasında paylaşır; sembol
// değişince yalnız anahtar değişir.
//
//   konum    → arazide zemine oturur (CLAMP_TO_GROUND); tepeye kadar her yerden görünür
//              (`disableDepthTestDistance`: tepe arkasında kalan sembol kaybolmaz)
//   opaklık  → billboard rengi (beyaz × alfa)
//   seçim    → aynı konumda ikinci billboard: halka (seçili beyaz, hover mavi)
//
// Güncellemede yalnız değişen bit işlenir: konum (GEOMETRY), görüntü (PROPS / STYLE), opaklık.

import { FEATURE_CHANGE, RENDER_CHANGE, type Feature, type LngLat, type RenderFeature } from '@c2/map-core';
import {
  BillboardCollection,
  Cartesian3,
  Color,
  HeightReference,
  NearFarScalar,
  type Billboard,
} from 'cesium';
import { HOVER_COLOR, SELECTED_COLOR, type CesiumKindRenderer, type CesiumRenderContext, type FullVisualState } from './types';

export type BillboardImage = {
  /** Benzersiz görüntü anahtarı (ör. SIDC): aynı anahtar = aynı doku. */
  key: string;
  /** Görüntünün kendisi (canvas önerilir; URL de olur). */
  image: HTMLCanvasElement | string;
  /** Ekrandaki boyut (CSS px). */
  width: number;
  height: number;
};

export type BillboardRendererOptions = {
  /** Unsurun görüntüsü; `undefined` → çizilmez. */
  image: (feature: Feature) => BillboardImage | undefined;
  /** Araziye otur (varsayılan `true`). `false`: konumun z'si (yoksa 0) elipsoit yüksekliği. */
  clampToGround?: boolean;
  /** Uzaklaştıkça küçült: [yakın m, ölçek, uzak m, ölçek]. Varsayılan [2 km, 1, 1500 km, 0,45]. */
  scaleByDistance?: [number, number, number, number] | null;
};

type Handle = { billboard: Billboard; key: string; ring: Billboard | null; state: FullVisualState };

const RING_SELECTED = 'c2-ring-selected';
const RING_HOVER = 'c2-ring-hover';

/** Seçim halkası görüntüsü (tarayıcıda, ilk ihtiyaçta bir kez). */
function ringCanvas(color: string): HTMLCanvasElement {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.stroke();
  return canvas;
}

const pointOf = (feature: Feature): LngLat | null => (feature.geometry.kind === 'point' ? feature.geometry.coord : null);

export function billboardRenderer(options: BillboardRendererOptions): CesiumKindRenderer<Handle> {
  const clamp = options.clampToGround !== false;
  const sbd = options.scaleByDistance === undefined ? [2_000, 1, 1_500_000, 0.45] : options.scaleByDistance;
  const scaleByDistance = sbd ? new NearFarScalar(sbd[0], sbd[1], sbd[2], sbd[3]) : undefined;
  let collection: BillboardCollection | null = null;
  const rings = new Map<string, HTMLCanvasElement>();
  const ring = (key: string) => {
    let canvas = rings.get(key);
    if (!canvas) rings.set(key, (canvas = ringCanvas(key === RING_SELECTED ? SELECTED_COLOR : HOVER_COLOR)));
    return canvas;
  };

  const position = (coord: LngLat) => Cartesian3.fromDegrees(coord[0], coord[1], clamp ? 0 : (coord[2] ?? 0));

  const applyRing = (handle: Handle) => {
    const { selected, hovered } = handle.state;
    if (!selected && !hovered) {
      if (handle.ring) {
        collection!.remove(handle.ring);
        handle.ring = null;
      }
      return;
    }
    const key = selected ? RING_SELECTED : RING_HOVER;
    if (!handle.ring) {
      handle.ring = collection!.add({
        position: handle.billboard.position,
        heightReference: handle.billboard.heightReference,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        ...(scaleByDistance ? { scaleByDistance } : {}),
        id: handle.billboard.id,
      });
    }
    handle.ring.setImage(key, ring(key));
    const size = Math.max(handle.billboard.width ?? 24, handle.billboard.height ?? 24) + 12;
    handle.ring.width = size;
    handle.ring.height = size;
  };

  return {
    init(ctx) {
      // `scene` verilirse koleksiyon araziye oturtmayı (heightReference) destekler; oturtma yoksa gereksiz.
      collection = ctx.primitives.add(new BillboardCollection(clamp ? { scene: ctx.scene } : {})) as BillboardCollection;
    },

    destroy(ctx) {
      if (collection) ctx.primitives.remove(collection); // koleksiyonu da yok eder
      collection = null;
    },

    create(rf, ctx, state) {
      const at = pointOf(rf.feature);
      const image = options.image(rf.feature);
      if (!collection || !at || !image) return null;
      const billboard = collection.add({
        position: position(at),
        heightReference: clamp ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        width: image.width,
        height: image.height,
        color: Color.WHITE.withAlpha(rf.opacity),
        ...(scaleByDistance ? { scaleByDistance } : {}),
        id: rf.feature.id,
      });
      billboard.setImage(image.key, image.image);
      ctx.own(billboard, rf.feature.id);
      const handle: Handle = { billboard, key: image.key, ring: null, state };
      applyRing(handle);
      return handle;
    },

    update(handle, rf, _ctx, state) {
      const changed = rf.changed;
      if (changed & FEATURE_CHANGE.GEOMETRY) {
        const at = pointOf(rf.feature);
        if (!at) return null;
        handle.billboard.position = position(at);
        if (handle.ring) handle.ring.position = handle.billboard.position;
      }
      if (changed & (FEATURE_CHANGE.PROPS | FEATURE_CHANGE.STYLE)) {
        const image = options.image(rf.feature);
        if (!image) return null;
        if (image.key !== handle.key) {
          handle.billboard.setImage(image.key, image.image);
          handle.key = image.key;
        }
        handle.billboard.width = image.width;
        handle.billboard.height = image.height;
      }
      if (changed & RENDER_CHANGE.OPACITY) handle.billboard.color = Color.WHITE.withAlpha(rf.opacity);
      handle.state = state;
    },

    remove(handle, ctx) {
      ctx.disown(handle.billboard);
      collection?.remove(handle.billboard);
      if (handle.ring) collection?.remove(handle.ring);
    },

    setState(handle, state) {
      handle.state = state;
      applyRing(handle);
    },
  };
}
