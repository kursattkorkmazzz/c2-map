// ── `vector` kind: çizgi, poligon, nokta (kontrol tedbirleri, çizimler) ──
// Cesium Entity API ile: poligon / çizgi araziye giydirilir (clampToGround → GroundPrimitive),
// nokta zemine oturur. Daire, elips, koridor, dikdörtgen çekirdeğin jeodezik `shapeRings`'iyle
// poligona çevrilir (MapLibre ile aynı sonuç).
//
// Araziye giydirilen poligon çerçeve çizemez (Cesium sınırı): çerçeve ayrı bir zemin çizgisi.
// Sıra: `zIndex` (zemin geometrileri arasında; MapSync'in global sırası).
//
// Bu kind seyrek değişir (onlarca–binlerce unsur): güncellemede entity'ler baştan kurulur
// (seçim / opaklık yalnız renkleri değiştirir).

import { GEOMETRY_KIND, RENDER_CHANGE, shapeRings, type Feature, type Geometry, type LngLat, type RenderFeature } from '@c2/map-core';
import {
  Cartesian3,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  HeightReference,
  PolygonHierarchy,
  type Entity,
} from 'cesium';
import { entityId, HOVER_COLOR, SELECTED_COLOR, type CesiumKindRenderer, type CesiumRenderContext, type FullVisualState } from './types';

export type VectorStyle = {
  fillColor?: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  pointColor?: string;
  pointRadius?: number;
};

export const VECTOR_DEFAULTS: Required<VectorStyle> = {
  fillColor: '#3d8bfd',
  fillOpacity: 0.2,
  strokeColor: '#3d8bfd',
  strokeWidth: 2,
  strokeOpacity: 1,
  pointColor: '#3d8bfd',
  pointRadius: 5,
};

/** Geometrinin çizilecek parçaları (çoklu geometriler ve şekiller açılır). */
export type VectorParts = {
  polygons: (readonly (readonly LngLat[])[])[];
  lines: (readonly LngLat[])[];
  points: LngLat[];
};

export function vectorParts(geometry: Geometry): VectorParts {
  const parts: VectorParts = { polygons: [], lines: [], points: [] };
  switch (geometry.kind) {
    case GEOMETRY_KIND.POINT:
      parts.points.push(geometry.coord);
      break;
    case GEOMETRY_KIND.MULTI_POINT:
      parts.points.push(...geometry.coords);
      break;
    case GEOMETRY_KIND.LINE:
      parts.lines.push(geometry.coords);
      break;
    case GEOMETRY_KIND.MULTI_LINE:
      parts.lines.push(...geometry.lines);
      break;
    case GEOMETRY_KIND.POLYGON:
      parts.polygons.push(geometry.rings);
      break;
    case GEOMETRY_KIND.MULTI_POLYGON:
      parts.polygons.push(...geometry.polygons);
      break;
    default: {
      const rings = shapeRings(geometry);
      if (rings) parts.polygons.push(rings);
    }
  }
  return parts;
}

const positions = (coords: readonly LngLat[]) => coords.map((c) => Cartesian3.fromDegrees(c[0], c[1], c[2] ?? 0));

/** Kapalı halka (ilk = son) Cesium'a açık verilir: son nokta tekrarlanmaz. */
const openRing = (ring: readonly LngLat[]) => {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first && last && ring.length > 1 && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
};

const hierarchyOf = (rings: readonly (readonly LngLat[])[]) =>
  new PolygonHierarchy(
    positions(openRing(rings[0] ?? [])),
    rings.slice(1).map((hole) => new PolygonHierarchy(positions(openRing(hole)))),
  );

type Handle = { entities: Entity[]; fills: Entity[]; strokes: Entity[]; points: Entity[]; style: Required<VectorStyle>; opacity: number };

const styleOf = (feature: Feature): Required<VectorStyle> => ({ ...VECTOR_DEFAULTS, ...(feature.style as VectorStyle | undefined) });

function paint(handle: Handle, state: FullVisualState): void {
  const { style, opacity } = handle;
  const highlight = state.selected ? SELECTED_COLOR : state.hovered ? HOVER_COLOR : null;
  const stroke = Color.fromCssColorString(highlight ?? style.strokeColor).withAlpha(style.strokeOpacity * opacity);
  const width = style.strokeWidth + (highlight ? 1.5 : 0);
  const fill = Color.fromCssColorString(style.fillColor).withAlpha(style.fillOpacity * opacity * (state.hovered ? 1.4 : 1));
  for (const e of handle.fills) e.polygon!.material = new ColorMaterialProperty(fill);
  for (const e of handle.strokes) {
    e.polyline!.material = new ColorMaterialProperty(stroke);
    e.polyline!.width = new ConstantProperty(width);
  }
  const point = Color.fromCssColorString(style.pointColor).withAlpha(opacity);
  for (const e of handle.points) {
    e.point!.color = new ConstantProperty(point);
    e.point!.outlineColor = new ConstantProperty(Color.fromCssColorString(highlight ?? '#ffffff').withAlpha(opacity));
    e.point!.pixelSize = new ConstantProperty(style.pointRadius * 2 + (highlight ? 3 : 0));
  }
}

function build(rf: RenderFeature, ctx: CesiumRenderContext, state: FullVisualState): Handle {
  const id = rf.feature.id;
  const handle: Handle = { entities: [], fills: [], strokes: [], points: [], style: styleOf(rf.feature), opacity: rf.opacity };
  const add = (entity: Entity, bucket: Entity[]) => {
    ctx.own(entity, id);
    handle.entities.push(entity);
    bucket.push(entity);
  };
  const parts = vectorParts(rf.feature.geometry);
  const zIndex = new ConstantProperty(rf.zIndex);
  let n = 0;
  for (const rings of parts.polygons) {
    if (!rings[0] || rings[0].length < 3) continue;
    add(ctx.entities.add({ id: entityId(id, n++), polygon: { hierarchy: hierarchyOf(rings), zIndex } }), handle.fills);
    for (const ring of rings) {
      add(ctx.entities.add({ id: entityId(id, n++), polyline: { positions: positions(ring), clampToGround: true, zIndex } }), handle.strokes);
    }
  }
  for (const line of parts.lines) {
    if (line.length < 2) continue;
    add(ctx.entities.add({ id: entityId(id, n++), polyline: { positions: positions(line), clampToGround: true, zIndex } }), handle.strokes);
  }
  for (const p of parts.points) {
    add(
      ctx.entities.add({
        id: entityId(id, n++),
        position: Cartesian3.fromDegrees(p[0], p[1], 0),
        point: { heightReference: HeightReference.CLAMP_TO_GROUND, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }),
      handle.points,
    );
  }
  paint(handle, state);
  return handle;
}

function destroy(handle: Handle, ctx: CesiumRenderContext): void {
  for (const e of handle.entities) {
    ctx.disown(e);
    ctx.entities.remove(e);
  }
}

export const vectorRenderer: CesiumKindRenderer<Handle> = {
  create: build,
  update(handle, rf, ctx, state) {
    // Yalnız opaklık / sıra değiştiyse renkler yeterli; geometri / stil değişince baştan.
    const structural = rf.changed & ~RENDER_CHANGE.OPACITY;
    if (structural === 0) {
      handle.opacity = rf.opacity;
      paint(handle, state);
      return;
    }
    destroy(handle, ctx);
    return build(rf, ctx, state);
  },
  remove: destroy,
  setState(handle, state) {
    paint(handle, state);
  },
};
