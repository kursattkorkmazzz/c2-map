import {
  ALTITUDE_REF,
  FEATURE_CHANGE,
  GEOMETRY_KIND,
  RENDER_CHANGE,
  RENDER_CHANGE_ALL,
  type Feature,
  type RenderFeature,
  type UavProps,
} from '@c2/map-core';
import { Cartographic, Color, JulianDate, Math as CesiumMath, type BillboardCollection, type Billboard, type Cartesian3, type Entity } from 'cesium';
import { describe, expect, it } from 'vitest';
import { testContext } from '../testing/context';
import { billboardRenderer } from './billboard';
import { EMPTY_STATE } from './types';
import { cesiumUavRenderer } from './uav';
import { vectorParts, vectorRenderer } from './vector';

const rf = (feature: Feature, over: Partial<RenderFeature> = {}): RenderFeature => ({
  feature,
  groupId: feature.layerId,
  opacity: 1,
  zIndex: 0,
  changed: RENDER_CHANGE_ALL,
  ...over,
});
const now = () => JulianDate.now();

describe('vectorParts', () => {
  it('çoklu geometriler açılır, şekiller poligona çevrilir', () => {
    expect(vectorParts({ kind: GEOMETRY_KIND.MULTI_POINT, coords: [[0, 0], [1, 1]] }).points).toHaveLength(2);
    expect(vectorParts({ kind: GEOMETRY_KIND.MULTI_LINE, lines: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }).lines).toHaveLength(2);
    const circle = vectorParts({ kind: GEOMETRY_KIND.CIRCLE, center: [32, 39], radiusM: 1000 });
    expect(circle.polygons).toHaveLength(1);
    expect(circle.polygons[0]![0]!.length).toBeGreaterThan(30);
    expect(vectorParts({ kind: GEOMETRY_KIND.CORRIDOR, coords: [[32, 39], [32.1, 39]], widthM: 500 }).polygons).toHaveLength(1);
  });
});

describe('vectorRenderer', () => {
  const polygon = (coords: [number, number][]): Feature => ({
    id: 'p',
    layerId: 'l',
    kind: 'vector',
    geometry: { kind: GEOMETRY_KIND.POLYGON, rings: [coords] },
    style: { fillColor: '#ff0000', fillOpacity: 0.5 },
  });
  const square = polygon([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);

  it('poligon: dolgu + çerçeve, hepsi unsura bağlı (hit-test); kapalı halka açık verilir', () => {
    const ctx = testContext();
    const handle = vectorRenderer.create(rf(square), ctx, EMPTY_STATE)!;
    expect(ctx.entities.values).toHaveLength(2);
    expect([...ctx.owners.values()]).toEqual(['p', 'p']);
    const fill = ctx.entities.values.find((e) => e.polygon)!;
    expect(fill.polygon!.hierarchy!.getValue(now()).positions).toHaveLength(4);
    vectorRenderer.remove(handle, ctx);
    expect(ctx.entities.values).toHaveLength(0);
    expect(ctx.owners.size).toBe(0);
  });

  it("geometri değişince YENİ id'li entity (aynı batch'te aynı id ile sil + ekle eskisini ekranda bırakıyordu)", () => {
    const ctx = testContext();
    const handle = vectorRenderer.create(rf(square), ctx, EMPTY_STATE)!;
    const before = ctx.entities.values.map((e) => e.id);
    ctx.entities.suspendEvents(); // adapter'ın batch'i gibi
    const moved = polygon([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]);
    expect(vectorRenderer.update(handle, rf(moved, { changed: FEATURE_CHANGE.GEOMETRY }), ctx, EMPTY_STATE)).toBeTruthy();
    ctx.entities.resumeEvents();
    const after = ctx.entities.values.map((e) => e.id);
    expect(after).toHaveLength(2);
    for (const id of after) expect(before).not.toContain(id);
  });

  it('yalnız opaklık / seçim: yerinde renk, entity kurulmaz', () => {
    const ctx = testContext();
    const handle = vectorRenderer.create(rf(square), ctx, EMPTY_STATE)!;
    const ids = ctx.entities.values.map((e) => e.id);
    expect(vectorRenderer.update(handle, rf(square, { opacity: 0.5, changed: RENDER_CHANGE.OPACITY }), ctx, EMPTY_STATE)).toBeUndefined();
    expect(ctx.entities.values.map((e) => e.id)).toEqual(ids);
    const fill = ctx.entities.values.find((e) => e.polygon)!;
    expect(fill.polygon!.material!.getValue(now()).color.alpha).toBeCloseTo(0.25, 5); // 0,5 dolgu × 0,5 opaklık
    vectorRenderer.setState!(handle, { ...EMPTY_STATE, selected: true }, ctx);
    const stroke = ctx.entities.values.find((e) => e.polyline)!;
    const color = stroke.polyline!.material!.getValue(now()).color as Color;
    expect(Color.equals(color.withAlpha(1), Color.fromCssColorString('#ffffff'))).toBe(true);
    expect(color.alpha).toBeCloseTo(0.5, 5); // opaklık korunur
  });
});

describe('billboardRenderer', () => {
  const unit = (sidc: string, coord: [number, number]): Feature => ({
    id: 'u1',
    layerId: 'birlikler',
    kind: 'milsym',
    geometry: { kind: GEOMETRY_KIND.POINT, coord },
    props: { sidc },
  });

  it('tek koleksiyon; konum / görüntü / opaklık yalnız değişen bitle güncellenir', () => {
    const asked: string[] = [];
    const renderer = billboardRenderer({
      clampToGround: false, // Node'da sahne yok (araziye oturtma sahne ister)
      image: (f) => {
        const sidc = (f.props as { sidc: string }).sidc;
        asked.push(sidc);
        return { key: sidc, image: `data:${sidc}`, width: 30, height: 24 };
      },
    });
    const ctx = testContext();
    renderer.init!(ctx);
    const collection = ctx.primitives.get(0) as BillboardCollection;
    const handle = renderer.create(rf(unit('A', [32, 39])), ctx, EMPTY_STATE)!;
    const billboard = collection.get(0) as Billboard;
    expect(collection.length).toBe(1);
    expect(ctx.owners.get(billboard)).toBe('u1');
    expect(billboard.width).toBe(30);

    asked.length = 0;
    renderer.update(handle, rf(unit('A', [33, 40]), { changed: FEATURE_CHANGE.GEOMETRY }), ctx, EMPTY_STATE);
    expect(asked).toEqual([]); // yalnız konum değişti: görüntü sorulmaz
    expect(CesiumMath.toDegrees(Cartographic.fromCartesian(billboard.position).longitude)).toBeCloseTo(33, 6);

    renderer.update(handle, rf(unit('B', [33, 40]), { changed: FEATURE_CHANGE.PROPS }), ctx, EMPTY_STATE);
    expect(asked).toEqual(['B']);
    renderer.update(handle, rf(unit('B', [33, 40]), { opacity: 0.3, changed: RENDER_CHANGE.OPACITY }), ctx, EMPTY_STATE);
    expect(billboard.color.alpha).toBeCloseTo(0.3, 5);

    renderer.remove(handle, ctx);
    expect(collection.length).toBe(0);
    expect(ctx.owners.size).toBe(0);
  });

  it('görüntüsü olmayan unsur çizilmez', () => {
    const ctx = testContext();
    const none = billboardRenderer({ image: () => undefined, clampToGround: false });
    none.init!(ctx);
    expect(none.create(rf(unit('A', [0, 0])), ctx, EMPTY_STATE)).toBeNull();
  });
});

describe('cesiumUavRenderer', () => {
  const uav = (coord: readonly number[], props: Partial<UavProps> = {}): Feature => ({
    id: 'iha-1',
    layerId: 'ihalar',
    kind: 'uav',
    geometry: { kind: GEOMETRY_KIND.POINT, coord: coord as [number, number] },
    props: { headingDeg: 90, altitudeM: 3000, sensor: { panDeg: 0, tiltDeg: 45, hfovDeg: 20, vfovDeg: 15 }, ...props },
  });
  const heightOf = (entity: Entity) => Cartographic.fromCartesian(entity.position!.getValue(now()) as Cartesian3).height;
  const modelOf = (ctx: ReturnType<typeof testContext>) => ctx.entities.values.find((e) => e.model)!;

  it('irtifa referansı: deniz seviyesinden aynen, yerden yükseklik zemine eklenir', () => {
    const renderer = cesiumUavRenderer({ modelUrl: 'm.glb', glide: false });
    const ctx = testContext();
    renderer.init!(ctx);
    ctx.ground.height = 1000;
    const handle = renderer.create(rf(uav([32, 39, 3000], { altitudeRef: ALTITUDE_REF.SEA })), ctx, EMPTY_STATE)!;
    expect(heightOf(modelOf(ctx))).toBeCloseTo(3000, 3);
    ctx.frame.n++;
    renderer.update(handle, rf(uav([32, 39], { altitudeRef: ALTITUDE_REF.GROUND })), ctx, EMPTY_STATE);
    expect(heightOf(modelOf(ctx))).toBeCloseTo(4000, 3); // zemin 1000 + 3000
    // Tüm parçalar unsura bağlı: hangisine tıklanırsa İHA seçilir
    expect(new Set(ctx.owners.values())).toEqual(new Set(['iha-1']));
  });

  it('akıcı hareket: yeni mesajda eski konumdan yenisine, ölçülen mesaj aralığı boyunca; aynı karede tek hesap', () => {
    let t = 0;
    const realNow = performance.now.bind(performance);
    performance.now = () => t;
    try {
      const renderer = cesiumUavRenderer({ modelUrl: 'm.glb' });
      const ctx = testContext();
      renderer.init!(ctx);
      const sea = { altitudeRef: ALTITUDE_REF.SEA } as const;
      const handle = renderer.create(rf(uav([32, 39, 3000], { ...sea, altitudeM: 3000 })), ctx, EMPTY_STATE)!;
      t = 200; // 5 Hz
      renderer.update(handle, rf(uav([32, 39, 3200], { ...sea, altitudeM: 3200 })), ctx, EMPTY_STATE);
      ctx.frame.n++;
      expect(heightOf(modelOf(ctx))).toBeCloseTo(3000, 3); // kayma başı
      t = 300;
      expect(heightOf(modelOf(ctx))).toBeCloseTo(3000, 3); // aynı kare: önbellekten
      ctx.frame.n++;
      expect(heightOf(modelOf(ctx))).toBeCloseTo(3100, 3); // yarısı
      t = 450;
      ctx.frame.n++;
      expect(heightOf(modelOf(ctx))).toBeCloseTo(3200, 3); // süre doldu: hedef
    } finally {
      performance.now = realNow;
    }
  });

  it("koni + iz tek primitive'de (her karede); unsur kaldırılınca temizlenir", () => {
    const renderer = cesiumUavRenderer({ modelUrl: 'm.glb', glide: false });
    const ctx = testContext();
    renderer.init!(ctx);
    const handle = renderer.create(rf(uav([32, 39, 3000], { altitudeRef: ALTITUDE_REF.SEA })), ctx, EMPTY_STATE)!;
    ctx.scene.preUpdate.raiseEvent(ctx.scene);
    expect(ctx.primitives.length).toBe(1);
    renderer.remove(handle, ctx);
    ctx.scene.preUpdate.raiseEvent(ctx.scene);
    expect(ctx.primitives.length).toBe(0);
    expect(ctx.entities.values).toHaveLength(0);
  });
});
