// ── İHA (composite) renderer'ı — deck.gl ──────────────────────────
// Tasarım: plan/design/08-extensibility-symbology.md#composite-unsur-iha
//
// Store'da TEK unsur (kind: 'uav', geometri: nokta, props: yön / irtifa / sensör). Bu renderer o
// unsurdan birden çok görsel parça üretir:
//
//   model     3B glTF (ScenegraphLayer)          konum + irtifa + burun yönü
//   koni      4 yarı saydam üçgen (3B)           tepe İHA'da, taban görüş alanının zemindeki izi
//   iz        zemindeki dörtgen
//   çizgiler  koni kenarları, bakış ekseni, İHA'dan zemine dikey çizgi
//   etiket    çağrı adı + irtifa
//
// Sensör izinin hesabı çekirdekte (`sensorFootprint`, motor bilmez); burada yalnız çizim.
// Backend yalnız unsuru günceller; her güncellemede parçalar yeniden üretilir (onlarca İHA için ucuz).

import { sensorFootprint, type Feature, type LngLat, type RenderFeature, type SensorParams } from '@c2/map-core';
import type { DeckLayersContext, DeckLayersRenderer } from './deck-controller';

/** `kind: 'uav'` unsurunun props'u. */
export type UavProps = {
  /** Burun yönü: derece, kuzeyden saat yönünde. */
  headingDeg: number;
  /** Yerden yükseklik (m). */
  altitudeM: number;
  /** Kamera / gimbal. Yoksa koni çizilmez. */
  sensor?: SensorParams;
  /** Etiket (ör. çağrı adı). */
  callsign?: string;
};

type Rgba = [number, number, number, number];

export type UavRendererOptions = {
  /** glTF / GLB model adresi. */
  modelUrl: string;
  /** Model birimi → metre çarpanı (ör. 1,8 birimlik kanat × 8 ≈ 15 m). Varsayılan 8. */
  modelScale?: number;
  /** Uzaktan da görünsün: modelin ekrandaki en küçük boyu (px). Varsayılan 40. */
  minPixels?: number;
  /**
   * Modelin kendi "ileri" ekseni ile kuzey arasındaki fark (derece). glTF'de burun +Z ise 0;
   * model farklı yöne bakıyorsa düzeltilir.
   */
  yawOffsetDeg?: number;
  modelColor?: Rgba;
  coneColor?: Rgba;
  footprintColor?: Rgba;
  lineColor?: Rgba;
  /** Etiket gösterilsin mi (varsayılan `true`). */
  labels?: boolean;
};

type DeckLayerClass = new (props: Record<string, unknown>) => unknown;
type Classes = {
  ScenegraphLayer: DeckLayerClass;
  SolidPolygonLayer: DeckLayerClass;
  LineLayer: DeckLayerClass;
  TextLayer: DeckLayerClass;
  GLTFLoader: unknown;
};

type UavDatum = {
  featureId: string;
  position: [number, number, number];
  ground: [number, number, number];
  headingDeg: number;
  opacity: number;
  label: string;
};
type Face = { featureId: string; polygon: number[][] };
type Segment = { featureId: string; from: number[]; to: number[]; kind: 'edge' | 'axis' | 'stem' };

/** Zeminle z-çakışmasını (titreme) önlemek için iz zeminden biraz yukarıda. */
const GROUND_Z = 2;

export function uavRenderer(options: UavRendererOptions): DeckLayersRenderer {
  const scale = options.modelScale ?? 8;
  const minPixels = options.minPixels ?? 40;
  const yawOffset = options.yawOffsetDeg ?? 0;
  const modelColor = options.modelColor ?? [235, 235, 235, 255];
  const coneColor = options.coneColor ?? [255, 204, 0, 45];
  const footprintColor = options.footprintColor ?? [255, 204, 0, 70];
  const lineColor = options.lineColor ?? [255, 204, 0, 220];
  let classes: Classes | null = null;

  return {
    type: 'layers',

    async load() {
      const [mesh, layers, gltf] = await Promise.all([
        import('@deck.gl/mesh-layers'),
        import('@deck.gl/layers'),
        import('@loaders.gl/gltf'),
      ]);
      classes = {
        ScenegraphLayer: mesh.ScenegraphLayer as unknown as DeckLayerClass,
        SolidPolygonLayer: layers.SolidPolygonLayer as unknown as DeckLayerClass,
        LineLayer: layers.LineLayer as unknown as DeckLayerClass,
        TextLayer: layers.TextLayer as unknown as DeckLayerClass,
        GLTFLoader: gltf.GLTFLoader,
      };
    },

    layers(features: readonly RenderFeature[], ctx: DeckLayersContext): unknown[] {
      if (!classes) return []; // load() beklenmeden çağrıldı
      const { ScenegraphLayer, SolidPolygonLayer, LineLayer, TextLayer, GLTFLoader } = classes;

      const uavs: UavDatum[] = [];
      const faces: Face[] = [];
      const footprints: Face[] = [];
      const segments: Segment[] = [];

      for (const rf of features) {
        const props = uavPropsOf(rf.feature);
        const at = pointOf(rf.feature);
        if (!props || !at) continue;
        const id = rf.feature.id;
        const position: [number, number, number] = [at[0], at[1], props.altitudeM];
        const ground: [number, number, number] = [at[0], at[1], 0];
        uavs.push({
          featureId: id,
          position,
          ground,
          headingDeg: props.headingDeg,
          opacity: rf.opacity,
          label: `${props.callsign ?? id}\n${Math.round(props.altitudeM)} m`,
        });
        segments.push({ featureId: id, from: ground, to: position, kind: 'stem' });

        if (props.sensor) {
          const fp = sensorFootprint(at, props.altitudeM, props.headingDeg, props.sensor);
          const apex = [...fp.apex];
          const base = fp.corners.map((c) => [c[0], c[1], GROUND_Z]);
          for (let i = 0; i < 4; i++) {
            faces.push({ featureId: id, polygon: [apex, base[i]!, base[(i + 1) % 4]!] });
            segments.push({ featureId: id, from: apex, to: base[i]!, kind: 'edge' });
            segments.push({ featureId: id, from: base[i]!, to: base[(i + 1) % 4]!, kind: 'edge' });
          }
          footprints.push({ featureId: id, polygon: base });
          segments.push({ featureId: id, from: apex, to: [fp.center[0], fp.center[1], GROUND_Z], kind: 'axis' });
        }
      }

      const common = { beforeId: ctx.beforeId };
      // Yarı saydam yüzeyler derinliğe yazmaz: birbirini / modeli kesip "delik" bırakmasın.
      const translucent = { depthWriteEnabled: false };

      const layers: unknown[] = [
        new SolidPolygonLayer({
          ...common,
          id: `${ctx.idPrefix}-footprint`,
          data: footprints,
          getPolygon: (d: Face) => d.polygon,
          getFillColor: footprintColor,
          parameters: translucent,
          pickable: true,
        }),
        new SolidPolygonLayer({
          ...common,
          id: `${ctx.idPrefix}-cone`,
          data: faces,
          getPolygon: (d: Face) => d.polygon,
          getFillColor: coneColor,
          _full3d: true, // dikey / eğik üçgenler 3B olarak bölünsün
          parameters: translucent,
          pickable: false,
        }),
        new LineLayer({
          ...common,
          id: `${ctx.idPrefix}-lines`,
          data: segments,
          getSourcePosition: (d: Segment) => d.from,
          getTargetPosition: (d: Segment) => d.to,
          getColor: (d: Segment) => (d.kind === 'stem' ? [255, 255, 255, 140] : d.kind === 'axis' ? [255, 80, 80, 230] : lineColor),
          getWidth: (d: Segment) => (d.kind === 'edge' ? 1.5 : 2),
          widthUnits: 'pixels',
          pickable: false,
        }),
        new ScenegraphLayer({
          ...common,
          id: `${ctx.idPrefix}-model`,
          data: uavs,
          scenegraph: options.modelUrl,
          loaders: [GLTFLoader],
          getPosition: (d: UavDatum) => d.position,
          // [pitch, yaw, roll]: roll 90 glTF'in Y-yukarısını haritanın Z-yukarısına çevirir; yaw saat
          // yönünün tersidir. 180: bu dönüşümde glTF +Z (burun) kuzeyin tersine düşer (tarayıcıda doğrulandı).
          getOrientation: (d: UavDatum) => [0, 180 + yawOffset - d.headingDeg, 90],
          getColor: (d: UavDatum) => [modelColor[0], modelColor[1], modelColor[2], Math.round(modelColor[3] * d.opacity)],
          sizeScale: scale,
          sizeMinPixels: minPixels,
          _lighting: 'pbr',
          pickable: true,
        }),
      ];
      if (options.labels !== false) {
        layers.push(
          new TextLayer({
            ...common,
            id: `${ctx.idPrefix}-label`,
            data: uavs,
            getPosition: (d: UavDatum) => d.position,
            getText: (d: UavDatum) => d.label,
            getSize: 12,
            getColor: [255, 255, 255, 255],
            getPixelOffset: [0, -34],
            outlineWidth: 2,
            outlineColor: [0, 0, 0, 200],
            fontSettings: { sdf: true },
            characterSet: 'auto',
            pickable: false,
          }),
        );
      }
      return layers;
    },
  };
}

function uavPropsOf(feature: Feature): UavProps | null {
  const p = feature.props as Partial<UavProps> | undefined;
  if (!p || typeof p.headingDeg !== 'number' || typeof p.altitudeM !== 'number') return null;
  return p as UavProps;
}

function pointOf(feature: Feature): LngLat | null {
  return feature.geometry.kind === 'point' ? feature.geometry.coord : null;
}
