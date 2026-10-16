// ── Çizim önizlemesi (Cesium) ────────────────────────────────────
// Tasarım: plan/design/09-interaction-and-editing.md#çizim-mimarisi-öneri
//
// Araçlar çekirdekte (DrawController / EditController); adapter yalnız önizlemeyi çizer. Önizleme
// store'a girmez ve imleç hızında değişir: entity'ler BİR KEZ kurulur, yalnız değer DEĞİŞİNCE yazılır.
// `CallbackProperty` KULLANILMAZ: araziye giydirilmiş dinamik şekil her karede baştan üçgenlenir
// (ölçüldü: çizim sürerken 26 → 6 FPS). Sabit değerde Cesium yeniden üretimi Worker'da yapar ve yenisi
// hazır olana kadar eskisini gösterir; imleç dururken hiç maliyet yok.
//
//   şekil    → araziye giydirilmiş dolgu + kesikli çizgi
//   kılavuz  → beyaz kesikli çizgiler (yarıçap, elips eksenleri)
//   köşe / ara nokta / tutulan tutamaç → zemine oturan noktalar (havuz: gerektikçe büyür)

import { GEOMETRY_KIND, type DrawPreview, type LngLat } from '@c2/map-core';
import {
  Cartesian3,
  Color,
  ConstantPositionProperty,
  ConstantProperty,
  CustomDataSource,
  HeightReference,
  PolygonHierarchy,
  PolylineDashMaterialProperty,
  type Entity,
} from 'cesium';
import { vectorParts } from './renderers/vector';

const COLOR = Color.fromCssColorString('#ffcc00');
const MAX_GUIDES = 4;

type Shape = { fill: Cartesian3[] | null; lines: Cartesian3[][] };

const toPositions = (coords: readonly LngLat[]) => coords.map((c) => Cartesian3.fromDegrees(c[0], c[1], 0));

function shapeOf(preview: DrawPreview | null): Shape {
  const shape: Shape = { fill: null, lines: [] };
  const geometry = preview?.shape;
  if (!geometry) return shape;
  const parts = vectorParts(geometry);
  const ring = parts.polygons[0]?.[0];
  if (ring && ring.length >= 3) {
    shape.fill = toPositions(ring);
    shape.lines.push(toPositions(ring[0] === ring[ring.length - 1] ? ring : [...ring, ring[0]!]));
  }
  for (const line of parts.lines) if (line.length >= 2) shape.lines.push(toPositions(line));
  // Nokta aracı: yalnız köşe noktası görünür (vertices).
  if (geometry.kind === GEOMETRY_KIND.POINT) shape.lines = [];
  return shape;
}

export class CesiumDrawPreview {
  readonly dataSource = new CustomDataSource('c2-draw-preview');
  private readonly fill: Entity;
  private readonly lines: Entity[] = [];
  private readonly guides: Entity[] = [];
  private readonly points: Entity[] = [];
  /** Son yazılan değerlerin anahtarı (değişmeyeni tekrar yazmamak için). */
  private readonly written = new Map<Entity, string>();

  constructor() {
    const entities = this.dataSource.entities;
    this.fill = entities.add({
      id: 'c2-draw-fill',
      polygon: {
        hierarchy: new ConstantProperty(new PolygonHierarchy([])),
        material: COLOR.withAlpha(0.15),
        // Sıra: kullanıcı katmanlarının hep üstünde
        zIndex: 1_000_000_000,
      },
    });
    // Şekil çizgisi (dikdörtgen / daire çevresi veya çizgi) — en fazla iki parça (halka + açık çizgi)
    for (let i = 0; i < 2; i++) {
      this.lines[i] = entities.add({
        id: `c2-draw-line-${i}`,
        polyline: {
          positions: new ConstantProperty([]),
          clampToGround: true,
          width: 2,
          material: new PolylineDashMaterialProperty({ color: COLOR, dashLength: 12 }),
          zIndex: 1_000_000_000,
        },
      });
    }
    for (let i = 0; i < MAX_GUIDES; i++) {
      this.guides[i] = entities.add({
        id: `c2-draw-guide-${i}`,
        polyline: {
          positions: new ConstantProperty([]),
          clampToGround: true,
          width: 1,
          material: new PolylineDashMaterialProperty({ color: Color.WHITE.withAlpha(0.8), dashLength: 8 }),
          zIndex: 1_000_000_000,
        },
      });
    }
  }

  set(preview: DrawPreview | null): void {
    const shape = shapeOf(preview);
    this.write(this.fill, shape.fill, (p) => (this.fill.polygon!.hierarchy = new ConstantProperty(new PolygonHierarchy(p))));
    this.lines.forEach((entity, i) =>
      this.write(entity, shape.lines[i] ?? null, (p) => (entity.polyline!.positions = new ConstantProperty(p))),
    );
    const guides = (preview?.guides ?? []).filter((g) => g.length >= 2).map(toPositions);
    this.guides.forEach((entity, i) =>
      this.write(entity, guides[i] ?? null, (p) => (entity.polyline!.positions = new ConstantProperty(p))),
    );

    // Noktalar: köşe (beyaz), ara nokta (küçük sarı), tutulan (büyük sarı)
    const wanted: { coord: LngLat; size: number; color: Color; outline: Color }[] = [];
    for (const v of preview?.vertices ?? []) wanted.push({ coord: v, size: 9, color: Color.WHITE, outline: COLOR });
    for (const m of preview?.midpoints ?? []) wanted.push({ coord: m, size: 7, color: COLOR.withAlpha(0.6), outline: Color.WHITE });
    if (preview?.active) wanted.push({ coord: preview.active, size: 14, color: COLOR, outline: Color.WHITE });

    while (this.points.length < wanted.length) {
      this.points.push(
        this.dataSource.entities.add({
          id: `c2-draw-point-${this.points.length}`,
          position: new ConstantPositionProperty(Cartesian3.ZERO),
          point: {
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            outlineWidth: 2,
          },
        }),
      );
    }
    this.points.forEach((entity, i) => {
      const w = wanted[i];
      entity.show = w !== undefined;
      if (!w) return;
      (entity.position as ConstantPositionProperty).setValue(Cartesian3.fromDegrees(w.coord[0], w.coord[1], 0));
      entity.point!.pixelSize = new ConstantProperty(w.size);
      entity.point!.color = new ConstantProperty(w.color);
      entity.point!.outlineColor = new ConstantProperty(w.outline);
    });
  }

  /** Değer değiştiyse yaz; boşsa gizle (boş geometri üretilmez). */
  private write(entity: Entity, positions: Cartesian3[] | null, apply: (positions: Cartesian3[]) => void): void {
    const key = positions ? positions.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`).join(';') : '';
    if (this.written.get(entity) === key) return;
    this.written.set(entity, key);
    entity.show = positions !== null;
    if (positions) apply(positions);
  }
}
