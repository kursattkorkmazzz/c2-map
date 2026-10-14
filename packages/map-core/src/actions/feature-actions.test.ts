import { describe, expect, it, vi } from "vitest";
import type { Feature } from "../model/feature";
import type { Layer } from "../model/layer";
import { createMapStore } from "../store/map-store";
import { FEATURE_CHANGE } from "../store/change";
import { diffFeature } from "../store/diff";
import { stabilizeFeature } from "../store/stabilize";
import { ACTION_RESULT, FeatureActions, type FeatureLifecycle } from "./feature-actions";

const layer = (id: string, over: Partial<Layer> = {}): Layer => ({ id, name: id, parentId: null, visible: true, opacity: 1, ...over });
const feature = (id: string, layerId: string, over: Partial<Feature> = {}): Feature => ({
  id,
  layerId,
  kind: "vector",
  geometry: { kind: "point", coord: [32, 39] },
  ...over,
});

/** Elle çözülen söz: "backend cevabı" testte ne zaman gelecekse o zaman. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function setup(lifecycle: FeatureLifecycle = {}) {
  const store = createMapStore();
  store.transaction((tx) => {
    tx.upsertLayers([
      layer("birlikler", { editable: false, deletable: false }),
      layer("harekat"),
      layer("kontrol", { parentId: "harekat" }),
      layer("cizimler"),
    ]);
    tx.upsertFeatures([feature("u1", "birlikler"), feature("k1", "kontrol"), feature("c1", "cizimler")]);
  });
  return { store, actions: new FeatureActions(store, lifecycle) };
}

describe("izinler (bayraklar)", () => {
  it("varsayılan açık; açıkça false kapatır; katman zinciri miras", () => {
    const { store, actions } = setup();
    expect(actions.permissions("c1")).toEqual({ canEdit: true, canDelete: true, pending: false });
    expect(actions.permissions("u1")).toMatchObject({ canEdit: false, canDelete: false });

    store.transaction((tx) => tx.patchLayer("harekat", { deletable: false })); // üst katman
    expect(actions.permissions("k1")).toMatchObject({ canEdit: true, canDelete: false });

    store.transaction((tx) => tx.patchFeatures([{ id: "c1", editable: false }])); // unsurun kendisi
    expect(actions.permissions("c1")).toMatchObject({ canEdit: false, canDelete: true });
    expect(actions.canEdit("yok")).toBe(false);
  });

  it("izin alanları görsel değil (META), ama değişiklik kaybolmaz", () => {
    const a = feature("x", "l");
    const b = { ...a, editable: false };
    expect(diffFeature(a, b)).toBe(FEATURE_CHANGE.META);
    expect(stabilizeFeature(a, b)).toBe(b);
  });

  it("abonelik: unsur, üst katman veya taşınma değişince haber verir", () => {
    const { store, actions } = setup();
    const cb = vi.fn();
    const off = actions.subscribe("k1", cb);
    store.transaction((tx) => tx.patchLayer("harekat", { editable: false }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(actions.canEdit("k1")).toBe(false);

    store.transaction((tx) => tx.patchFeatures([{ id: "k1", layerId: "cizimler" }])); // taşındı
    expect(actions.canEdit("k1")).toBe(true);
    cb.mockClear();
    store.transaction((tx) => tx.patchLayer("cizimler", { editable: false })); // yeni zincir izleniyor
    expect(cb).toHaveBeenCalled();
    off();
    cb.mockClear();
    store.transaction((tx) => tx.patchLayer("cizimler", { editable: true }));
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("silme", () => {
  it("bayrak kapalıysa yaşam döngüsü hiç çağrılmaz (DENIED)", async () => {
    const beforeDelete = vi.fn(() => true);
    const { store, actions } = setup({ beforeDelete });
    await expect(actions.delete("u1")).resolves.toBe(ACTION_RESULT.DENIED);
    expect(beforeDelete).not.toHaveBeenCalled();
    expect(store.getFeature("u1")).toBeDefined();
  });

  it("kanca yoksa doğrudan silinir", async () => {
    const { store, actions } = setup();
    await expect(actions.delete("c1")).resolves.toBe(ACTION_RESULT.DONE);
    expect(store.getFeature("c1")).toBeUndefined();
    await expect(actions.delete("c1")).resolves.toBe(ACTION_RESULT.MISSING);
  });

  it("backend onaylı: cevap gelene kadar store'a dokunulmaz, bekliyor; ikinci istek BUSY; onayda silinir", async () => {
    const backend = deferred<boolean>();
    const { store, actions } = setup({ beforeDelete: () => backend.promise });
    const pending = vi.fn();
    actions.subscribe("k1", pending);

    const result = actions.delete("k1");
    expect(actions.isPending("k1")).toBe(true);
    expect(store.getFeature("k1")).toBeDefined();
    await expect(actions.delete("k1")).resolves.toBe(ACTION_RESULT.BUSY);

    backend.resolve(true);
    await expect(result).resolves.toBe(ACTION_RESULT.DONE);
    expect(store.getFeature("k1")).toBeUndefined();
    expect(actions.isPending("k1")).toBe(false);
    expect(pending).toHaveBeenCalled();
  });

  it("backend reddederse (false) unsur kalır", async () => {
    const { store, actions } = setup({ beforeDelete: async () => false });
    await expect(actions.delete("k1")).resolves.toBe(ACTION_RESULT.REJECTED);
    expect(store.getFeature("k1")).toBeDefined();
    expect(actions.isPending("k1")).toBe(false);
  });

  it("kanca hata fırlatırsa store değişmez, hata çağırana gider, bekleme kalkar", async () => {
    const { store, actions } = setup({
      beforeDelete: async () => {
        throw new Error("403");
      },
    });
    await expect(actions.delete("k1")).rejects.toThrow("403");
    expect(store.getFeature("k1")).toBeDefined();
    expect(actions.isPending("k1")).toBe(false);
  });

  it("bekleme sırasında akış unsuru zaten sildiyse onay yine DONE (idempotent)", async () => {
    const backend = deferred<boolean>();
    const { store, actions } = setup({ beforeDelete: () => backend.promise });
    const result = actions.delete("k1");
    store.transaction((tx) => tx.removeFeatures(["k1"])); // backend akışı önce geldi
    backend.resolve(true);
    await expect(result).resolves.toBe(ACTION_RESULT.DONE);
  });
});

describe("ekleme ve güncelleme", () => {
  it("ekleme: kanca false → eklenmez; Feature dönerse (backend id / rev) o eklenir", async () => {
    const { store, actions } = setup({
      beforeCreate: async (f) => (f.id === "red" ? false : { ...f, id: "srv-1", rev: 1 }),
    });
    await expect(actions.create(feature("red", "cizimler"))).resolves.toBe(ACTION_RESULT.REJECTED);
    expect(store.getFeature("red")).toBeUndefined();
    await expect(actions.create(feature("tmp-1", "cizimler"))).resolves.toBe(ACTION_RESULT.DONE);
    expect(store.getFeature("tmp-1")).toBeUndefined();
    expect(store.getFeature("srv-1")).toMatchObject({ layerId: "cizimler" });
  });

  it("güncelleme: bayrak, kanca (prev ile), sonuç", async () => {
    const beforeUpdate = vi.fn(async () => true);
    const { store, actions } = setup({ beforeUpdate });
    const moved = { ...store.getFeature("c1")!, geometry: { kind: "point" as const, coord: [33, 40] as const } };
    await expect(actions.update(moved)).resolves.toBe(ACTION_RESULT.DONE);
    expect(beforeUpdate).toHaveBeenCalledWith(moved, expect.objectContaining({ id: "c1" }));
    expect(store.getFeature("c1")!.geometry).toEqual({ kind: "point", coord: [33, 40] });

    await expect(actions.update({ ...store.getFeature("u1")!, hidden: true })).resolves.toBe(ACTION_RESULT.DENIED);
    await expect(actions.update(feature("yok", "cizimler"))).resolves.toBe(ACTION_RESULT.MISSING);
  });

  it("kancalar sonradan değiştirilebilir (setLifecycle)", async () => {
    const { store, actions } = setup();
    actions.setLifecycle({ beforeDelete: () => false });
    await expect(actions.delete("c1")).resolves.toBe(ACTION_RESULT.REJECTED);
    expect(store.getFeature("c1")).toBeDefined();
  });
});
