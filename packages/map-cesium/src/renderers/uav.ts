// ── İHA (composite) renderer'ı — Cesium, gerçek 3B ───────────────
// Tasarım: plan/design/08-extensibility-symbology.md#composite-unsur-iha
//
// Store'da TEK unsur (kind: 'uav'); props çekirdekte (`UavProps`). MapLibre + deck.gl'deki
// renderer'ın aynısını üretir, ama arazili gerçek 3B'de:
//
//   model     glTF (Entity model)                 konum + irtifa + burun yönü; seçimde siluet
//   etiket    çağrı adı + irtifa
//   koni      4 yarı saydam üçgen + kenar çizgileri tepe İHA'da, taban zemindeki iz
//   iz        zemindeki dörtgen (köşeler arazi yüksekliğinde)
//   çizgiler  bakış ekseni (kırmızı), İHA'dan zemine dikey çizgi
//
// İrtifa: `altitudeRef: 'sea'` (MSL, gerçek telemetri) → mutlak yükseklik aynen; `ground` (AGL) →
// zemin + irtifa. Sensör izi çekirdeğin `sensorFootprint`'iyle, YERDEN yükseklikle (mutlak − zemin)
// hesaplanır; zemin arazinin o anki yüklü karosundan okunur (`groundHeight`).
//
// Akıcı hareket: mesajlar seyrek (ör. 5 Hz) gelir; her karede önceki hâlden yenisine kayılır
// (`interpolateUav`, süre = ölçülen mesaj aralığı). Parçalar `CallbackProperty` ile her karede
// ara hâlden hesaplanır — onlarca İHA için ucuz; binlerce için uygun değil (o ölçek ikon yolu).

import {
  ALTITUDE_REF,
  interpolateUav,
  sensorFootprint,
  uavPropsOf,
  type Feature,
  type LngLat,
  type RenderFeature,
  type UavProps,
} from '@c2/map-core';
import {
  ArcType,
  BoundingSphere,
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ColorBlendMode,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  HeadingPitchRoll,
  LabelStyle,
  Math as CesiumMath,
  PerInstanceColorAppearance,
  Primitive,
  PrimitiveType,
  Transforms,
  VerticalOrigin,
  type Entity,
  type GeometryAttributes,
} from 'cesium';
import { entityId, HOVER_COLOR, SELECTED_COLOR, type CesiumKindRenderer, type CesiumRenderContext, type FullVisualState } from './types';

export type CesiumUavRendererOptions = {
  /** glTF / GLB model adresi. */
  modelUrl: string;
  /** Model ölçeği (model birimi → m). Varsayılan 8. */
  modelScale?: number;
  /** Uzaktan da görünsün: modelin ekrandaki en küçük boyu (px). Varsayılan 48. */
  minPixels?: number;
  /** Modelin "ileri" ekseni ile kuzey arasındaki fark (derece). Varsayılan 0 (tarayıcıda doğrulanmış). */
  yawOffsetDeg?: number;
  /** Akıcı hareket (varsayılan `true`). */
  glide?: boolean;
  coneColor?: string;
  coneOpacity?: number;
  footprintOpacity?: number;
  /** Etiket gösterilsin mi (varsayılan `true`). */
  labels?: boolean;
};

/** Zeminle z-çakışmasını (titreme) önlemek için iz zeminden biraz yukarıda (m). */
const GROUND_LIFT_M = 3;
/** İlk iki mesaj arasında varsayılan kayma süresi (ms). */
const DEFAULT_GLIDE_MS = 1000;

type Frame = {
  position: Cartesian3;
  orientation: ReturnType<typeof Transforms.headingPitchRollQuaternion>;
  ground: Cartesian3;
  corners: Cartesian3[] | null;
  center: Cartesian3 | null;
  label: string;
};

type Handle = {
  id: string;
  from: Feature;
  to: Feature;
  t0: number;
  durationMs: number;
  lastMessageAt: number;
  opacity: number;
  state: FullVisualState;
  /** Bu kare için hesaplanmış hâl (aynı karedeki ~12 özellik okuması tek hesap). */
  frame: Frame | null;
  frameAt: number;
  entities: Entity[];
};

export function cesiumUavRenderer(options: CesiumUavRendererOptions): CesiumKindRenderer<Handle> {
  const scale = options.modelScale ?? 8;
  const minPixels = options.minPixels ?? 48;
  const yawOffset = options.yawOffsetDeg ?? 0;
  const glide = options.glide !== false;
  const coneColor = Color.fromCssColorString(options.coneColor ?? '#ffcc00');
  const coneOpacity = options.coneOpacity ?? 0.18;
  const footprintOpacity = options.footprintOpacity ?? 0.3;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /** Ara hâlden bu karenin konum / yön / iz değerleri. */
  const compute = (handle: Handle, ctx: CesiumRenderContext): Frame | null => {
    const frameNumber = ctx.frameNumber();
    if (handle.frame && frameNumber === handle.frameAt) return handle.frame;
    const t = now();
    const progress = handle.durationMs > 0 ? Math.min((t - handle.t0) / handle.durationMs, 1) : 1;
    const feature = progress >= 1 ? handle.to : interpolateUav(handle.from, handle.to, progress);
    const props = uavPropsOf(feature);
    const at = feature.geometry.kind === 'point' ? feature.geometry.coord : null;
    if (!props || !at) return null;

    const groundUnder = ctx.groundHeight(at) ?? 0;
    const absolute = props.altitudeRef === ALTITUDE_REF.SEA ? props.altitudeM : groundUnder + props.altitudeM;
    const agl = Math.max(absolute - groundUnder, 1);
    const position = Cartesian3.fromDegrees(at[0], at[1], absolute);
    // glTF'in burnu (+Z) Cesium'da modelin +X'ine düşer; HPR heading 0'da +X doğuya bakar, saat yönünde
    // artar → −90 ile burun kuzeye. Tepeden ve arkadan bakışla doğrulandı (heading 254° → burun BGB).
    const hpr = new HeadingPitchRoll(CesiumMath.toRadians(props.headingDeg + yawOffset - 90), 0, 0);
    const frame: Frame = {
      position,
      orientation: Transforms.headingPitchRollQuaternion(position, hpr),
      ground: Cartesian3.fromDegrees(at[0], at[1], groundUnder),
      corners: null,
      center: null,
      label: `${props.callsign ?? handle.id}\n${Math.round(absolute)} m (yerden ${Math.round(agl)} m)`,
    };
    if (props.sensor) {
      const fp = sensorFootprint(at, agl, props.headingDeg, props.sensor);
      const lifted = (c: LngLat) => Cartesian3.fromDegrees(c[0], c[1], (ctx.groundHeight(c) ?? groundUnder) + GROUND_LIFT_M);
      frame.corners = fp.corners.map(lifted);
      frame.center = lifted(fp.center);
    }
    handle.frame = frame;
    handle.frameAt = frameNumber;
    return frame;
  };

  const build = (handle: Handle, ctx: CesiumRenderContext): void => {
    const f = () => compute(handle, ctx);
    // Her parça (model, etiket, çizgiler) unsura bağlı: hangisine tıklanırsa İHA seçilir.
    const add = (entity: Entity, pickable: boolean) => {
      if (pickable) ctx.own(entity, handle.id);
      handle.entities.push(entity);
    };
    const id = handle.id;
    const color = (base: Color, alpha: number) => base.withAlpha(alpha * handle.opacity);

    add(
      ctx.entities.add({
        id: entityId(id, 'model'),
        position: new CallbackPositionProperty(() => f()?.position, false),
        orientation: new CallbackProperty(() => f()?.orientation, false),
        model: {
          uri: options.modelUrl,
          scale,
          minimumPixelSize: minPixels,
          maximumScale: 20_000,
          colorBlendMode: ColorBlendMode.MIX,
          colorBlendAmount: 0,
          color: new CallbackProperty(() => Color.WHITE.withAlpha(handle.opacity), false),
          silhouetteColor: new CallbackProperty(
            () => Color.fromCssColorString(handle.state.selected ? SELECTED_COLOR : HOVER_COLOR),
            false,
          ),
          silhouetteSize: new CallbackProperty(() => (handle.state.selected ? 3 : handle.state.hovered ? 2 : 0), false),
        },
        ...(options.labels !== false
          ? {
              label: {
                text: new CallbackProperty(() => f()?.label ?? '', false),
                font: '600 12px system-ui, sans-serif',
                fillColor: Color.WHITE,
                outlineColor: Color.BLACK.withAlpha(0.8),
                outlineWidth: 3,
                style: LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: VerticalOrigin.BOTTOM,
                pixelOffset: new Cartesian2(0, -minPixels / 2 - 6),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            }
          : {}),
      }),
      true,
    );

    // Zemine dikey çizgi
    add(
      ctx.entities.add({
        id: entityId(id, 'stem'),
        polyline: {
          positions: new CallbackProperty(() => {
            const fr = f();
            return fr ? [fr.position, fr.ground] : [];
          }, false),
          arcType: ArcType.NONE,
          width: 1.5,
          material: Color.WHITE.withAlpha(0.55),
        },
      }),
      true,
    );

    // Koni kenarları + iz çevresi + bakış ekseni (yüzeyler: ortak primitive, aşağıda `surfaces`)
    add(
      ctx.entities.add({
        id: entityId(id, 'edges'),
        polyline: {
          positions: new CallbackProperty(() => {
            const fr = f();
            if (!fr?.corners) return [];
            const [a, b, c, d] = fr.corners as [Cartesian3, Cartesian3, Cartesian3, Cartesian3];
            const p = fr.position;
            // Tek yol: tepe → köşe → tepe … sonra taban çevresi
            return [p, a, p, b, p, c, p, d, a, b, c, d];
          }, false),
          arcType: ArcType.NONE,
          width: 1.5,
          material: color(coneColor, 0.85),
        },
      }),
      true,
    );
    add(
      ctx.entities.add({
        id: entityId(id, 'axis'),
        polyline: {
          positions: new CallbackProperty(() => {
            const fr = f();
            return fr?.center ? [fr.position, fr.center] : [];
          }, false),
          arcType: ArcType.NONE,
          width: 2,
          material: Color.fromCssColorString('#ff5050').withAlpha(0.9),
        },
      }),
      true,
    );
  };

  const destroy = (handle: Handle, ctx: CesiumRenderContext) => {
    for (const entity of handle.entities) {
      ctx.disown(entity);
      ctx.entities.remove(entity);
    }
    handle.entities = [];
  };

  // ── Yüzeyler: tüm İHA'ların koni yüzleri + izleri TEK primitive'de, her karede ──
  // Entity poligonu her karede baştan üçgenlenir (PolygonGeometry: alt bölme, normaller) ve İHA başına
  // 5 ayrı primitive olur: 6 İHA'da kare hızı 58'den 28'e iniyordu (ölçüldü). Burada ham üçgen —
  // İHA başına 6 (4 koni yüzü + iz dörtgeni), hepsi tek Primitive, eşzamanlı (aynı karede) kurulur.
  const live = new Set<Handle>();
  let surfaces: Primitive | null = null;
  let surfaceCtx: CesiumRenderContext | null = null;
  let detachUpdate: (() => void) | null = null;

  const triangles = (points: Cartesian3[], indices: number[]): Geometry => {
    const values = new Float64Array(points.length * 3);
    points.forEach((p, i) => values.set([p.x, p.y, p.z], i * 3));
    return new Geometry({
      attributes: {
        position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values }),
      } as unknown as GeometryAttributes,
      indices: new Uint16Array(indices),
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: BoundingSphere.fromPoints(points),
    });
  };

  const rebuildSurfaces = () => {
    const ctx = surfaceCtx;
    if (!ctx) return;
    const instances: GeometryInstance[] = [];
    for (const handle of live) {
      const fr = compute(handle, ctx);
      if (!fr?.corners) continue;
      const [a, b, c, d] = fr.corners as [Cartesian3, Cartesian3, Cartesian3, Cartesian3];
      const instance = (geometry: Geometry, alpha: number) =>
        new GeometryInstance({
          id: handle.id, // hit-test: unsurun kendisi
          geometry,
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(coneColor.withAlpha(alpha * handle.opacity)) },
        });
      instances.push(instance(triangles([fr.position, a, b, c, d], [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]), coneOpacity));
      instances.push(instance(triangles([a, b, c, d], [0, 1, 2, 0, 2, 3]), footprintOpacity));
    }
    if (surfaces) ctx.primitives.remove(surfaces); // yok eder
    surfaces =
      instances.length === 0
        ? null
        : (ctx.primitives.add(
            new Primitive({
              geometryInstances: instances,
              // flat: normal yok (yalnız konum); closed: false → iki yüz de çizilir
              appearance: new PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
              asynchronous: false,
              compressVertices: false,
            }),
          ) as Primitive);
  };

  return {
    init(ctx) {
      surfaceCtx = ctx;
      // Unsur güncellemelerinden (DataSourceDisplay) sonra, primitive'ler güncellenmeden önce
      detachUpdate = ctx.scene.preUpdate.addEventListener(rebuildSurfaces);
    },

    destroy(ctx) {
      detachUpdate?.();
      detachUpdate = null;
      if (surfaces) ctx.primitives.remove(surfaces);
      surfaces = null;
      surfaceCtx = null;
      live.clear();
    },

    create(rf, ctx, state) {
      if (!uavPropsOf(rf.feature) || rf.feature.geometry.kind !== 'point') return null;
      const t = now();
      const handle: Handle = {
        id: rf.feature.id,
        from: rf.feature,
        to: rf.feature,
        t0: t,
        durationMs: 0,
        lastMessageAt: t,
        opacity: rf.opacity,
        state,
        frame: null,
        frameAt: -1,
        entities: [],
      };
      build(handle, ctx);
      live.add(handle);
      return handle;
    },

    update(handle, rf, ctx, state) {
      if (!uavPropsOf(rf.feature) || rf.feature.geometry.kind !== 'point') return null;
      const t = now();
      const opacityChanged = handle.opacity !== rf.opacity;
      handle.state = state;
      handle.opacity = rf.opacity;
      if (rf.feature !== handle.to) {
        // Yeni mesaj: o anki ara hâlden yeni hedefe, ölçülen mesaj aralığı boyunca kay.
        const interval = t - handle.lastMessageAt;
        const progress = handle.durationMs > 0 ? Math.min((t - handle.t0) / handle.durationMs, 1) : 1;
        handle.from = glide && progress < 1 ? interpolateUav(handle.from, handle.to, progress) : handle.to;
        handle.to = rf.feature;
        handle.t0 = t;
        handle.durationMs = glide ? Math.min(Math.max(interval > 0 && interval < 5000 ? interval : DEFAULT_GLIDE_MS, 50), 2000) : 0;
        handle.lastMessageAt = t;
        handle.frame = null;
      }
      // Sabit malzemeler opaklığı kurulumda alır: değişince parçalar baştan.
      if (opacityChanged) {
        destroy(handle, ctx);
        build(handle, ctx);
      }
    },

    remove(handle, ctx) {
      live.delete(handle);
      destroy(handle, ctx);
    },

    setState(handle, state) {
      handle.state = state; // siluet CallbackProperty ile okunur
    },
  };
}

export type { UavProps };
