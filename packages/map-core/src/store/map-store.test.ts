import { beforeEach, describe, expect, it } from "vitest";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import { CHANGE_OP, FEATURE_CHANGE, FEATURE_CHANGE_ALL } from "./change";
import { createMapStore, type MapStore, type MapTx } from "./map-store";

const { ADD, UPDATE, REMOVE } = CHANGE_OP;

const feature = (id: string, over: Partial<Feature> = {}): Feature => ({
  id,
  layerId: "l1",
  kind: "marker",
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [32.85, 39.9] },
  style: { color: "red" },
  ...over,
});

const point = (lon: number, lat: number) => ({ kind: GEOMETRY_KIND.POINT, coord: [lon, lat] }) as const;

let clock: number;
let store: MapStore;
beforeEach(() => {
  clock = 1000;
  store = createMapStore({ now: () => clock });
});

const write = (fn: (tx: MapTx) => void) => store.transaction(fn);

describe("0.2.4 okuma — boş store", () => {
  it("hiçbir şey yok", () => {
    expect(store.getFeature("x")).toBeUndefined();
    expect(store.getLayer("x")).toBeUndefined();
    expect(store.getBasemap("x")).toBeUndefined();
    expect(store.getChildLayerIds(null)).toEqual([]);
    expect(store.getFeatureIds("l1").size).toBe(0);
    expect(store.getBasemaps()).toEqual([]);
    expect(store.getSelection().size).toBe(0);
    expect(store.getHovered()).toBeNull();
    expect(store.getUpdatedAt("x")).toBeUndefined();
    expect(store.stats).toEqual({ droppedStale: 0, ignoredPatches: 0 });
  });

  it("drainChanges boş günlük döner", () => {
    const changes = store.drainChanges();
    expect(changes.features.size).toBe(0);
    expect(changes.structure).toBe(false);
  });
});

describe("0.2.5 transaction", () => {
  it("tx transaction dışında kullanılamaz", () => {
    let leaked: MapTx | undefined;
    write((tx) => (leaked = tx));
    expect(() => leaked!.upsertFeatures([feature("a")])).toThrow(/transaction/);
  });

  it("iç içe transaction dıştakine katılır", () => {
    write((tx) => {
      tx.upsertFeatures([feature("a")]);
      store.transaction((inner) => inner.upsertFeatures([feature("b")]));
    });
    expect(store.getFeature("a")).toBeDefined();
    expect(store.getFeature("b")).toBeDefined();
  });

  it("fn hata fırlatırsa o ana kadarki yazmalar kalır ve store kullanılabilir durumda kalır", () => {
    expect(() =>
      write((tx) => {
        tx.upsertFeatures([feature("a")]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getFeature("a")).toBeDefined();
    write((tx) => tx.upsertFeatures([feature("b")])); // derinlik sayacı sıfırlanmış olmalı
    expect(store.getFeature("b")).toBeDefined();
  });

  it("birden fazla transaction → tek drain'de birleşmiş günlük", () => {
    write((tx) => tx.upsertFeatures([feature("a")]));
    write((tx) => tx.patchFeatures([{ id: "a", geometry: point(1, 1) }]));
    write((tx) => tx.upsertFeatures([feature("b")]));
    const changes = store.drainChanges();
    expect(changes.features.get("a")).toEqual({ op: ADD, mask: FEATURE_CHANGE_ALL });
    expect(changes.features.get("b")).toEqual({ op: ADD, mask: FEATURE_CHANGE_ALL });
    expect(store.drainChanges().features.size).toBe(0);
  });
});

describe("0.2.5 upsertFeatures", () => {
  it("yeni unsur → ADD, indekslenir", () => {
    const a = feature("a");
    write((tx) => tx.upsertFeatures([a]));
    expect(store.getFeature("a")).toBe(a); // store kopyalamaz
    expect([...store.getFeatureIds("l1")]).toEqual(["a"]);
    expect(store.drainChanges().features.get("a")?.op).toBe(ADD);
  });

  it("var olan unsur → UPDATE, yalnız değişen bitler", () => {
    write((tx) => tx.upsertFeatures([feature("a")]));
    store.drainChanges();

    const prev = store.getFeature("a")!;
    write((tx) => tx.upsertFeatures([{ ...prev, geometry: point(1, 2) }]));
    expect(store.drainChanges().features.get("a")).toEqual({ op: UPDATE, mask: FEATURE_CHANGE.GEOMETRY });
  });

  it("değişiklik yok → günlüğe yazılmaz, eski referans kalır", () => {
    const a = feature("a");
    write((tx) => tx.upsertFeatures([a]));
    store.drainChanges();

    write((tx) => tx.upsertFeatures([{ ...a }]));
    expect(store.getFeature("a")).toBe(a);
    expect(store.drainChanges().features.size).toBe(0);
  });

  it("yetim unsur (katmanı yok) kabul edilir ve indekslenir", () => {
    write((tx) => tx.upsertFeatures([feature("a", { layerId: "henuz-yok" })]));
    expect(store.getFeature("a")).toBeDefined();
    expect(store.getFeatureIds("henuz-yok").has("a")).toBe(true);
  });

  it("layerId değişimi → iki katmanın indeksi güncellenir, LAYER biti", () => {
    write((tx) => tx.upsertFeatures([feature("a", { layerId: "l1" })]));
    store.drainChanges();

    write((tx) => tx.upsertFeatures([{ ...store.getFeature("a")!, layerId: "l2" }]));
    expect(store.getFeatureIds("l1").has("a")).toBe(false);
    expect(store.getFeatureIds("l2").has("a")).toBe(true);
    expect(store.drainChanges().features.get("a")).toEqual({ op: UPDATE, mask: FEATURE_CHANGE.LAYER });
  });
});

describe("0.2.5 patchFeatures", () => {
  it("yalnız gelen alanlar değişir; eski nesne değişmez, yeni referans", () => {
    write((tx) => tx.upsertFeatures([feature("a", { style: { color: "red", size: 3 } })]));
    store.drainChanges();
    const prev = store.getFeature("a")!;
    const snapshot = structuredClone(prev);

    write((tx) => tx.patchFeatures([{ id: "a", style: { color: "blue" } }]));
    const next = store.getFeature("a")!;
    expect(next).not.toBe(prev);
    expect(prev).toEqual(snapshot);
    expect(next.style).toEqual({ color: "blue", size: 3 });
    expect(next.geometry).toBe(prev.geometry);
    expect(store.drainChanges().features.get("a")).toEqual({ op: UPDATE, mask: FEATURE_CHANGE.STYLE });
  });

  it("olmayan id → yok sayılır, sayaç artar", () => {
    write((tx) => tx.patchFeatures([{ id: "yok", z: 1 }]));
    expect(store.getFeature("yok")).toBeUndefined();
    expect(store.stats.ignoredPatches).toBe(1);
    expect(store.drainChanges().features.size).toBe(0);
  });

  it("aynı değerli patch → referans korunur, günlük boş", () => {
    const a = feature("a");
    write((tx) => tx.upsertFeatures([a]));
    store.drainChanges();
    write((tx) => tx.patchFeatures([{ id: "a", style: { color: "red" } }]));
    expect(store.getFeature("a")).toBe(a);
    expect(store.drainChanges().features.size).toBe(0);
  });

  it("patch ile layerId değişimi indeksi günceller", () => {
    write((tx) => tx.upsertFeatures([feature("a")]));
    write((tx) => tx.patchFeatures([{ id: "a", layerId: "l2" }]));
    expect(store.getFeatureIds("l1").size).toBe(0);
    expect(store.getFeatureIds("l2").has("a")).toBe(true);
  });
});

describe("0.2.5 removeFeatures", () => {
  it("kayıt, indeks ve zaman bilgisi silinir → REMOVE", () => {
    write((tx) => tx.upsertFeatures([feature("a"), feature("b")]));
    store.drainChanges();

    write((tx) => tx.removeFeatures(["a"]));
    expect(store.getFeature("a")).toBeUndefined();
    expect([...store.getFeatureIds("l1")]).toEqual(["b"]);
    expect(store.getUpdatedAt("a")).toBeUndefined();
    expect(store.drainChanges().features.get("a")).toEqual({ op: REMOVE, mask: 0 });
  });

  it("olmayan id sessizce yok sayılır", () => {
    write((tx) => tx.removeFeatures(["yok"]));
    expect(store.drainChanges().features.size).toBe(0);
  });

  it("aynı transaction'da ekle + sil → günlükte iz kalmaz", () => {
    write((tx) => {
      tx.upsertFeatures([feature("a")]);
      tx.removeFeatures(["a"]);
    });
    expect(store.drainChanges().features.size).toBe(0);
  });

  it("silinip yeniden eklenen unsurun eski rev'i unutulur", () => {
    write((tx) => tx.upsertFeatures([feature("a", { rev: 10 })]));
    write((tx) => tx.removeFeatures(["a"]));
    write((tx) => tx.upsertFeatures([feature("a", { rev: 1 })]));
    expect(store.getFeature("a")?.rev).toBe(1);
    expect(store.stats.droppedStale).toBe(0);
  });
});

describe("0.2.5 rev kuralı", () => {
  beforeEach(() => {
    write((tx) => tx.upsertFeatures([feature("a", { rev: 5 })]));
    store.drainChanges();
  });

  it("daha yeni rev uygulanır", () => {
    write((tx) => tx.upsertFeatures([feature("a", { rev: 6, z: 1 })]));
    expect(store.getFeature("a")?.z).toBe(1);
  });

  it.each([
    ["eski", 4],
    ["eşit", 5],
  ])("%s rev (upsert) düşürülür", (_name, rev) => {
    write((tx) => tx.upsertFeatures([feature("a", { rev, z: 1 })]));
    expect(store.getFeature("a")?.z).toBeUndefined();
    expect(store.stats.droppedStale).toBe(1);
    expect(store.drainChanges().features.size).toBe(0);
  });

  it("eski rev (patch) düşürülür", () => {
    write((tx) => tx.patchFeatures([{ id: "a", rev: 3, z: 1 }]));
    expect(store.getFeature("a")?.z).toBeUndefined();
    expect(store.stats.droppedStale).toBe(1);
  });

  it("rev'siz yazma her zaman uygulanır", () => {
    write((tx) => tx.patchFeatures([{ id: "a", z: 1 }]));
    expect(store.getFeature("a")?.z).toBe(1);
  });

  it("içerik aynı ama rev yeni → referans değişmez, ama rev ilerler (sonraki eski mesaj düşer)", () => {
    const before = store.getFeature("a");
    write((tx) => tx.patchFeatures([{ id: "a", rev: 9 }]));
    expect(store.getFeature("a")).toBe(before);
    expect(store.drainChanges().features.size).toBe(0);

    write((tx) => tx.patchFeatures([{ id: "a", rev: 7, z: 1 }]));
    expect(store.getFeature("a")?.z).toBeUndefined();
    expect(store.stats.droppedStale).toBe(1);
  });

  it("aynı paket içinde sıra dışı mesaj: yeni olan kalır", () => {
    write((tx) =>
      tx.patchFeatures([
        { id: "a", rev: 8, geometry: point(8, 8) },
        { id: "a", rev: 7, geometry: point(7, 7) },
      ]),
    );
    expect(store.getFeature("a")?.geometry).toEqual(point(8, 8));
  });
});

describe("0.2.5 updatedAt", () => {
  it("her yazmada now() ile güncellenir — içerik aynı olsa bile", () => {
    write((tx) => tx.upsertFeatures([feature("a")]));
    expect(store.getUpdatedAt("a")).toBe(1000);

    clock = 2000;
    write((tx) => tx.patchFeatures([{ id: "a", z: 1 }]));
    expect(store.getUpdatedAt("a")).toBe(2000);

    clock = 3000;
    write((tx) => tx.upsertFeatures([{ ...store.getFeature("a")! }])); // değişiklik yok
    expect(store.getUpdatedAt("a")).toBe(3000);
  });

  it("düşürülen (eski rev) yazma zamanı güncellemez", () => {
    write((tx) => tx.upsertFeatures([feature("a", { rev: 5 })]));
    clock = 2000;
    write((tx) => tx.patchFeatures([{ id: "a", rev: 1 }]));
    expect(store.getUpdatedAt("a")).toBe(1000);
  });
});
