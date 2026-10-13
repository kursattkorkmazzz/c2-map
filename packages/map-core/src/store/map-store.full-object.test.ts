// En kötü durum: backend her mesajda birliğin TAMAMINI gönderir (karar #10).
// Store, içeriği aynı kalan alanlar için eski referansı korumalı; günlüğe yalnız gerçekten
// değişen bitler yazılmalı; aboneler gereksiz yere uyandırılmamalı.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockAdapter } from "../adapter/mock-adapter";
import { BASEMAP_SOURCE, type Basemap } from "../model/basemap";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import { MapSync } from "../sync/map-sync";
import { createManualScheduler } from "../sync/scheduler";
import { BASEMAP_CHANGE, CHANGE_OP, FEATURE_CHANGE } from "./change";
import { createMapStore, type MapStore } from "./map-store";

/** Backend mesajı: JSON'dan çözülmüş gibi her seferinde yepyeni nesneler. */
const message = (id: string, lon: number, sidc = "10031000161211000000"): Feature =>
  JSON.parse(
    JSON.stringify({
      id,
      layerId: "birlikler",
      kind: "milsym",
      geometry: { kind: GEOMETRY_KIND.POINT, coord: [lon, 39] },
      style: { size: 24 },
      props: { sidc, modifiers: { echelon: "16" } },
      meta: { yakit: 80 },
    }),
  ) as Feature;

let store: MapStore;
beforeEach(() => {
  store = createMapStore({ now: () => 0 });
  store.transaction((tx) => {
    tx.upsertLayers([{ id: "birlikler", name: "Birlikler", parentId: null, visible: true, opacity: 1 }]);
    tx.upsertFeatures([message("u1", 32), message("u2", 33)]);
  });
  store.drainChanges();
});

describe("tam nesne akışı (upsert)", () => {
  it("yalnız konum değişti → günlükte yalnız GEOMETRY; props/style eski referans", () => {
    const before = store.getFeature("u1")!;
    store.transaction((tx) => tx.upsertFeatures([message("u1", 32.5)]));

    const after = store.getFeature("u1")!;
    expect(after.props).toBe(before.props);
    expect(after.style).toBe(before.style);
    expect(after.meta).toBe(before.meta);
    expect(store.drainChanges().features.get("u1")).toEqual({ op: CHANGE_OP.UPDATE, mask: FEATURE_CHANGE.GEOMETRY });
  });

  it("hiçbir şey değişmedi → günlük boş, nesne aynı, abone uyanmaz", () => {
    const before = store.getFeature("u1")!;
    const onU1 = vi.fn();
    store.subscribeFeature("u1", onU1);

    store.transaction((tx) => tx.upsertFeatures([message("u1", 32)]));
    expect(store.getFeature("u1")).toBe(before);
    expect(store.drainChanges().features.size).toBe(0);
    expect(onU1).not.toHaveBeenCalled();
  });

  it("sembol değişti → PROPS biti (konum aynıysa GEOMETRY yok)", () => {
    store.transaction((tx) => tx.upsertFeatures([message("u1", 32, "10061000161211000000")]));
    expect(store.drainChanges().features.get("u1")).toEqual({ op: CHANGE_OP.UPDATE, mask: FEATURE_CHANGE.PROPS });
  });

  it("snapshot (replaceLayerContents) aynı içerikle → günlük boş", () => {
    store.transaction((tx) => tx.replaceLayerContents("birlikler", [message("u1", 32), message("u2", 33)]));
    expect(store.drainChanges().features.size).toBe(0);
  });
});

describe("kısmi patch, aynı değerlerle yeni nesneler", () => {
  it("aynı koordinatlı yeni geometry → değişiklik yok", () => {
    store.transaction((tx) =>
      tx.patchFeatures([{ id: "u1", geometry: { kind: GEOMETRY_KIND.POINT, coord: [32, 39] } }]),
    );
    expect(store.drainChanges().features.size).toBe(0);
  });

  it("iç içe nesnesi yeni ama içeriği aynı props → değişiklik yok", () => {
    store.transaction((tx) => tx.patchFeatures([{ id: "u1", props: { modifiers: { echelon: "16" } } }]));
    expect(store.drainChanges().features.size).toBe(0);
  });
});

describe("altlık: aynı içerikli yeni source", () => {
  it("SOURCE biti üretilmez (adapter tile kaynağını baştan yüklemez)", () => {
    const basemap = (opacity: number): Basemap =>
      JSON.parse(
        JSON.stringify({
          id: "wms",
          name: "WMS",
          source: { type: BASEMAP_SOURCE.WMS, url: "https://wms", layers: "uydu", params: { TIME: "2026" } },
          visible: true,
          opacity,
          order: 0,
        }),
      ) as Basemap;

    store.transaction((tx) => tx.upsertBasemaps([basemap(1)]));
    store.drainChanges();
    store.transaction((tx) => tx.upsertBasemaps([basemap(0.5)]));
    expect(store.drainChanges().basemaps.get("wms")).toEqual({ op: CHANGE_OP.UPDATE, mask: BASEMAP_CHANGE.OPACITY });
  });
});

describe("uçtan uca: tam nesne akışı → MapSync → adapter", () => {
  it("adapter yalnız GEOMETRY biti görür (ikon/stil yeniden hesaplanmaz)", () => {
    const adapter = new MockAdapter();
    const scheduler = createManualScheduler();
    new MapSync({ store, adapter, scheduler }).start();
    adapter.takeBatches();

    store.transaction((tx) => tx.upsertFeatures([message("u1", 32.1), message("u2", 33)])); // u2 aynı
    scheduler.run();

    const [batch] = adapter.takeBatches();
    expect(batch?.features?.upsert).toHaveLength(1);
    expect(batch?.features?.upsert[0]).toMatchObject({ changed: FEATURE_CHANGE.GEOMETRY });
  });
});
