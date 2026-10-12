import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockAdapter } from "../adapter/mock-adapter";
import { RENDER_CHANGE, RENDER_CHANGE_ALL, type RenderBatch } from "../adapter/types";
import { BASEMAP_SOURCE, type Basemap } from "../model/basemap";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import type { Layer } from "../model/layer";
import { FEATURE_CHANGE } from "../store/change";
import { createMapStore, type MapStore, type MapTx } from "../store/map-store";
import { MapSync, Z_LAYER_STRIDE } from "./map-sync";
import type { PresentationStage } from "./presentation";
import { createManualScheduler, type ManualScheduler } from "./scheduler";

const layer = (id: string, parentId: string | null = null, over: Partial<Layer> = {}): Layer => ({
  id,
  name: id,
  parentId,
  visible: true,
  opacity: 1,
  ...over,
});

const point = (lon: number) => ({ kind: GEOMETRY_KIND.POINT, coord: [lon, 0] }) as const;

const feature = (id: string, layerId: string, over: Partial<Feature> = {}): Feature => ({
  id,
  layerId,
  kind: "marker",
  geometry: point(0),
  ...over,
});

const osm: Basemap = {
  id: "osm",
  name: "OSM",
  source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: "u" },
  visible: true,
  opacity: 1,
  order: 0,
};

/**
 * Ağaç (sıra): harekat(0) → kontrol(1) → manevra(2); istihbarat(3, renderGroup) → kaynak(4)
 *   kontrol: k1, k2     manevra: m1     istihbarat: i1     kaynak: s1
 */
let store: MapStore;
let adapter: MockAdapter;
let scheduler: ManualScheduler;
let sync: MapSync;
const write = (fn: (tx: MapTx) => void) => store.transaction(fn);

/** Bir kare geçir ve gelen batch'i döndür (gelmediyse undefined). */
const frame = (): RenderBatch | undefined => {
  scheduler.run();
  const batches = adapter.takeBatches();
  expect(batches.length).toBeLessThanOrEqual(1);
  return batches[0];
};
const upsertIds = (b?: RenderBatch) => (b?.features?.upsert ?? []).map((rf) => rf.feature.id).sort();
const removeIds = (b?: RenderBatch) => [...(b?.features?.remove ?? [])].sort();
const shown = () => [...adapter.features.keys()].sort();

beforeEach(() => {
  store = createMapStore({ now: () => 0 });
  write((tx) => {
    tx.upsertLayers([
      layer("harekat"),
      layer("kontrol", "harekat"),
      layer("manevra", "harekat"),
      layer("istihbarat", null, { renderGroup: true }),
      layer("kaynak", "istihbarat"),
    ]);
    tx.upsertFeatures([
      feature("k1", "kontrol"),
      feature("k2", "kontrol", { z: 5 }),
      feature("m1", "manevra"),
      feature("i1", "istihbarat"),
      feature("s1", "kaynak"),
      feature("gizli", "kontrol", { hidden: true }),
      feature("yetim", "olmayan"),
    ]);
    tx.upsertBasemaps([osm]);
  });
  adapter = new MockAdapter();
  scheduler = createManualScheduler();
  sync = new MapSync({ store, adapter, scheduler });
  sync.start();
});

describe("ilk senkron (start)", () => {
  it("görünen unsurlar, gruplar ve altlıklar tek batch'te gider; gizli ve yetim gitmez", () => {
    const [batch] = adapter.takeBatches();
    expect(upsertIds(batch)).toEqual(["i1", "k1", "k2", "m1", "s1"]);
    expect(batch?.features?.upsert.every((rf) => rf.changed === RENDER_CHANGE_ALL)).toBe(true);
    expect(batch?.groups?.upsert.map((g) => g.id).sort()).toEqual(["harekat", "istihbarat"]);
    expect(batch?.basemaps?.upsert.map((b) => b.id)).toEqual(["osm"]);
  });

  it("render group: en yakın renderGroup ata, yoksa kökün çocuğu", () => {
    expect(adapter.features.get("k1")?.groupId).toBe("harekat");
    expect(adapter.features.get("s1")?.groupId).toBe("istihbarat");
  });

  it("zIndex: katman sırası × stride + z", () => {
    expect(adapter.features.get("k1")?.zIndex).toBe(1 * Z_LAYER_STRIDE);
    expect(adapter.features.get("k2")?.zIndex).toBe(1 * Z_LAYER_STRIDE + 5);
    expect(adapter.features.get("s1")?.zIndex).toBe(4 * Z_LAYER_STRIDE);
  });

  it("start iki kez çağrılırsa tekrar senkron yapmaz", () => {
    adapter.takeBatches();
    sync.start();
    expect(adapter.batches).toHaveLength(0);
  });
});

describe("zamanlama ve birleştirme", () => {
  beforeEach(() => adapter.takeBatches());

  it("değişiklik hemen değil, bir sonraki karede uygulanır", () => {
    write((tx) => tx.patchFeatures([{ id: "k1", geometry: point(1) }]));
    expect(adapter.batches).toHaveLength(0);
    expect(scheduler.pending).toBe(true);
    const batch = frame();
    expect(batch?.features?.upsert[0]).toMatchObject({ changed: FEATURE_CHANGE.GEOMETRY });
  });

  it("aynı kare içindeki 10 güncelleme tek upsert'e iner", () => {
    for (let i = 1; i <= 10; i++) write((tx) => tx.patchFeatures([{ id: "k1", geometry: point(i) }]));
    const batch = frame();
    expect(batch?.features?.upsert).toHaveLength(1);
    expect(adapter.features.get("k1")?.feature.geometry).toEqual(point(10));
  });

  it("yalnız META değişirse haritaya hiçbir şey gitmez", () => {
    write((tx) => tx.patchFeatures([{ id: "k1", meta: { yakit: 40 } }]));
    expect(frame()).toBeUndefined();
  });

  it("flush() zamanlayıcıyı beklemeden uygular ve bekleyen görevi iptal eder", () => {
    write((tx) => tx.patchFeatures([{ id: "k1", z: 1 }]));
    sync.flush();
    expect(adapter.takeBatches()).toHaveLength(1);
    expect(scheduler.pending).toBe(false);
  });

  it("stop sonrası değişiklik uygulanmaz", () => {
    sync.stop();
    write((tx) => tx.patchFeatures([{ id: "k1", z: 1 }]));
    expect(scheduler.pending).toBe(false);
  });
});

describe("unsur değişiklikleri", () => {
  beforeEach(() => adapter.takeBatches());

  it("ekleme → tüm bitler; silme → remove", () => {
    write((tx) => tx.upsertFeatures([feature("k3", "kontrol")]));
    expect(frame()?.features?.upsert[0]?.changed).toBe(RENDER_CHANGE_ALL);
    write((tx) => tx.removeFeatures(["k3"]));
    expect(removeIds(frame())).toEqual(["k3"]);
  });

  it("hidden aç/kapa → remove / tüm bitlerle geri", () => {
    write((tx) => tx.patchFeatures([{ id: "k1", hidden: true }]));
    expect(removeIds(frame())).toEqual(["k1"]);
    write((tx) => tx.patchFeatures([{ id: "k1", hidden: false }]));
    expect(frame()?.features?.upsert[0]?.changed).toBe(RENDER_CHANGE_ALL);
  });

  it("görünmeyen unsurun güncellemesi gönderilmez", () => {
    write((tx) => tx.patchFeatures([{ id: "gizli", geometry: point(9) }]));
    expect(frame()).toBeUndefined();
  });

  it("yetim unsur, katmanı eklenince görünür", () => {
    write((tx) => tx.upsertLayers([layer("olmayan")]));
    expect(upsertIds(frame())).toEqual(["yetim"]);
  });

  it("feature.z değişimi → kendi biti + Z_INDEX", () => {
    write((tx) => tx.patchFeatures([{ id: "k1", z: 3 }]));
    expect(frame()?.features?.upsert[0]?.changed).toBe(FEATURE_CHANGE.Z | RENDER_CHANGE.Z_INDEX);
  });

  it("başka katmana taşınan unsur: LAYER + Z_INDEX (+ grup değiştiyse GROUP)", () => {
    write((tx) => tx.patchFeatures([{ id: "k1", layerId: "kaynak" }]));
    const rf = frame()?.features?.upsert[0];
    expect(rf?.changed).toBe(FEATURE_CHANGE.LAYER | RENDER_CHANGE.Z_INDEX | RENDER_CHANGE.GROUP);
    expect(rf?.groupId).toBe("istihbarat");
  });
});

describe("katman değişiklikleri", () => {
  beforeEach(() => adapter.takeBatches());

  it("katman kapatılınca alt ağacındaki tüm unsurlar kaldırılır, açılınca geri gelir", () => {
    write((tx) => tx.patchLayer("harekat", { visible: false }));
    expect(removeIds(frame())).toEqual(["k1", "k2", "m1"]);
    expect(shown()).toEqual(["i1", "s1"]);

    write((tx) => tx.patchLayer("harekat", { visible: true }));
    expect(upsertIds(frame())).toEqual(["k1", "k2", "m1"]);
  });

  it("opaklık atalarla çarpılır; değişince yalnız OPACITY biti", () => {
    write((tx) => {
      tx.patchLayer("harekat", { opacity: 0.5 });
      tx.patchLayer("kontrol", { opacity: 0.5 });
    });
    const batch = frame();
    expect(adapter.features.get("k1")?.opacity).toBe(0.25);
    expect(adapter.features.get("m1")?.opacity).toBe(0.5);
    expect(batch?.features?.upsert.every((rf) => rf.changed === RENDER_CHANGE.OPACITY)).toBe(true);
    expect(upsertIds(batch)).toEqual(["k1", "k2", "m1"]); // istihbarat etkilenmez
  });

  it("render'ı etkilemeyen katman değişikliği (ad, meta) batch üretmez", () => {
    write((tx) => tx.patchLayer("kontrol", { name: "Yeni ad", meta: { not: 1 } }));
    expect(frame()).toBeUndefined();
  });

  it("katman taşınınca sıralar değişir → Z_INDEX bitleri", () => {
    write((tx) => tx.moveLayer("istihbarat", null, 0)); // istihbarat en başa
    const batch = frame();
    expect(adapter.features.get("i1")?.zIndex).toBe(0);
    expect(batch?.features?.upsert.find((rf) => rf.feature.id === "k1")?.changed).toBe(RENDER_CHANGE.Z_INDEX);
    expect(batch?.groups?.upsert.length).toBeGreaterThan(0); // grup sıraları da değişti
  });

  it("renderGroup açılınca yeni grup ve unsurlar GROUP bitiyle", () => {
    write((tx) => tx.patchLayer("kontrol", { renderGroup: true }));
    const batch = frame();
    expect(batch?.groups?.upsert.map((g) => g.id)).toEqual(["kontrol"]);
    expect(batch?.features?.upsert.find((rf) => rf.feature.id === "k1")?.changed).toBe(RENDER_CHANGE.GROUP);
    expect(adapter.features.get("k1")?.groupId).toBe("kontrol");
  });

  it("katman silinince unsurları ve (kök ise) grubu kaldırılır", () => {
    write((tx) => tx.removeLayers(["istihbarat"]));
    const batch = frame();
    expect(removeIds(batch)).toEqual(["i1", "s1"]);
    expect(batch?.groups?.remove).toEqual(["istihbarat"]);
  });
});

describe("seçim, hover → durum yamaları", () => {
  beforeEach(() => adapter.takeBatches());

  it("seçim ve hover değişimi veriye dokunmadan state olarak gider", () => {
    write((tx) => {
      tx.select(["k1"]);
      tx.setHovered("m1");
    });
    const batch = frame();
    expect(batch?.features).toBeUndefined();
    expect(adapter.states.get("k1")).toEqual({ selected: true });
    expect(adapter.states.get("m1")).toEqual({ hovered: true });

    write((tx) => {
      tx.clearSelection();
      tx.setHovered(null);
    });
    frame();
    expect(adapter.states.get("k1")).toEqual({ selected: false });
    expect(adapter.states.get("m1")).toEqual({ hovered: false });
  });

  it("seçiliyken gizlenip yeniden görünen unsurun durumu yeniden gönderilir", () => {
    write((tx) => tx.select(["k1"]));
    frame();
    write((tx) => tx.patchLayer("kontrol", { visible: false }));
    frame();
    adapter.states.clear(); // adapter unsuru kaldırırken durumunu da unutmuş olsun
    write((tx) => tx.patchLayer("kontrol", { visible: true }));
    frame();
    expect(adapter.states.get("k1")).toEqual({ selected: true });
  });
});

describe("zoom aralığı", () => {
  beforeEach(() => {
    write((tx) => tx.patchLayer("manevra", { minZoom: 10 }));
    adapter.takeBatches();
    frame();
  });

  it("zoom bilinmiyorsa sınır uygulanmaz; eşik geçilince kaldır / geri ekle", () => {
    expect(shown()).toContain("m1");

    sync.setView({ center: [0, 0], zoom: 6 });
    expect(removeIds(frame())).toEqual(["m1"]);

    sync.setView({ center: [0, 0], zoom: 8 }); // eşik geçilmedi
    expect(scheduler.pending).toBe(false);

    sync.setView({ center: [0, 0], zoom: 10 }); // minZoom dahil
    expect(upsertIds(frame())).toEqual(["m1"]);
  });
});

describe("altlıklar", () => {
  beforeEach(() => adapter.takeBatches());

  it("değişen altlık upsert, silinen remove", () => {
    write((tx) => tx.patchBasemap("osm", { opacity: 0.5 }));
    expect(frame()?.basemaps?.upsert[0]?.opacity).toBe(0.5);
    write((tx) => tx.removeBasemaps(["osm"]));
    expect(frame()?.basemaps?.remove).toEqual(["osm"]);
  });
});

describe("sunum aşamaları", () => {
  beforeEach(() => adapter.takeBatches());

  it("aşama yoksa batch aynen geçer; aşama batch'i dönüştürebilir", () => {
    const onlyI: PresentationStage = {
      id: "filtre",
      process: (batch) => ({
        ...batch,
        features: batch.features && {
          upsert: batch.features.upsert.filter((rf) => rf.feature.id.startsWith("i")),
          remove: batch.features.remove,
        },
      }),
    };
    sync.setStages([onlyI]);
    const batch = frame();
    expect(upsertIds(batch)).toEqual(["i1"]); // setStages → görünen her şey yeniden gönderildi, aşama süzdü
  });

  it("setStages sonrası görünen unsurlar tüm bitlerle yeniden gider", () => {
    sync.setStages([{ id: "bos", process: (b) => b }]);
    const batch = frame();
    expect(upsertIds(batch)).toEqual(["i1", "k1", "k2", "m1", "s1"]);
    expect(batch?.features?.upsert.every((rf) => rf.changed === RENDER_CHANGE_ALL)).toBe(true);
  });

  it("aşama bağlamında store ve son kamera var; onViewChange batch'i hemen uygulanır", () => {
    const process = vi.fn((b: RenderBatch) => b);
    const onViewChange = vi.fn(() => ({ state: [{ id: "cluster:1", state: { highlighted: true } }] }));
    sync.setStages([{ id: "kume", process, onViewChange }]);
    frame();

    sync.setView({ center: [1, 1], zoom: 7 });
    expect(onViewChange).toHaveBeenCalledWith({ center: [1, 1], zoom: 7 }, expect.objectContaining({ store }));
    expect(adapter.states.get("cluster:1")).toEqual({ highlighted: true });
    expect(adapter.takeBatches()).toHaveLength(1); // zamanlayıcıyı beklemeden uygulandı

    write((tx) => tx.patchFeatures([{ id: "k1", z: 1 }]));
    frame();
    expect(process).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ view: { center: [1, 1], zoom: 7 } }));
  });
});
