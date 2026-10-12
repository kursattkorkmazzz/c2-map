import { beforeEach, describe, expect, it } from "vitest";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import type { Layer } from "../model/layer";
import { CHANGE_OP, LAYER_CHANGE, LAYER_CHANGE_ALL } from "./change";
import { createMapStore, type MapStore, type MapTx } from "./map-store";

const { ADD, UPDATE, REMOVE } = CHANGE_OP;

const layer = (id: string, parentId: string | null = null, over: Partial<Layer> = {}): Layer => ({
  id,
  name: id,
  parentId,
  visible: true,
  opacity: 1,
  ...over,
});

const feature = (id: string, layerId: string): Feature => ({
  id,
  layerId,
  kind: "marker",
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [0, 0] },
});

let store: MapStore;
const write = (fn: (tx: MapTx) => void) => store.transaction(fn);
const children = (parentId: string | null) => [...store.getChildLayerIds(parentId)];

/**
 * Ağaç:
 *   (kök)
 *   ├─ harekat
 *   │   ├─ kontrol   (unsur: k1, k2)
 *   │   └─ manevra
 *   └─ istihbarat    (unsur: i1)
 */
function seed() {
  write((tx) => {
    tx.upsertLayers([
      layer("harekat"),
      layer("kontrol", "harekat"),
      layer("manevra", "harekat"),
      layer("istihbarat"),
    ]);
    tx.upsertFeatures([feature("k1", "kontrol"), feature("k2", "kontrol"), feature("i1", "istihbarat")]);
  });
  store.drainChanges();
}

beforeEach(() => {
  store = createMapStore({ now: () => 0 });
});

describe("upsertLayers", () => {
  it("yeni katmanlar ebeveynin sonuna eklenir (ekleme sırası korunur)", () => {
    seed();
    expect(children(null)).toEqual(["harekat", "istihbarat"]);
    expect(children("harekat")).toEqual(["kontrol", "manevra"]);
  });

  it("ekleme → ADD (tüm bitler) + structure", () => {
    write((tx) => tx.upsertLayers([layer("a")]));
    const changes = store.drainChanges();
    expect(changes.layers.get("a")).toEqual({ op: ADD, mask: LAYER_CHANGE_ALL });
    expect(changes.structure).toBe(true);
  });

  it("değişiklik yok → günlük boş, referans aynı", () => {
    const a = layer("a");
    write((tx) => tx.upsertLayers([a]));
    store.drainChanges();
    write((tx) => tx.upsertLayers([{ ...a }]));
    expect(store.getLayer("a")).toBe(a);
    const changes = store.drainChanges();
    expect(changes.layers.size).toBe(0);
    expect(changes.structure).toBe(false);
  });

  it("alan değişimi (ebeveyn aynı) → UPDATE, structure yok", () => {
    seed();
    write((tx) => tx.upsertLayers([layer("kontrol", "harekat", { visible: false })]));
    const changes = store.drainChanges();
    expect(changes.layers.get("kontrol")).toEqual({ op: UPDATE, mask: LAYER_CHANGE.VISIBLE });
    expect(changes.structure).toBe(false);
    expect(children("harekat")).toEqual(["kontrol", "manevra"]); // sıra korunur
  });

  it("parentId değişimi → yeni ebeveynin sonuna taşınır, PARENT + structure", () => {
    seed();
    write((tx) => tx.upsertLayers([layer("kontrol", "istihbarat")]));
    expect(children("harekat")).toEqual(["manevra"]);
    expect(children("istihbarat")).toEqual(["kontrol"]);
    const changes = store.drainChanges();
    expect(changes.layers.get("kontrol")).toEqual({ op: UPDATE, mask: LAYER_CHANGE.PARENT });
    expect(changes.structure).toBe(true);
  });

  it("yetim katman (ebeveyni yok) kabul edilir; ebeveyn gelince ağaçta görünür", () => {
    write((tx) => tx.upsertLayers([layer("cocuk", "henuz-yok")]));
    expect(children("henuz-yok")).toEqual(["cocuk"]);
    write((tx) => tx.upsertLayers([layer("henuz-yok")]));
    expect(children(null)).toEqual(["henuz-yok"]);
  });

  it("kendini ebeveyn yapan katman reddedilir", () => {
    expect(() => write((tx) => tx.upsertLayers([layer("a", "a")]))).toThrow(/döngü/);
    expect(store.getLayer("a")).toBeUndefined();
  });

  it("yetim zincirle döngü kuran yeni katman reddedilir", () => {
    write((tx) => tx.upsertLayers([layer("b", "a")])); // b'nin ebeveyni (henüz olmayan) a
    expect(() => write((tx) => tx.upsertLayers([layer("a", "b")]))).toThrow(/döngü/);
    expect(store.getLayer("a")).toBeUndefined();
  });

  it("upsert ile katmanı kendi torununun altına almak reddedilir, ağaç değişmez", () => {
    seed();
    expect(() => write((tx) => tx.upsertLayers([layer("harekat", "kontrol")]))).toThrow(/döngü/);
    expect(store.getLayer("harekat")?.parentId).toBeNull();
    expect(children(null)).toEqual(["harekat", "istihbarat"]);
  });
});

describe("patchLayer", () => {
  it("yalnız gelen alan değişir", () => {
    seed();
    write((tx) => tx.patchLayer("kontrol", { opacity: 0.5 }));
    expect(store.getLayer("kontrol")).toMatchObject({ opacity: 0.5, visible: true, parentId: "harekat" });
    expect(store.drainChanges().layers.get("kontrol")).toEqual({ op: UPDATE, mask: LAYER_CHANGE.OPACITY });
  });

  it("olmayan id → yok sayılır, sayaç artar", () => {
    write((tx) => tx.patchLayer("yok", { visible: false }));
    expect(store.stats.ignoredPatches).toBe(1);
    expect(store.drainChanges().layers.size).toBe(0);
  });

  it("parentId ile patch → taşıma", () => {
    seed();
    write((tx) => tx.patchLayer("manevra", { parentId: null }));
    expect(children(null)).toEqual(["harekat", "istihbarat", "manevra"]);
    expect(children("harekat")).toEqual(["kontrol"]);
  });
});

describe("moveLayer", () => {
  it("aynı ebeveyn içinde sıra değiştirir", () => {
    seed();
    write((tx) => tx.moveLayer("manevra", "harekat", 0));
    expect(children("harekat")).toEqual(["manevra", "kontrol"]);
    const changes = store.drainChanges();
    expect(changes.layers.get("manevra")).toEqual({ op: UPDATE, mask: LAYER_CHANGE.PARENT });
    expect(changes.structure).toBe(true);
  });

  it("başka ebeveyne belirli konuma taşır; parentId güncellenir", () => {
    seed();
    write((tx) => tx.moveLayer("istihbarat", "harekat", 1));
    expect(children(null)).toEqual(["harekat"]);
    expect(children("harekat")).toEqual(["kontrol", "istihbarat", "manevra"]);
    expect(store.getLayer("istihbarat")?.parentId).toBe("harekat");
  });

  it("index verilmezse sona; aralık dışı index sıkıştırılır", () => {
    seed();
    write((tx) => tx.moveLayer("kontrol", null));
    expect(children(null)).toEqual(["harekat", "istihbarat", "kontrol"]);
    write((tx) => tx.moveLayer("kontrol", null, -5));
    expect(children(null)).toEqual(["kontrol", "harekat", "istihbarat"]);
    write((tx) => tx.moveLayer("kontrol", null, 99));
    expect(children(null)).toEqual(["harekat", "istihbarat", "kontrol"]);
  });

  it("aynı yere taşımak → hiçbir şey (günlük boş, referans aynı)", () => {
    seed();
    const before = store.getChildLayerIds("harekat");
    write((tx) => tx.moveLayer("kontrol", "harekat", 0));
    expect(store.getChildLayerIds("harekat")).toBe(before);
    expect(store.drainChanges().structure).toBe(false);
  });

  it("katmanı kendi altına taşımak → hata, ağaç değişmez", () => {
    seed();
    expect(() => write((tx) => tx.moveLayer("harekat", "kontrol"))).toThrow(/döngü/);
    expect(() => write((tx) => tx.moveLayer("harekat", "harekat"))).toThrow(/döngü/);
    expect(children(null)).toEqual(["harekat", "istihbarat"]);
    expect(children("kontrol")).toEqual([]);
  });

  it("olmayan katman → hata", () => {
    expect(() => write((tx) => tx.moveLayer("yok", null))).toThrow(/katman yok/);
  });

  it("taşınan katmanın unsurları onunla gider (unsurun layerId'si değişmez)", () => {
    seed();
    write((tx) => tx.moveLayer("kontrol", "istihbarat"));
    expect(store.getFeature("k1")?.layerId).toBe("kontrol");
    expect([...store.getFeatureIds("kontrol")]).toEqual(["k1", "k2"]);
  });
});

describe("removeLayers", () => {
  it("cascade: alt katmanlar ve tüm unsurları silinir", () => {
    seed();
    write((tx) => tx.removeLayers(["harekat"]));

    expect(store.getLayer("harekat")).toBeUndefined();
    expect(store.getLayer("kontrol")).toBeUndefined();
    expect(store.getLayer("manevra")).toBeUndefined();
    expect(store.getFeature("k1")).toBeUndefined();
    expect(store.getFeature("k2")).toBeUndefined();
    expect(children(null)).toEqual(["istihbarat"]);
    expect(store.getFeature("i1")).toBeDefined(); // başka katmana dokunulmaz

    const changes = store.drainChanges();
    expect([...changes.layers.keys()].sort()).toEqual(["harekat", "kontrol", "manevra"]);
    for (const c of changes.layers.values()) expect(c.op).toBe(REMOVE);
    expect(changes.features.get("k1")?.op).toBe(REMOVE);
    expect(changes.features.get("k2")?.op).toBe(REMOVE);
    expect(changes.features.has("i1")).toBe(false);
    expect(changes.structure).toBe(true);
  });

  it("yaprak katman silinir, kardeş sırası korunur", () => {
    seed();
    write((tx) => tx.removeLayers(["kontrol"]));
    expect(children("harekat")).toEqual(["manevra"]);
  });

  it("olmayan id sessizce yok sayılır; aynı id iki kez sorun değil", () => {
    seed();
    write((tx) => tx.removeLayers(["yok", "kontrol", "kontrol"]));
    expect(store.getLayer("kontrol")).toBeUndefined();
  });

  it("katmanı silinen yetim unsurlar (layerId başka) etkilenmez", () => {
    seed();
    write((tx) => tx.upsertFeatures([feature("yetim", "olmayan-katman")]));
    write((tx) => tx.removeLayers(["harekat", "istihbarat"]));
    expect(store.getFeature("yetim")).toBeDefined();
  });

  it("aynı transaction'da ekle + sil → günlükte iz kalmaz (yalnız structure)", () => {
    write((tx) => {
      tx.upsertLayers([layer("gecici")]);
      tx.upsertFeatures([feature("g1", "gecici")]);
      tx.removeLayers(["gecici"]);
    });
    const changes = store.drainChanges();
    expect(changes.layers.size).toBe(0);
    expect(changes.features.size).toBe(0);
  });
});

describe("childLayerIds referansları", () => {
  it("değişince yeni dizi, değişmeyen ebeveynin dizisi aynı kalır", () => {
    seed();
    const root = store.getChildLayerIds(null);
    const harekat = store.getChildLayerIds("harekat");
    write((tx) => tx.upsertLayers([layer("yeni", "harekat")]));
    expect(store.getChildLayerIds("harekat")).not.toBe(harekat);
    expect(store.getChildLayerIds(null)).toBe(root);
    expect(harekat).toEqual(["kontrol", "manevra"]); // eski dizi yerinde değişmedi
  });
});
