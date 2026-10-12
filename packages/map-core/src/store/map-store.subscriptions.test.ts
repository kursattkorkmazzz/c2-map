import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASEMAP_SOURCE, type Basemap } from "../model/basemap";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import type { Layer } from "../model/layer";
import { createMapStore, type MapStore, type MapTx } from "./map-store";

const layer = (id: string, parentId: string | null = null): Layer => ({
  id,
  name: id,
  parentId,
  visible: true,
  opacity: 1,
});

const feature = (id: string, layerId = "l1", lon = 0): Feature => ({
  id,
  layerId,
  kind: "marker",
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [lon, 0] },
});

const basemap = (id: string, over: Partial<Basemap> = {}): Basemap => ({
  id,
  name: id,
  source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: "u" },
  visible: false,
  opacity: 1,
  order: 0,
  ...over,
});

let store: MapStore;
let listenerErrors: unknown[];
const write = (fn: (tx: MapTx) => void) => store.transaction(fn);

beforeEach(() => {
  listenerErrors = [];
  store = createMapStore({ now: () => 0, onListenerError: (e) => listenerErrors.push(e) });
  write((tx) => {
    tx.upsertLayers([layer("l1"), layer("l2")]);
    tx.upsertFeatures([feature("a"), feature("b")]);
  });
});

describe("subscribeFeature", () => {
  it("yalnız ilgili id'nin dinleyicisi çağrılır", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    store.subscribeFeature("a", onA);
    store.subscribeFeature("b", onB);
    write((tx) => tx.patchFeatures([{ id: "a", z: 1 }]));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
  });

  it("bir transaction'da 100 değişiklik → tek çağrı", () => {
    const onA = vi.fn();
    store.subscribeFeature("a", onA);
    write((tx) => {
      for (let i = 1; i <= 100; i++) tx.patchFeatures([{ id: "a", geometry: feature("a", "l1", i).geometry }]);
    });
    expect(onA).toHaveBeenCalledTimes(1);
  });

  it("dinleyici transaction içinde çalışmaz; çağrıldığında yeni değer okunabilir", () => {
    const seen: (number | undefined)[] = [];
    store.subscribeFeature("a", () => seen.push(store.getFeature("a")?.z));
    write((tx) => {
      tx.patchFeatures([{ id: "a", z: 7 }]);
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([7]);
  });

  it("ekleme ve silme de bildirilir", () => {
    const onC = vi.fn();
    store.subscribeFeature("c", onC);
    write((tx) => tx.upsertFeatures([feature("c")]));
    write((tx) => tx.removeFeatures(["c"]));
    expect(onC).toHaveBeenCalledTimes(2);
  });

  it("değişiklik yoksa bildirim yok", () => {
    const onA = vi.fn();
    store.subscribeFeature("a", onA);
    write((tx) => tx.upsertFeatures([{ ...store.getFeature("a")! }]));
    expect(onA).not.toHaveBeenCalled();
  });

  it("abonelikten çıkınca çağrılmaz", () => {
    const onA = vi.fn();
    const off = store.subscribeFeature("a", onA);
    off();
    off(); // iki kez çağırmak zararsız
    write((tx) => tx.patchFeatures([{ id: "a", z: 1 }]));
    expect(onA).not.toHaveBeenCalled();
  });
});

describe("iç içe ve hatalı transaction", () => {
  it("iç içe transaction: bildirim yalnız en dıştaki bitince", () => {
    const onA = vi.fn();
    store.subscribeFeature("a", onA);
    write((tx) => {
      store.transaction((inner) => inner.patchFeatures([{ id: "a", z: 1 }]));
      expect(onA).not.toHaveBeenCalled();
    });
    expect(onA).toHaveBeenCalledTimes(1);
  });

  it("fn hata fırlatsa da o ana kadarki yazmalar bildirilir", () => {
    const onA = vi.fn();
    store.subscribeFeature("a", onA);
    expect(() =>
      write((tx) => {
        tx.patchFeatures([{ id: "a", z: 1 }]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(onA).toHaveBeenCalledTimes(1);
  });

  it("dinleyici hatası diğerlerini durdurmaz ve raporlanır", () => {
    const after = vi.fn();
    store.subscribeFeature("a", () => {
      throw new Error("dinleyici patladı");
    });
    store.subscribeFeature("a", after);
    write((tx) => tx.patchFeatures([{ id: "a", z: 1 }]));
    expect(after).toHaveBeenCalledTimes(1);
    expect(listenerErrors).toHaveLength(1);
    expect((listenerErrors[0] as Error).message).toBe("dinleyici patladı");
  });

  it("dinleyici içinden açılan transaction ayrı bir dalga olarak işlenir", () => {
    const onB = vi.fn();
    store.subscribeFeature("b", onB);
    // a değişince b'yi de güncelleyen "türetilmiş" dinleyici
    store.subscribeFeature("a", () => write((tx) => tx.patchFeatures([{ id: "b", z: store.getFeature("a")?.z }])));
    write((tx) => tx.patchFeatures([{ id: "a", z: 3 }]));
    expect(store.getFeature("b")?.z).toBe(3);
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it("dinleyici içinde abonelikten çıkmak gezinmeyi bozmaz", () => {
    const second = vi.fn();
    let off: () => void = () => {};
    off = store.subscribeFeature("a", () => off());
    store.subscribeFeature("a", second);
    write((tx) => tx.patchFeatures([{ id: "a", z: 1 }]));
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("diğer abonelikler", () => {
  it("subscribeLayer: katman değişimi ve taşıma", () => {
    const onL1 = vi.fn();
    store.subscribeLayer("l1", onL1);
    write((tx) => tx.patchLayer("l1", { visible: false }));
    write((tx) => tx.moveLayer("l1", null, 1));
    expect(onL1).toHaveBeenCalledTimes(2);
  });

  it("subscribeLayerContents: unsur eklenince, çıkınca, katman değiştirince (iki katman)", () => {
    const onL1 = vi.fn();
    const onL2 = vi.fn();
    store.subscribeLayerContents("l1", onL1);
    store.subscribeLayerContents("l2", onL2);

    write((tx) => tx.upsertFeatures([feature("c")]));
    expect(onL1).toHaveBeenCalledTimes(1);

    write((tx) => tx.patchFeatures([{ id: "c", layerId: "l2" }]));
    expect(onL1).toHaveBeenCalledTimes(2);
    expect(onL2).toHaveBeenCalledTimes(1);

    write((tx) => tx.patchFeatures([{ id: "a", z: 1 }])); // içerik değişmedi
    expect(onL1).toHaveBeenCalledTimes(2);
  });

  it("subscribeStructure: yalnız ağaç şekli değişince", () => {
    const onStructure = vi.fn();
    store.subscribeStructure(onStructure);
    write((tx) => tx.patchLayer("l1", { name: "yeni ad" }));
    expect(onStructure).not.toHaveBeenCalled();
    write((tx) => tx.upsertLayers([layer("l3", "l1")]));
    expect(onStructure).toHaveBeenCalledTimes(1);
  });

  it("subscribeBasemap / subscribeBasemaps (grup kuralıyla kapanan da bildirilir)", () => {
    write((tx) =>
      tx.upsertBasemaps([
        basemap("a", { exclusiveGroup: "g", visible: true }),
        basemap("b", { exclusiveGroup: "g" }),
      ]),
    );
    const onA = vi.fn();
    const onList = vi.fn();
    store.subscribeBasemap("a", onA);
    store.subscribeBasemaps(onList);
    write((tx) => tx.patchBasemap("b", { visible: true }));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onList).toHaveBeenCalledTimes(1);
  });

  it("subscribeSelection / subscribeHover", () => {
    const onSelection = vi.fn();
    const onHover = vi.fn();
    store.subscribeSelection(onSelection);
    store.subscribeHover(onHover);

    write((tx) => tx.select(["a"]));
    write((tx) => tx.select(["a"])); // değişiklik yok
    write((tx) => tx.setHovered("b"));
    expect(onSelection).toHaveBeenCalledTimes(1);
    expect(onHover).toHaveBeenCalledTimes(1);
  });

  it("subscribeChanges: herhangi bir değişiklikte bir kez; değişiklik yoksa hiç", () => {
    const onChanges = vi.fn();
    store.subscribeChanges(onChanges);
    write((tx) => {
      tx.patchFeatures([{ id: "a", z: 1 }]);
      tx.patchLayer("l1", { opacity: 0.5 });
      tx.select(["b"]);
    });
    expect(onChanges).toHaveBeenCalledTimes(1);

    write((tx) => tx.patchFeatures([{ id: "a", z: 1 }]));
    expect(onChanges).toHaveBeenCalledTimes(1);
  });

  it("katman cascade silmede unsur, katman, içerik ve yapı abonelerinin hepsi bildirilir", () => {
    const calls: string[] = [];
    store.subscribeFeature("a", () => calls.push("feature:a"));
    store.subscribeLayer("l1", () => calls.push("layer:l1"));
    store.subscribeLayerContents("l1", () => calls.push("contents:l1"));
    store.subscribeStructure(() => calls.push("structure"));
    store.subscribeChanges(() => calls.push("changes"));
    write((tx) => tx.removeLayers(["l1"]));
    expect(calls).toEqual(["feature:a", "layer:l1", "contents:l1", "structure", "changes"]);
  });
});
