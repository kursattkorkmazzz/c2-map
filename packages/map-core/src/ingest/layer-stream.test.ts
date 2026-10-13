import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import { CHANGE_OP, FEATURE_CHANGE } from "../store/change";
import { createMapStore, type MapStore } from "../store/map-store";
import { createLayerStream, STREAM_FORMAT, type StreamItem } from "./layer-stream";

const point = (lon: number) => ({ kind: GEOMETRY_KIND.POINT, coord: [lon, 39] }) as const;

let store: MapStore;
beforeEach(() => {
  store = createMapStore({ now: () => 0 });
  store.transaction((tx) =>
    tx.upsertLayers([
      { id: "birlikler", name: "Birlikler", parentId: null, visible: true, opacity: 1 },
      { id: "cizimler", name: "Çizimler", parentId: null, visible: true, opacity: 1 },
    ]),
  );
});

describe("full (varsayılan, en kötü durum)", () => {
  it("tam nesneler eklenir; layerId verilmezse akışın katmanı kullanılır", () => {
    const stream = createLayerStream(store, { layerId: "birlikler" });
    stream.update([{ id: "u1", kind: "milsym", geometry: point(32), props: { sidc: "a" } }]);
    expect(store.getFeature("u1")?.layerId).toBe("birlikler");
  });

  it("tam nesnede eksik alan = yok: önceki props kaldırılır", () => {
    const stream = createLayerStream(store, { layerId: "birlikler" });
    stream.update([{ id: "u1", kind: "milsym", geometry: point(32), props: { sidc: "a" } }]);
    stream.update([{ id: "u1", kind: "milsym", geometry: point(32) }]);
    expect(store.getFeature("u1")?.props).toBeUndefined();
  });

  it("aynı içerikli tekrar → günlük yalnız gerçekten değişeni içerir", () => {
    const stream = createLayerStream(store, { layerId: "birlikler" });
    const msg = (lon: number) => ({ id: "u1", kind: "milsym", geometry: point(lon), props: { sidc: "a" } });
    stream.update([msg(32)]);
    store.drainChanges();
    stream.update([msg(32.1)]);
    expect(store.drainChanges().features.get("u1")).toEqual({ op: CHANGE_OP.UPDATE, mask: FEATURE_CHANGE.GEOMETRY });
  });

  it("başka katmanı gösteren tam nesne atlanır ve sayılır", () => {
    const stream = createLayerStream(store, { layerId: "birlikler" });
    stream.update([{ id: "c1", layerId: "cizimler", kind: "vector", geometry: point(1) }]);
    expect(store.getFeature("c1")).toBeUndefined();
    expect(stream.stats.wrongLayer).toBe(1);
  });
});

describe("patch", () => {
  it("eksik alan = değişmedi; olmayan id store tarafından yok sayılır", () => {
    const stream = createLayerStream(store, { layerId: "birlikler", format: STREAM_FORMAT.PATCH });
    store.transaction((tx) =>
      tx.upsertFeatures([{ id: "u1", layerId: "birlikler", kind: "milsym", geometry: point(32), props: { sidc: "a" } }]),
    );
    stream.update([{ id: "u1", geometry: point(33) }, { id: "yok", geometry: point(1) }]);
    expect(store.getFeature("u1")?.props).toEqual({ sidc: "a" });
    expect(store.getFeature("u1")?.geometry).toEqual(point(33));
    expect(store.stats.ignoredPatches).toBe(1);
  });

  it("format çağrı bazında da verilebilir", () => {
    const stream = createLayerStream(store, { layerId: "birlikler" }); // varsayılan full
    stream.update([{ id: "u1", kind: "milsym", geometry: point(32), props: { sidc: "a" } }]);
    stream.update([{ id: "u1", geometry: point(33) } as StreamItem], STREAM_FORMAT.PATCH);
    expect(store.getFeature("u1")?.props).toEqual({ sidc: "a" });
  });
});

describe("normalize ve silme", () => {
  type Backend = { uid: number; x: number; y: number; code: string; deleted?: boolean; heartbeat?: boolean };

  const normalize = (m: Backend): StreamItem | null => {
    if (m.heartbeat) return null;
    if (m.deleted) return { id: `u${m.uid}`, removed: true };
    return { id: `u${m.uid}`, kind: "milsym", geometry: { kind: GEOMETRY_KIND.POINT, coord: [m.x, m.y] }, props: { sidc: m.code } };
  };

  it("backend biçimi modele çevrilir; null atlanır; silme mesajı unsuru siler", () => {
    const stream = createLayerStream<Backend>(store, { layerId: "birlikler", normalize });
    stream.update([
      { uid: 1, x: 32, y: 39, code: "a" },
      { uid: 2, x: 33, y: 39, code: "b" },
      { uid: 0, x: 0, y: 0, code: "", heartbeat: true },
    ]);
    expect(store.getFeature("u1")?.geometry).toEqual(point(32));
    expect(stream.stats).toEqual({ received: 3, skipped: 1, wrongLayer: 0 });

    stream.update([{ uid: 1, x: 0, y: 0, code: "", deleted: true }]);
    expect(store.getFeature("u1")).toBeUndefined();
    expect(store.getFeature("u2")).toBeDefined();
  });

  it("karışık paket sırayla uygulanır (ekle → sil → yeniden ekle)", () => {
    const stream = createLayerStream<Backend>(store, { layerId: "birlikler", normalize });
    stream.update([
      { uid: 1, x: 32, y: 39, code: "a" },
      { uid: 1, x: 0, y: 0, code: "", deleted: true },
      { uid: 1, x: 34, y: 39, code: "c" },
    ]);
    expect(store.getFeature("u1")?.props).toEqual({ sidc: "c" });
  });

  it("bir paket = tek transaction (abone bir kez uyanır)", () => {
    const stream = createLayerStream<Backend>(store, { layerId: "birlikler", normalize });
    const onChanges = vi.fn();
    store.subscribeChanges(onChanges);
    stream.update(Array.from({ length: 100 }, (_, i) => ({ uid: i, x: 32, y: 39, code: "a" })));
    expect(onChanges).toHaveBeenCalledTimes(1);
  });

  it("remove(ids)", () => {
    const stream = createLayerStream<Backend>(store, { layerId: "birlikler", normalize });
    stream.update([{ uid: 1, x: 32, y: 39, code: "a" }]);
    stream.remove(["u1"]);
    expect(store.getFeature("u1")).toBeUndefined();
  });
});

describe("snapshot (yeniden bağlanma)", () => {
  it("katman listeyle eşitlenir; diğer katmanlara dokunulmaz; silme/null atlanır", () => {
    const stream = createLayerStream(store, { layerId: "birlikler" });
    store.transaction((tx) =>
      tx.upsertFeatures([{ id: "c1", layerId: "cizimler", kind: "vector", geometry: point(1) } as Feature]),
    );
    stream.update([
      { id: "u1", kind: "milsym", geometry: point(32) },
      { id: "u2", kind: "milsym", geometry: point(33) },
    ]);

    stream.snapshot([{ id: "u2", kind: "milsym", geometry: point(33) }, { id: "u3", removed: true }]);
    expect(store.getFeature("u1")).toBeUndefined();
    expect(store.getFeature("u2")).toBeDefined();
    expect(store.getFeature("c1")).toBeDefined();
    expect(stream.stats.skipped).toBe(1);
  });
});
