import { beforeEach, describe, expect, it } from "vitest";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import type { Layer } from "../model/layer";
import { CHANGE_OP, FEATURE_CHANGE, FEATURE_CHANGE_ALL } from "./change";
import { createMapStore, type MapStore, type MapTx } from "./map-store";

const { ADD, UPDATE, REMOVE } = CHANGE_OP;

const layer = (id: string, parentId: string | null = null): Layer => ({
  id,
  name: id,
  parentId,
  visible: true,
  opacity: 1,
});

const unit = (id: string, lon: number, over: Partial<Feature> = {}): Feature => ({
  id,
  layerId: "birlikler",
  kind: "milsym",
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [lon, 39] },
  ...over,
});

let store: MapStore;
const write = (fn: (tx: MapTx) => void) => store.transaction(fn);
const idsIn = (layerId: string) => [...store.getFeatureIds(layerId)].sort();

/**
 * birlikler: u1, u2, u3      (canlı akışın katmanı)
 * cizimler : c1              (kullanıcı çizimi — snapshot'tan etkilenmemeli)
 * birlikler/alt: a1          (alt katman — "doğrudan unsur" değil, etkilenmemeli)
 */
beforeEach(() => {
  store = createMapStore({ now: () => 0 });
  write((tx) => {
    tx.upsertLayers([layer("birlikler"), layer("alt", "birlikler"), layer("cizimler")]);
    tx.upsertFeatures([
      unit("u1", 1, { rev: 10 }),
      unit("u2", 2, { rev: 10 }),
      unit("u3", 3, { rev: 10 }),
      unit("a1", 9, { layerId: "alt" }),
      unit("c1", 7, { layerId: "cizimler", kind: "vector" }),
    ]);
  });
  store.drainChanges();
});

describe("replaceLayerContents", () => {
  it("snapshot'ta olmayan silinir, olan güncellenir, yeni olan eklenir", () => {
    const u2 = store.getFeature("u2")!;
    write((tx) =>
      tx.replaceLayerContents("birlikler", [
        unit("u1", 1.5, { rev: 11 }), // konum değişti
        u2, // aynı (referans korunmalı)
        unit("u4", 4), // yeni
        // u3 yok → silinmeli
      ]),
    );

    expect(idsIn("birlikler")).toEqual(["u1", "u2", "u4"]);
    expect(store.getFeature("u3")).toBeUndefined();
    expect(store.getFeature("u2")).toBe(u2);

    const changes = store.drainChanges();
    expect(Object.fromEntries(changes.features)).toEqual({
      u1: { op: UPDATE, mask: FEATURE_CHANGE.GEOMETRY },
      u3: { op: REMOVE, mask: 0 },
      u4: { op: ADD, mask: FEATURE_CHANGE_ALL },
    });
  });

  it("diğer katmanlara (alt katman dahil) dokunulmaz", () => {
    write((tx) => tx.replaceLayerContents("birlikler", []));
    expect(idsIn("birlikler")).toEqual([]);
    expect(idsIn("alt")).toEqual(["a1"]);
    expect(idsIn("cizimler")).toEqual(["c1"]);
    expect(store.getLayer("alt")).toBeDefined(); // katmanlar silinmez, yalnız unsurlar
  });

  it("boş snapshot katmanı boşaltır", () => {
    write((tx) => tx.replaceLayerContents("birlikler", []));
    const changes = store.drainChanges();
    expect([...changes.features.keys()].sort()).toEqual(["u1", "u2", "u3"]);
    for (const c of changes.features.values()) expect(c.op).toBe(REMOVE);
  });

  it("rev kontrolü yapılmaz: daha eski rev'li snapshot da uygulanır (sunucu yeniden başladı)", () => {
    write((tx) => tx.replaceLayerContents("birlikler", [unit("u1", 100, { rev: 1 })]));
    expect(store.getFeature("u1")?.geometry).toEqual({ kind: GEOMETRY_KIND.POINT, coord: [100, 39] });
    expect(store.stats.droppedStale).toBe(0);
  });

  it("rev durumu snapshot'tan yeniden kurulur: sonraki delta yeni rev'e göre değerlendirilir", () => {
    write((tx) => tx.replaceLayerContents("birlikler", [unit("u1", 1, { rev: 1 })]));
    write((tx) => tx.patchFeatures([{ id: "u1", rev: 2, z: 5 }])); // eski rev 10'a göre düşerdi
    expect(store.getFeature("u1")?.z).toBe(5);
    expect(store.stats.droppedStale).toBe(0);
  });

  it("rev'siz snapshot eski rev'i unutturur", () => {
    write((tx) => tx.replaceLayerContents("birlikler", [unit("u1", 1)]));
    write((tx) => tx.patchFeatures([{ id: "u1", rev: 3, z: 1 }]));
    expect(store.getFeature("u1")?.z).toBe(1);
  });

  it("layerId'si farklı unsur atlanır ve sayılır; mevcut yeri etkilenmez", () => {
    write((tx) =>
      tx.replaceLayerContents("birlikler", [
        unit("u1", 1, { rev: 10 }),
        unit("c1", 7, { layerId: "cizimler", kind: "vector" }), // yanlış kapsam
      ]),
    );
    expect(store.stats.rejectedSnapshotItems).toBe(1);
    expect(store.getFeature("c1")?.layerId).toBe("cizimler");
    expect(idsIn("birlikler")).toEqual(["u1"]);
  });

  it("başka katmanda duran aynı id'li unsur bu katmana taşınır (snapshot yetkili)", () => {
    write((tx) => tx.replaceLayerContents("birlikler", [unit("c1", 7)]));
    expect(store.getFeature("c1")?.layerId).toBe("birlikler");
    expect(idsIn("cizimler")).toEqual([]);
    expect(idsIn("birlikler")).toEqual(["c1"]);
  });

  it("katman henüz yoksa da çalışır (yetim unsurlar)", () => {
    write((tx) => tx.replaceLayerContents("yeni-akis", [unit("y1", 0, { layerId: "yeni-akis" })]));
    expect(idsIn("yeni-akis")).toEqual(["y1"]);
  });

  it("aynı id iki kez gelirse sonuncu kazanır", () => {
    write((tx) => tx.replaceLayerContents("birlikler", [unit("u1", 50), unit("u1", 60)]));
    expect(store.getFeature("u1")?.geometry).toEqual({ kind: GEOMETRY_KIND.POINT, coord: [60, 39] });
    expect(idsIn("birlikler")).toEqual(["u1"]);
  });

  it("aynı içerikli snapshot → günlük boş, referanslar aynı", () => {
    const before = ["u1", "u2", "u3"].map((id) => store.getFeature(id)!);
    write((tx) => tx.replaceLayerContents("birlikler", before));
    expect(store.drainChanges().features.size).toBe(0);
    before.forEach((f) => expect(store.getFeature(f.id)).toBe(f));
  });

  it("tx dışında kullanılamaz", () => {
    let leaked: MapTx | undefined;
    write((tx) => (leaked = tx));
    expect(() => leaked!.replaceLayerContents("birlikler", [])).toThrow(/transaction/);
  });
});
