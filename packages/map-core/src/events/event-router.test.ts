import { beforeEach, describe, expect, it, vi } from "vitest";
import { GEOMETRY_KIND } from "../model/geometry";
import { createMapStore, type MapStore } from "../store/map-store";
import { EventRouter, MAP_EVENT, type MapEvent } from "./event-router";

/**
 * harekat
 * └─ kontrol      (unsur: k1)
 * istihbarat      (unsur: i1)
 */
let store: MapStore;
let router: EventRouter;
let errors: unknown[];

beforeEach(() => {
  store = createMapStore({ now: () => 0 });
  store.transaction((tx) => {
    tx.upsertLayers([
      { id: "harekat", name: "Harekât", parentId: null, visible: true, opacity: 1 },
      { id: "kontrol", name: "Kontrol", parentId: "harekat", visible: true, opacity: 1 },
      { id: "istihbarat", name: "İstihbarat", parentId: null, visible: true, opacity: 1 },
    ]);
    const point = { kind: GEOMETRY_KIND.POINT, coord: [0, 0] } as const;
    tx.upsertFeatures([
      { id: "k1", layerId: "kontrol", kind: "marker", geometry: point },
      { id: "i1", layerId: "istihbarat", kind: "marker", geometry: point },
      { id: "yetim", layerId: "olmayan", kind: "marker", geometry: point },
    ]);
  });
  errors = [];
  router = new EventRouter(store, { onListenerError: (e) => errors.push(e) });
});

const click = (featureId?: string) => router.emit({ type: MAP_EVENT.CLICK, featureId, coord: [1, 2] });

describe("dağıtım ve kabarma", () => {
  it("sıra: unsur → katmanı → ebeveyn katman → global", () => {
    const order: string[] = [];
    router.on(MAP_EVENT.CLICK, () => order.push("global"));
    router.on(MAP_EVENT.CLICK, () => order.push("harekat"), { layerId: "harekat" });
    router.on(MAP_EVENT.CLICK, () => order.push("kontrol"), { layerId: "kontrol" });
    router.on(MAP_EVENT.CLICK, () => order.push("k1"), { featureId: "k1" });
    click("k1");
    expect(order).toEqual(["k1", "kontrol", "harekat", "global"]);
  });

  it("başka unsurun veya başka katmanın dinleyicisi çağrılmaz", () => {
    const onI1 = vi.fn();
    const onIstihbarat = vi.fn();
    router.on(MAP_EVENT.CLICK, onI1, { featureId: "i1" });
    router.on(MAP_EVENT.CLICK, onIstihbarat, { layerId: "istihbarat" });
    click("k1");
    expect(onI1).not.toHaveBeenCalled();
    expect(onIstihbarat).not.toHaveBeenCalled();
  });

  it("unsursuz olay (boşluğa tıklama) yalnız global dinleyicilere gider", () => {
    const onGlobal = vi.fn();
    const onLayer = vi.fn();
    router.on(MAP_EVENT.CLICK, onGlobal);
    router.on(MAP_EVENT.CLICK, onLayer, { layerId: "harekat" });
    click();
    expect(onGlobal).toHaveBeenCalledTimes(1);
    expect(onLayer).not.toHaveBeenCalled();
  });

  it("olay türleri birbirine karışmaz", () => {
    const onClick = vi.fn();
    router.on(MAP_EVENT.CLICK, onClick);
    router.emit({ type: MAP_EVENT.CONTEXT_MENU, featureId: "k1" });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("olay verisi ve currentTarget doğru", () => {
    const seen: MapEvent[] = [];
    router.on(MAP_EVENT.CLICK, (e) => seen.push(e), { featureId: "k1" });
    router.on(MAP_EVENT.CLICK, (e) => seen.push(e), { layerId: "harekat" });
    router.on(MAP_EVENT.CLICK, (e) => seen.push(e));
    click("k1");
    expect(seen.map((e) => e.currentTarget)).toEqual([{ featureId: "k1" }, { layerId: "harekat" }, undefined]);
    expect(seen.every((e) => e.featureId === "k1" && e.coord?.[0] === 1)).toBe(true);
  });

  it("katman zinciri store'dan güncel okunur (taşınan katman yeni ebeveyne kabarır)", () => {
    const onIstihbarat = vi.fn();
    router.on(MAP_EVENT.CLICK, onIstihbarat, { layerId: "istihbarat" });
    store.transaction((tx) => tx.moveLayer("kontrol", "istihbarat"));
    click("k1");
    expect(onIstihbarat).toHaveBeenCalledTimes(1);
  });

  it("yetim unsur: kendi layerId dinleyicisine ve globale gider", () => {
    const order: string[] = [];
    router.on(MAP_EVENT.CLICK, () => order.push("olmayan"), { layerId: "olmayan" });
    router.on(MAP_EVENT.CLICK, () => order.push("global"));
    click("yetim");
    expect(order).toEqual(["olmayan", "global"]);
  });

  it("store'da olmayan unsur id'si: unsur dinleyicisi + global", () => {
    const order: string[] = [];
    router.on(MAP_EVENT.CLICK, () => order.push("unsur"), { featureId: "silinmis" });
    router.on(MAP_EVENT.CLICK, () => order.push("global"));
    click("silinmis");
    expect(order).toEqual(["unsur", "global"]);
  });
});

describe("stopPropagation", () => {
  it("sonraki hedefleri keser, aynı hedefteki diğer dinleyiciler çalışır", () => {
    const order: string[] = [];
    router.on(MAP_EVENT.CLICK, (e) => {
      order.push("k1-a");
      e.stopPropagation();
    }, { featureId: "k1" });
    router.on(MAP_EVENT.CLICK, () => order.push("k1-b"), { featureId: "k1" });
    router.on(MAP_EVENT.CLICK, () => order.push("kontrol"), { layerId: "kontrol" });
    router.on(MAP_EVENT.CLICK, () => order.push("global"));
    click("k1");
    expect(order).toEqual(["k1-a", "k1-b"]);
  });

  it("katman seviyesinde durdurma globale ulaşmaz", () => {
    const onGlobal = vi.fn();
    router.on(MAP_EVENT.CLICK, (e) => e.stopPropagation(), { layerId: "harekat" });
    router.on(MAP_EVENT.CLICK, onGlobal);
    click("k1");
    expect(onGlobal).not.toHaveBeenCalled();
  });
});

describe("sentetik (küme) id", () => {
  it("katman zincirine kabarmaz, yalnız globale gider", () => {
    const onLayer = vi.fn();
    const onGlobal = vi.fn();
    router.on(MAP_EVENT.CLUSTER_CLICK, onLayer, { layerId: "harekat" });
    router.on(MAP_EVENT.CLUSTER_CLICK, onGlobal);
    router.emit({ type: MAP_EVENT.CLUSTER_CLICK, featureId: "cluster:42", data: { ids: ["k1"] } });
    expect(onLayer).not.toHaveBeenCalled();
    expect(onGlobal).toHaveBeenCalledWith(expect.objectContaining({ data: { ids: ["k1"] } }));
  });
});

describe("abonelik yönetimi ve hatalar", () => {
  it("abonelikten çıkınca çağrılmaz; iki kez çıkmak zararsız", () => {
    const onK1 = vi.fn();
    const off = router.on(MAP_EVENT.CLICK, onK1, { featureId: "k1" });
    off();
    off();
    click("k1");
    expect(onK1).not.toHaveBeenCalled();
  });

  it("dinleyici hatası diğerlerini ve kabarmayı durdurmaz, raporlanır", () => {
    const onGlobal = vi.fn();
    router.on(MAP_EVENT.CLICK, () => {
      throw new Error("patladı");
    }, { featureId: "k1" });
    router.on(MAP_EVENT.CLICK, onGlobal);
    click("k1");
    expect(onGlobal).toHaveBeenCalledTimes(1);
    expect((errors[0] as Error).message).toBe("patladı");
  });

  it("dinleyici olmayan türde emit sorunsuz", () => {
    expect(() => router.emit({ type: MAP_EVENT.VIEW_CHANGE })).not.toThrow();
  });
});
