import { describe, expect, it, vi } from "vitest";
import { EventRouter, MAP_EVENT, type MapEventSink } from "../events/event-router";
import { BASEMAP_SOURCE } from "../model/basemap";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import { BasemapProviderRegistry } from "../registry/basemap-provider-registry";
import { FeatureKindRegistry } from "../registry/feature-kind-registry";
import { SymbologyRegistry } from "../registry/symbology-registry";
import { FEATURE_CHANGE_ALL } from "../store/change";
import { createMapStore } from "../store/map-store";
import { MockAdapter } from "./mock-adapter";
import { isEmptyBatch, RENDER_CHANGE, RENDER_CHANGE_ALL, type MountOptions, type RenderFeature } from "./types";

const feature: Feature = {
  id: "f1",
  layerId: "l1",
  kind: "marker",
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [1, 2] },
};

const rf = (over: Partial<RenderFeature> = {}): RenderFeature => ({
  feature,
  groupId: "l1",
  opacity: 1,
  zIndex: 0,
  changed: RENDER_CHANGE_ALL,
  ...over,
});

const mountOptions = (events: MapEventSink = { emit: vi.fn() }): MountOptions => ({
  initialView: { center: [32, 39], zoom: 6 },
  events,
  kinds: new FeatureKindRegistry(),
  symbology: new SymbologyRegistry(),
  basemapProviders: new BasemapProviderRegistry(),
});

const container = {} as HTMLElement; // çekirdek DOM'a dokunmaz; yalnız tip

describe("RENDER_CHANGE", () => {
  it("efektif değer bitleri unsur bitleriyle çakışmaz", () => {
    for (const bit of Object.values(RENDER_CHANGE)) expect(bit & FEATURE_CHANGE_ALL).toBe(0);
    expect(RENDER_CHANGE_ALL & FEATURE_CHANGE_ALL).toBe(FEATURE_CHANGE_ALL);
  });
});

describe("isEmptyBatch", () => {
  it("boş ve dolu batch", () => {
    expect(isEmptyBatch({})).toBe(true);
    expect(isEmptyBatch({ features: { upsert: [], remove: [] }, state: [] })).toBe(true);
    expect(isEmptyBatch({ features: { upsert: [], remove: ["x"] } })).toBe(false);
    expect(isEmptyBatch({ state: [{ id: "x", state: { selected: true } }] })).toBe(false);
  });
});

describe("MockAdapter", () => {
  it("mount: başlangıç görünümü ve olay hedefi alınır", async () => {
    const adapter = new MockAdapter();
    await adapter.mount(container, mountOptions());
    expect(adapter.mounted).toBe(true);
    expect(adapter.getView()).toEqual({ center: [32, 39], zoom: 6 });
  });

  it("applyBatch: kaydeder ve ekran durumunu günceller (önce silme, sonra ekleme)", () => {
    const adapter = new MockAdapter();
    adapter.applyBatch({
      basemaps: { upsert: [{ id: "osm", name: "OSM", source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: "u" }, visible: true, opacity: 1, order: 0 }], remove: [] },
      groups: { upsert: [{ id: "l1", layerId: "l1", order: 0 }], remove: [] },
      features: { upsert: [rf()], remove: [] },
      state: [{ id: "f1", state: { selected: true } }],
    });
    adapter.applyBatch({
      features: { upsert: [rf({ opacity: 0.5, changed: RENDER_CHANGE.OPACITY })], remove: ["f1"] },
      state: [{ id: "f1", state: { hovered: true } }],
    });

    expect(adapter.batches).toHaveLength(2);
    expect(adapter.features.get("f1")?.opacity).toBe(0.5); // remove sonra upsert
    expect(adapter.states.get("f1")).toEqual({ selected: true, hovered: true }); // durum birleşir
    expect(adapter.basemaps.has("osm")).toBe(true);
    expect(adapter.groups.get("l1")?.order).toBe(0);
  });

  it("takeBatches kaydı boşaltır", () => {
    const adapter = new MockAdapter();
    adapter.applyBatch({});
    expect(adapter.takeBatches()).toHaveLength(1);
    expect(adapter.batches).toHaveLength(0);
  });

  it("emit: mount sırasında verilen hedefe (EventRouter) iletir", async () => {
    const store = createMapStore();
    const router = new EventRouter(store);
    const onClick = vi.fn();
    router.on(MAP_EVENT.CLICK, onClick);

    const adapter = new MockAdapter();
    await adapter.mount(container, mountOptions(router));
    adapter.emit({ type: MAP_EVENT.CLICK, coord: [1, 2] });
    expect(onClick).toHaveBeenCalledWith(expect.objectContaining({ coord: [1, 2] }));
  });

  it("mount edilmeden emit → hata; unmount ekranı temizler", async () => {
    const adapter = new MockAdapter();
    expect(() => adapter.emit({ type: MAP_EVENT.CLICK })).toThrow(/mount/);

    await adapter.mount(container, mountOptions());
    adapter.applyBatch({ features: { upsert: [rf()], remove: [] } });
    adapter.unmount();
    expect(adapter.mounted).toBe(false);
    expect(adapter.features.size).toBe(0);
  });

  it("kamera: setView birleştirir, fitBounds merkeze alır; project/unproject özdeşlik", () => {
    const adapter = new MockAdapter();
    adapter.setView({ center: [0, 0], zoom: 3 });
    adapter.setView({ center: [5, 5] });
    expect(adapter.getView()).toEqual({ center: [5, 5], zoom: 3 });
    adapter.fitBounds({ min: [0, 0], max: [10, 20] });
    expect(adapter.getView().center).toEqual([5, 10]);
    expect(adapter.unproject(adapter.project([3, 4]))).toEqual([3, 4]);
  });

  it("yetenekler varsayılan + üzerine yazılabilir; çizim modu / önizleme kaydedilir", () => {
    const adapter = new MockAdapter({ models3d: true });
    expect(adapter.capabilities.models3d).toBe(true);
    expect(adapter.capabilities.featureState).toBe(true);
    expect(adapter.capabilities.draw).toBe(true);
    adapter.setDrawMode(true);
    adapter.setDrawPreview({ shape: { kind: GEOMETRY_KIND.POINT, coord: [1, 2] }, vertices: [], guides: [] });
    expect(adapter.drawMode).toBe(true);
    expect(adapter.drawPreview?.shape).toEqual({ kind: "point", coord: [1, 2] });
  });
});
