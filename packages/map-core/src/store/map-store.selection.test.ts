import { beforeEach, describe, expect, it } from "vitest";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import type { Layer } from "../model/layer";
import { createMapStore, SELECT_MODE, type MapStore, type MapTx } from "./map-store";

const layer = (id: string, parentId: string | null = null, over: Partial<Layer> = {}): Layer => ({
  id,
  name: id,
  parentId,
  visible: true,
  opacity: 1,
  ...over,
});

const feature = (id: string, layerId = "l1", over: Partial<Feature> = {}): Feature => ({
  id,
  layerId,
  kind: "marker",
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [0, 0] },
  ...over,
});

let store: MapStore;
const write = (fn: (tx: MapTx) => void) => store.transaction(fn);
const selected = () => [...store.getSelection()].sort();

beforeEach(() => {
  store = createMapStore({ now: () => 0 });
  write((tx) => {
    tx.upsertLayers([
      layer("l1"),
      layer("kilitli", null, { selectable: false }),
      layer("kilitli-alt", "kilitli"),
    ]);
    tx.upsertFeatures([
      feature("a"),
      feature("b"),
      feature("c"),
      feature("secilemez", "l1", { selectable: false }),
      feature("k1", "kilitli"),
      feature("k2", "kilitli-alt"),
      feature("yetim", "olmayan-katman"),
    ]);
  });
  store.drainChanges();
});

describe("select", () => {
  it("replace (varsayılan): seçimi verilen listeyle değiştirir", () => {
    write((tx) => tx.select(["a", "b"]));
    write((tx) => tx.select(["c"]));
    expect(selected()).toEqual(["c"]);
  });

  it("add / remove / toggle", () => {
    write((tx) => tx.select(["a"]));
    write((tx) => tx.select(["b"], SELECT_MODE.ADD));
    expect(selected()).toEqual(["a", "b"]);

    write((tx) => tx.select(["a"], SELECT_MODE.REMOVE));
    expect(selected()).toEqual(["b"]);

    write((tx) => tx.select(["b", "c"], SELECT_MODE.TOGGLE));
    expect(selected()).toEqual(["c"]);
  });

  it("clearSelection", () => {
    write((tx) => tx.select(["a", "b"]));
    write((tx) => tx.clearSelection());
    expect(selected()).toEqual([]);
  });

  it("olmayan unsur seçilmez", () => {
    write((tx) => tx.select(["a", "yok"]));
    expect(selected()).toEqual(["a"]);
  });

  it("selectable:false unsur ve katman zinciri seçilemez (ata katman dahil)", () => {
    write((tx) => tx.select(["secilemez", "k1", "k2", "a"]));
    expect(selected()).toEqual(["a"]);
    write((tx) => tx.select(["k2"], SELECT_MODE.TOGGLE));
    expect(selected()).toEqual(["a"]);
  });

  it("yetim unsur (katman bilgisi yok) seçilebilir", () => {
    write((tx) => tx.select(["yetim"]));
    expect(selected()).toEqual(["yetim"]);
  });

  it("seçimden çıkarma, seçilebilirlikten bağımsız her zaman serbest", () => {
    write((tx) => tx.select(["a"]));
    write((tx) => tx.patchFeatures([{ id: "a", selectable: false }]));
    write((tx) => tx.select(["a"], SELECT_MODE.REMOVE));
    expect(selected()).toEqual([]);
  });
});

describe("seçim günlüğü ve referanslar", () => {
  it("günlükte yalnız durumu değişen id'ler", () => {
    write((tx) => tx.select(["a", "b"]));
    store.drainChanges();

    write((tx) => tx.select(["b", "c"])); // a çıktı, c girdi, b aynı
    expect([...store.drainChanges().selection].sort()).toEqual(["a", "c"]);
  });

  it("aynı transaction'da seç → bırak: net değişiklik yok", () => {
    write((tx) => {
      tx.select(["a"]);
      tx.clearSelection();
    });
    expect(store.drainChanges().selection.size).toBe(0);
  });

  it("değişiklik yoksa küme referansı aynı; değişince yeni küme", () => {
    write((tx) => tx.select(["a"]));
    const first = store.getSelection();
    write((tx) => tx.select(["a"]));
    expect(store.getSelection()).toBe(first);
    write((tx) => tx.select(["b"], SELECT_MODE.ADD));
    expect(store.getSelection()).not.toBe(first);
    expect([...first]).toEqual(["a"]); // eski küme yerinde değişmedi
  });

  it("silinen unsur seçimden düşer ve günlüğe yazılır (0.2.5'ten kalan test)", () => {
    write((tx) => tx.select(["a", "b"]));
    store.drainChanges();
    write((tx) => tx.removeFeatures(["a"]));
    expect(selected()).toEqual(["b"]);
    expect([...store.drainChanges().selection]).toEqual(["a"]);
  });

  it("katman silinince altındaki seçili unsurlar da düşer", () => {
    write((tx) => tx.select(["a", "yetim"]));
    write((tx) => tx.removeLayers(["l1"]));
    expect(selected()).toEqual(["yetim"]);
  });
});

describe("setHovered", () => {
  it("hover değişir ve günlüğe ilk/son durum yazılır", () => {
    write((tx) => tx.setHovered("a"));
    write((tx) => tx.setHovered("b"));
    expect(store.getHovered()).toBe("b");
    expect(store.drainChanges().hover).toEqual({ prev: null, next: "b" });
  });

  it("aynı id → değişiklik yok", () => {
    write((tx) => tx.setHovered("a"));
    store.drainChanges();
    write((tx) => tx.setHovered("a"));
    expect(store.drainChanges().hover).toBeNull();
  });

  it("store'da olmayan id (ör. sentetik küme) yok sayılır", () => {
    write((tx) => tx.setHovered("a"));
    write((tx) => tx.setHovered("cluster:12"));
    expect(store.getHovered()).toBe("a");
  });

  it("null ile hover temizlenir", () => {
    write((tx) => tx.setHovered("a"));
    write((tx) => tx.setHovered(null));
    expect(store.getHovered()).toBeNull();
  });

  it("hover'daki unsur silinince hover temizlenir (0.2.5'ten kalan test)", () => {
    write((tx) => tx.setHovered("a"));
    store.drainChanges();
    write((tx) => tx.removeFeatures(["a"]));
    expect(store.getHovered()).toBeNull();
    expect(store.drainChanges().hover).toEqual({ prev: "a", next: null });
  });
});
