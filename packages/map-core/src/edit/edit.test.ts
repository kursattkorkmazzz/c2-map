import { describe, expect, it, vi } from "vitest";
import { ACTION_RESULT, FeatureActions, type FeatureLifecycle } from "../actions/feature-actions";
import { MockAdapter } from "../adapter/mock-adapter";
import { EventRouter, MAP_EVENT } from "../events/event-router";
import { distance } from "../geo/geodesic";
import type { Feature } from "../model/feature";
import type { Geometry, LngLat } from "../model/geometry";
import { createMapStore } from "../store/map-store";
import { MapSync } from "../sync/map-sync";
import { createManualScheduler } from "../sync/scheduler";
import { EditController } from "./edit-controller";
import { handlesOf, moveHandle, removeHandle } from "./handles";

const A: LngLat = [32, 39];
const B: LngLat = [32.1, 39];
const C: LngLat = [32.1, 39.1];

const line: Geometry = { kind: "line", coords: [A, B, C] };
const square: Geometry = { kind: "polygon", rings: [[A, B, C, [32, 39.1], A]] };

describe("tutamaçlar", () => {
  it("çizgi: köşeler + ara noktalar; köşe taşı; ara noktadan köşe ekle; köşe sil (en az 2)", () => {
    const ids = handlesOf(line).map((h) => h.id);
    expect(ids).toEqual(["v:0:0", "v:0:1", "v:0:2", "m:0:0", "m:0:1"]);
    expect(moveHandle(line, "v:0:1", [5, 5])).toEqual({ kind: "line", coords: [A, [5, 5], C] });
    expect(moveHandle(line, "m:0:0", [5, 5])).toEqual({ kind: "line", coords: [A, [5, 5], B, C] });
    expect(removeHandle(line, "v:0:1")).toEqual({ kind: "line", coords: [A, C] });
    expect(removeHandle({ kind: "line", coords: [A, B] }, "v:0:0")).toBeNull();
  });

  it("poligon: halka kapalı kalır; kapanış ara noktası var; en az 3 köşe", () => {
    expect(handlesOf(square).filter((h) => h.kind === "midpoint")).toHaveLength(4);
    const moved = moveHandle(square, "v:0:0", [31.9, 38.9]) as Extract<Geometry, { kind: "polygon" }>;
    expect(moved.rings[0]![0]).toEqual([31.9, 38.9]);
    expect(moved.rings[0]![4]).toEqual([31.9, 38.9]); // kapanış da güncellendi
    const inserted = moveHandle(square, "m:0:3", [31.95, 39.05]) as Extract<Geometry, { kind: "polygon" }>;
    expect(inserted.rings[0]).toHaveLength(6);
    const tri = removeHandle(square, "v:0:3")!;
    expect(removeHandle(tri, "v:0:0")).toBeNull();
  });

  it("daire: merkez taşır, yarıçap tutamacı yarıçapı değiştirir", () => {
    const circle: Geometry = { kind: "circle", center: A, radiusM: 1000 };
    const r = handlesOf(circle).find((h) => h.id === "r")!;
    expect(distance(A, r.coord)).toBeCloseTo(1000, 6);
    expect(moveHandle(circle, "c", B)).toEqual({ kind: "circle", center: B, radiusM: 1000 });
    expect((moveHandle(circle, "r", B) as { radiusM: number }).radiusM).toBeCloseTo(distance(A, B), 6);
    expect(moveHandle(circle, "r", A)).toBeNull(); // sıfır yarıçap
  });

  it("dikdörtgen: köşe taşınınca karşı köşe sabit", () => {
    const rect: Geometry = { kind: "rectangle", min: A, max: C };
    expect(moveHandle(rect, "r:2", [32.3, 39.4])).toEqual({ kind: "rectangle", min: A, max: [32.3, 39.4] });
    expect(moveHandle(rect, "r:0", [32.3, 39.4])).toEqual({ kind: "rectangle", min: C, max: [32.3, 39.4] });
  });

  it("elips: büyük eksen uzunluk + yön, küçük eksen dik bileşen", () => {
    const e: Geometry = { kind: "ellipse", center: A, semiMajorM: 2000, semiMinorM: 500, rotationDeg: 0 };
    const east = moveHandle(e, "a", [32.05, 39]) as Extract<Geometry, { kind: "ellipse" }>;
    expect(east.rotationDeg).toBeCloseTo(90, 1);
    const minor = moveHandle(e, "b", [32.02, 39]) as Extract<Geometry, { kind: "ellipse" }>;
    expect(minor.semiMinorM).toBeCloseTo(distance(A, [32.02, 39]), 0);
    expect(minor.rotationDeg).toBe(0);
  });

  it("koridor: köşeler + genişlik tutamacı", () => {
    const corridor: Geometry = { kind: "corridor", coords: [A, B], widthM: 2000 };
    expect(handlesOf(corridor).map((h) => h.id)).toEqual(["v:0:0", "v:0:1", "m:0:0", "w"]);
    const wider = moveHandle(corridor, "w", [32.05, 39.03]) as { widthM: number };
    expect(wider.widthM).toBeGreaterThan(6000);
  });

  it("çoklu geometriler düzenlenemez", () => {
    expect(handlesOf({ kind: "multi-point", coords: [A] })).toEqual([]);
  });
});

describe("store taslağı", () => {
  const base = (): Feature => ({ id: "f1", layerId: "l", kind: "vector", geometry: line, rev: 3 });

  it("taslak haritada görünür; akış asıl kaydı günceller ama taslak kaymaz; taslak atılınca asıl kayıt", () => {
    const store = createMapStore();
    const adapter = new MockAdapter();
    const scheduler = createManualScheduler();
    const sync = new MapSync({ store, adapter, scheduler });
    store.transaction((tx) => {
      tx.upsertLayers([{ id: "l", name: "l", parentId: null, visible: true, opacity: 1 }]);
      tx.upsertFeatures([base()]);
    });
    sync.start();

    const edited: Geometry = { kind: "line", coords: [A, C] };
    store.transaction((tx) => tx.setDraft({ ...base(), geometry: edited }));
    scheduler.run();
    expect(adapter.features.get("f1")!.feature.geometry).toEqual(edited);
    expect(store.getFeature("f1")!.geometry).toEqual(line); // asıl kayıt değişmedi
    expect(store.getDraft("f1")!.base).toBe(store.getFeature("f1"));

    adapter.takeBatches();
    store.transaction((tx) => tx.upsertFeatures([{ ...base(), geometry: { kind: "line", coords: [B, C] }, rev: 4 }]));
    scheduler.run();
    expect(adapter.takeBatches().flatMap((b) => b.features?.upsert ?? [])).toEqual([]); // haritaya gitmedi
    expect(store.getDraft("f1")!.feature.geometry).toEqual(edited);
    expect(store.getDraft("f1")!.base).not.toBe(store.getFeature("f1")); // çakışma tespit edilebilir

    store.transaction((tx) => tx.clearDraft("f1"));
    scheduler.run();
    expect(adapter.features.get("f1")!.feature.geometry).toEqual({ kind: "line", coords: [B, C] });
  });

  it("taslak açılınca abone haber alır; unsur silinince taslak da gider", () => {
    const store = createMapStore();
    store.transaction((tx) => tx.upsertFeatures([base()]));
    const cb = vi.fn();
    store.subscribeFeature("f1", cb);
    store.transaction((tx) => tx.setDraft(base()));
    expect(cb).toHaveBeenCalledTimes(1);
    store.transaction((tx) => tx.removeFeatures(["f1"]));
    expect(store.getDraft("f1")).toBeUndefined();
    store.transaction((tx) => tx.setDraft(base())); // olmayan unsura taslak yok
    expect(store.getDraft("f1")).toBeUndefined();
  });
});

describe("EditController", () => {
  const setup = (lifecycle: FeatureLifecycle = {}, feature: Partial<Feature> = {}) => {
    const store = createMapStore();
    store.transaction((tx) => {
      tx.upsertLayers([{ id: "l", name: "l", parentId: null, visible: true, opacity: 1 }]);
      tx.upsertFeatures([{ id: "f1", layerId: "l", kind: "vector", geometry: line, rev: 3, ...feature }]);
    });
    const router = new EventRouter(store);
    const adapter = new MockAdapter();
    adapter.project = (c) => ({ x: c[0] * 1000, y: c[1] * 1000 });
    const actions = new FeatureActions(store, lifecycle);
    const edit = new EditController({ store, actions, events: router, adapter });
    const click = (coord: LngLat) => router.emit({ type: MAP_EVENT.CLICK, coord });
    const move = (coord: LngLat) => router.emit({ type: MAP_EVENT.POINTER_MOVE, coord });
    return { store, adapter, actions, edit, click, move };
  };

  it("başlat: taslak + tutamaçlar + çizim modu; izin yoksa başlamaz", () => {
    const { store, adapter, edit } = setup();
    expect(edit.start("f1")).toBe(true);
    expect(store.getDraft("f1")).toBeDefined();
    expect(adapter.drawMode).toBe(true);
    expect(adapter.drawPreview!.vertices).toEqual([A, B, C]);
    expect(adapter.drawPreview!.midpoints).toHaveLength(2);
    expect(edit.getState()).toMatchObject({ featureId: "f1", dirty: false, conflict: false });

    const locked = setup({}, { editable: false });
    expect(locked.edit.start("f1")).toBe(false);
    expect(locked.store.getDraft("f1")).toBeUndefined();
  });

  it("tutamaca tıkla → canlı önizleme → tıkla bırak → taslak; geri al; Esc bırakır", () => {
    const { store, adapter, edit, click, move } = setup();
    edit.start("f1");
    click([32.1001, 39.0001]); // B'ye yakın → tutuldu
    expect(edit.getState()!.picked).toBe(true);
    move([32.2, 39.2]);
    expect(adapter.drawPreview!.shape).toEqual({ kind: "line", coords: [A, [32.2, 39.2], C] });
    expect(store.getDraft("f1")!.feature.geometry).toEqual(line); // bırakılmadan taslak değişmez
    click([32.2, 39.2]);
    expect(store.getDraft("f1")!.feature.geometry).toEqual({ kind: "line", coords: [A, [32.2, 39.2], C] });
    expect(edit.getState()).toMatchObject({ picked: false, dirty: true, canUndo: true });

    edit.undo();
    expect(store.getDraft("f1")!.feature.geometry).toEqual(line);

    click(A);
    edit.key("Escape"); // bırak
    expect(edit.getState()!.picked).toBe(false);
    expect(edit.isEditing).toBe(true);
    edit.key("Escape"); // iptal
    expect(edit.isEditing).toBe(false);
    expect(store.getDraft("f1")).toBeUndefined();
    expect(adapter.drawMode).toBe(false);
  });

  it("ara noktadan köşe ekle; tutulan köşeyi Backspace ile sil", () => {
    const { store, edit, click } = setup();
    edit.start("f1");
    const mid = handlesOf(line).find((h) => h.id === "m:0:0")!.coord;
    click(mid);
    click([32.05, 38.95]);
    expect((store.getDraft("f1")!.feature.geometry as Extract<Geometry, { kind: "line" }>).coords).toHaveLength(4);
    click([32.05, 38.95]); // yeni köşeyi tut
    edit.key("Backspace");
    expect(store.getDraft("f1")!.feature.geometry).toEqual(line);
  });

  it("kaydet: beforeUpdate(next.rev = başlangıç sürümü, prev) → onayda asıl kayıt + taslak kalkar", async () => {
    const beforeUpdate = vi.fn(async () => true);
    const { store, edit, click } = setup({ beforeUpdate });
    edit.start("f1");
    click(B);
    click([32.3, 39.3]);
    await expect(edit.save()).resolves.toBe(ACTION_RESULT.DONE);
    expect(beforeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ rev: 3, geometry: { kind: "line", coords: [A, [32.3, 39.3], C] } }),
      expect.objectContaining({ rev: 3 }),
    );
    expect(store.getFeature("f1")!.geometry).toEqual({ kind: "line", coords: [A, [32.3, 39.3], C] }); // eski rev düşürülmedi
    expect(store.getDraft("f1")).toBeUndefined();
    expect(edit.isEditing).toBe(false);
  });

  it("kaydetme reddedilirse düzenleme sürer, hata gösterilir; hata fırlarsa da", async () => {
    const answers = [false];
    const { store, edit } = setup({
      beforeUpdate: async () => {
        const a = answers.shift();
        if (a === undefined) throw new Error("ağ hatası");
        return a;
      },
    });
    edit.start("f1");
    await expect(edit.save()).resolves.toBe(ACTION_RESULT.REJECTED);
    expect(edit.getState()).toMatchObject({ error: "rejected", saving: false });
    expect(store.getDraft("f1")).toBeDefined();
    await expect(edit.save()).rejects.toThrow("ağ hatası");
    expect(edit.getState()).toMatchObject({ error: "failed" });
  });

  it("düzenleme sürerken akış unsuru güncellerse 'başkası değiştirdi'; silerse kaydedilemez", async () => {
    const { store, edit } = setup();
    edit.start("f1");
    store.transaction((tx) => tx.upsertFeatures([{ id: "f1", layerId: "l", kind: "vector", geometry: { kind: "line", coords: [B, C] }, rev: 4 }]));
    expect(edit.getState()!.conflict).toBe(true);
    store.transaction((tx) => tx.removeFeatures(["f1"]));
    expect(edit.getState()).toMatchObject({ deleted: true });
    await expect(edit.save()).resolves.toBe(ACTION_RESULT.MISSING);
  });

  it("yeni düzenleme öncekini iptal eder", () => {
    const { store, edit } = setup();
    store.transaction((tx) => tx.upsertFeatures([{ id: "f2", layerId: "l", kind: "vector", geometry: line }]));
    edit.start("f1");
    edit.start("f2");
    expect(store.getDraft("f1")).toBeUndefined();
    expect(store.getDraft("f2")).toBeDefined();
  });
});
