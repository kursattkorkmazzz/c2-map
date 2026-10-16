import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockAdapter } from "../adapter/mock-adapter";
import { RENDER_CHANGE_ALL, type RenderBatch } from "../adapter/types";
import { EventRouter, MAP_EVENT } from "../events/event-router";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import { FEATURE_CHANGE } from "../store/change";
import { createMapStore, type MapStore, type MapTx } from "../store/map-store";
import { MapSync } from "../sync/map-sync";
import { createManualScheduler, type ManualScheduler } from "../sync/scheduler";
import { bindClusterEvents } from "./cluster-events";
import { CLUSTER_KIND, ClusterStage, type ClusterInfo, type ClusterProps } from "./cluster-stage";

// zoom 5'te hücre (64 px) ≈ 1,4°: (0,1 ; 0,1) ve (0,2 ; 0,1) aynı hücrede, (10 ; 10) uzakta.
const unit = (id: string, lon: number, lat = 0.1, over: Partial<Feature> = {}): Feature => ({
  id,
  layerId: "birlikler",
  kind: "milsym",
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [lon, lat] },
  ...over,
});

let store: MapStore;
let adapter: MockAdapter;
let scheduler: ManualScheduler;
let sync: MapSync;
let stage: ClusterStage;
const write = (fn: (tx: MapTx) => void) => store.transaction(fn);
const frame = (): RenderBatch | undefined => {
  scheduler.run();
  return adapter.takeBatches().at(-1);
};
/** Adapter'ın "ekranında" olanlar. */
const onScreen = () => [...adapter.features.keys()].sort();
const clusters = () => [...adapter.features.values()].filter((rf) => rf.feature.kind === CLUSTER_KIND);
const zoomTo = (zoom: number) => {
  sync.setView({ center: [0, 0], zoom });
};

function setup(options: ConstructorParameters<typeof ClusterStage>[0] = {}) {
  store = createMapStore();
  adapter = new MockAdapter();
  scheduler = createManualScheduler();
  stage = new ClusterStage(options);
  sync = new MapSync({ store, adapter, scheduler, stages: [stage] });
  write((tx) => tx.upsertLayers([{ id: "birlikler", name: "Birlikler", parentId: null, visible: true, opacity: 1, renderGroup: true }]));
}

describe("ClusterStage", () => {
  beforeEach(() => setup());

  it("görünüm bilinmeden kümeleme yok; zoom gelince yakın noktalar tek kümede", () => {
    write((tx) => tx.upsertFeatures([unit("a", 0.1), unit("b", 0.2), unit("c", 10, 10)]));
    sync.start();
    expect(onScreen()).toEqual(["a", "b", "c"]);

    zoomTo(5.4);
    const [cluster] = clusters();
    expect(onScreen()).toEqual([cluster!.feature.id, "c"].sort());
    expect(cluster!.feature.id.startsWith("cluster:")).toBe(true);
    expect(cluster!.feature.props as ClusterProps).toEqual({ count: 2, key: "" });
    expect(cluster!.feature.geometry).toEqual({ kind: "point", coord: [0.15000000000000002, 0.1] });
    expect(cluster!.groupId).toBe("birlikler");

    // Aynı tam sayı zoom içinde değişiklik yok; maxZoom üstünde kümeleme kalkar
    expect(stage.onViewChange({ center: [0, 0], zoom: 5.9 }, { store, view: null })).toBeNull();
    zoomTo(14);
    expect(onScreen()).toEqual(["a", "b", "c"]);
    const back = adapter.batches.at(-1)!;
    expect(back.features!.upsert.every((rf) => rf.changed === RENDER_CHANGE_ALL)).toBe(true); // adapter'da yoktular
  });

  it("canlı akış: kümedeki unsurun güncellemesi adapter'a gitmez, yalnız küme merkezi; hücreden çıkınca açılır", () => {
    zoomTo(5);
    sync.start();
    write((tx) => tx.upsertFeatures([unit("a", 0.1), unit("b", 0.2)]));
    frame();
    const id = clusters()[0]!.feature.id;

    write((tx) => tx.patchFeatures([{ id: "a", geometry: { kind: GEOMETRY_KIND.POINT, coord: [0.3, 0.1] } }]));
    const moved = frame()!;
    expect(moved.features!.upsert.map((rf) => rf.feature.id)).toEqual([id]);
    expect(moved.features!.upsert[0]!.changed).toBe(FEATURE_CHANGE.GEOMETRY);
    expect(moved.features!.remove).toEqual([]);

    write((tx) => tx.patchFeatures([{ id: "a", geometry: { kind: GEOMETRY_KIND.POINT, coord: [8, 8] } }]));
    frame();
    expect(onScreen()).toEqual(["a", "b"]);
    expect(adapter.features.get("b")!.changed).toBe(RENDER_CHANGE_ALL);
  });

  it("silme: gizli unsurun silinmesi adapter'a gitmez; küme tek üyeye inince kalkar", () => {
    zoomTo(5);
    sync.start();
    write((tx) => tx.upsertFeatures([unit("a", 0.1), unit("b", 0.2), unit("c", 0.25)]));
    frame();
    expect((clusters()[0]!.feature.props as ClusterProps).count).toBe(3);
    write((tx) => tx.removeFeatures(["a"]));
    const b = frame()!;
    expect(b.features!.remove).toEqual([]);
    expect((clusters()[0]!.feature.props as ClusterProps).count).toBe(2);
    write((tx) => tx.removeFeatures(["b"]));
    frame();
    expect(onScreen()).toEqual(["c"]);
  });

  it("sembol-farkında: anahtarı farklı unsurlar aynı hücrede ayrı kümelenir", () => {
    setup({ clusterKey: (f) => String((f.props as { side: string }).side) });
    zoomTo(5);
    sync.start();
    write((tx) =>
      tx.upsertFeatures([
        unit("d1", 0.1, 0.1, { props: { side: "dost" } }),
        unit("d2", 0.2, 0.1, { props: { side: "dost" } }),
        unit("h1", 0.15, 0.1, { props: { side: "düşman" } }),
      ]),
    );
    frame();
    expect(clusters().map((rf) => rf.feature.props as ClusterProps)).toEqual([{ count: 2, key: "dost" }]);
    expect(onScreen()).toContain("h1");
  });

  it("nokta olmayan ve filtre dışı unsurlar dokunulmadan geçer", () => {
    setup({ filter: (f) => f.kind === "milsym" });
    zoomTo(5);
    sync.start();
    write((tx) =>
      tx.upsertFeatures([
        unit("a", 0.1),
        unit("b", 0.2),
        unit("m", 0.12, 0.1, { kind: "marker" }),
        { id: "p", layerId: "birlikler", kind: "vector", geometry: { kind: GEOMETRY_KIND.POLYGON, rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      ]),
    );
    frame();
    expect(onScreen()).toEqual([clusters()[0]!.feature.id, "m", "p"].sort());
  });

  it("seçim: kümedeki seçili unsur kümeyi vurgular; küme açılınca durum unsura geri gelir", () => {
    zoomTo(5);
    sync.start();
    write((tx) => tx.upsertFeatures([unit("a", 0.1), unit("b", 0.2)]));
    frame();
    const id = clusters()[0]!.feature.id;

    write((tx) => tx.select(["a"]));
    expect(frame()!.state).toEqual([{ id, state: { selected: true } }]);
    expect(adapter.states.get("a")).toBeUndefined(); // gizli unsura gitmez

    zoomTo(14); // kümeleme kalkar
    expect(adapter.states.get("a")).toEqual({ selected: true });
    expect(adapter.features.has(id)).toBe(false);

    zoomTo(5);
    write((tx) => tx.clearSelection());
    frame();
    const newId = clusters()[0]!.feature.id;
    expect(adapter.states.get(newId)).toEqual({ selected: false });
  });

  it("aşama sonradan eklenir / kaldırılır: adapter'daki unsurlar gizlenir, kümeler temizlenir", () => {
    store = createMapStore();
    adapter = new MockAdapter();
    scheduler = createManualScheduler();
    sync = new MapSync({ store, adapter, scheduler });
    write((tx) => tx.upsertLayers([{ id: "birlikler", name: "Birlikler", parentId: null, visible: true, opacity: 1 }]));
    write((tx) => tx.upsertFeatures([unit("a", 0.1), unit("b", 0.2)]));
    sync.start();
    sync.setView({ center: [0, 0], zoom: 5 });
    expect(onScreen()).toEqual(["a", "b"]);

    stage = new ClusterStage();
    sync.setStages([stage]);
    frame();
    expect(onScreen()).toEqual([clusters()[0]!.feature.id]);

    sync.setStages([]);
    frame();
    expect(onScreen()).toEqual(["a", "b"]);
  });

  it("küme tıklaması → CLUSTER_CLICK (üye id'leri ve sınır kutusuyla)", () => {
    zoomTo(5);
    sync.start();
    write((tx) => tx.upsertFeatures([unit("a", 0.1), unit("b", 0.2, 0.3)]));
    frame();
    const id = clusters()[0]!.feature.id;
    const router = new EventRouter(store);
    bindClusterEvents(router, stage);
    const onCluster = vi.fn();
    router.on(MAP_EVENT.CLUSTER_CLICK, onCluster);
    router.emit({ type: MAP_EVENT.CLICK, featureId: id, coord: [0.15, 0.2] });
    router.emit({ type: MAP_EVENT.CLICK, featureId: "a" }); // gerçek unsur: CLUSTER_CLICK değil
    expect(onCluster).toHaveBeenCalledTimes(1);
    const info = onCluster.mock.calls[0]![0].data as ClusterInfo;
    expect([...info.ids].sort()).toEqual(["a", "b"]);
    expect(info.bounds).toEqual({ min: [0.1, 0.1], max: [0.2, 0.3] });
    expect(info.zoom).toBe(5);
    expect(stage.stats).toEqual({ tracked: 2, hidden: 2, clusters: 1, zoom: 5 });
  });

  it("50k birlik: ilk kurulum ve 1 Hz akışta kare başına iş makul", () => {
    zoomTo(6);
    sync.start();
    const n = 50_000;
    const features = Array.from({ length: n }, (_, i) => unit(`u${i}`, 30 + (i % 250) * 0.02, 38 + Math.floor(i / 250) * 0.015));
    write((tx) => tx.upsertFeatures(features));
    let t0 = performance.now();
    frame();
    const build = performance.now() - t0;
    expect(stage.stats.clusters).toBeGreaterThan(0);
    // 1 Hz / 10 flush → flush başına 5000 hareket
    write((tx) =>
      tx.patchFeatures(
        Array.from({ length: 5000 }, (_, i) => ({ id: `u${i * 10}`, geometry: { kind: GEOMETRY_KIND.POINT, coord: [30.001 + ((i * 10) % 250) * 0.02, 38.001 + Math.floor((i * 10) / 250) * 0.015] } })),
      ),
    );
    t0 = performance.now();
    frame();
    const live = performance.now() - t0;
    t0 = performance.now();
    zoomTo(8);
    const rezoom = performance.now() - t0;
    // Kaba sınırlar (CI'da yavaş makine payı); gerçek ölçüm findings.md'de
    expect(build).toBeLessThan(2000);
    expect(live).toBeLessThan(500);
    expect(rezoom).toBeLessThan(1000);
    console.log(`kümeleme 50k: ilk ${build.toFixed(0)} ms · 5000 hareket ${live.toFixed(1)} ms · zoom değişimi ${rezoom.toFixed(0)} ms`);
  });
});

describe("küme rozeti etiketi", () => {
  it("sınırlı etiket kümesi: 1–99 tam, sonra iki anlamlı basamak", async () => {
    const { clusterLabel, clusterBadgeSize } = await import("./badge");
    expect([1, 42, 99, 104, 145, 999, 1234, 9960, 15300].map(clusterLabel)).toEqual(["1", "42", "99", "100", "150", "1000", "1,2b", "10b", "15b"]);
    expect([2, 10, 100, 1000].map(clusterBadgeSize)).toEqual([28, 34, 40, 48]);
  });
});

describe("ClusterStage — anahtar kaydırması", () => {
  it("aynı hücredeki farklı anahtarlı kümeler ekranda kaydırılır; getCluster gerçek merkezi verir", () => {
    const stage = new ClusterStage({ clusterKey: (f) => f.id[0]!, keyOffsetPx: (key) => (key === "d" ? [-10, 0] : [10, 0]) });
    const rf = (id: string, lon: number) => ({ feature: unit(id, lon), groupId: "g", opacity: 1, zIndex: 0, changed: RENDER_CHANGE_ALL });
    const ctx = { store: createMapStore(), view: { center: [0, 0] as [number, number], zoom: 5 } };
    const out = stage.process({ features: { upsert: [rf("d1", 0.1), rf("d2", 0.2), rf("h1", 0.12), rf("h2", 0.18)], remove: [] } }, ctx);
    const [a, b] = out.features!.upsert.filter((r) => r.feature.kind === CLUSTER_KIND);
    const lonOf = (r: typeof a) => (r!.feature.geometry as unknown as { coord: [number, number] }).coord[0];
    // zoom 5: 1 px ≈ 360 / 16384 = 0,022°; 10 px ≈ 0,22°
    expect(lonOf(a) - 0.15).toBeCloseTo(-0.2197, 3);
    expect(lonOf(b) - 0.15).toBeCloseTo(0.2197, 3);
    expect(stage.getCluster(a!.feature.id)!.center[0]).toBeCloseTo(0.15, 9);
  });
});
