import { describe, expect, it } from "vitest";
import { BASEMAP_SOURCE, type Basemap } from "../model/basemap";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import type { Layer } from "../model/layer";
import {
  BASEMAP_CHANGE,
  FEATURE_CHANGE,
  FEATURE_CHANGE_ALL,
  LAYER_CHANGE,
} from "./change";
import {
  diffBasemap,
  diffFeature,
  diffLayer,
  mergeBasemapPatch,
  mergeFeaturePatch,
  mergeLayerPatch,
  shallowMerge,
} from "./diff";

const feature = (over: Partial<Feature> = {}): Feature => ({
  id: "f1",
  layerId: "l1",
  kind: "marker",
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [32.85, 39.9] },
  style: { color: "red", size: 10 },
  props: { sidc: "10031000161211000000" },
  meta: { fuel: 80 },
  ...over,
});

const layer = (over: Partial<Layer> = {}): Layer => ({
  id: "l1",
  name: "Birlikler",
  parentId: null,
  visible: true,
  opacity: 1,
  ...over,
});

const basemap = (over: Partial<Basemap> = {}): Basemap => ({
  id: "b1",
  name: "OSM",
  source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: "https://t/{z}/{x}/{y}.png" },
  visible: true,
  opacity: 1,
  order: 0,
  ...over,
});

describe("diffFeature", () => {
  it("aynı referans → 0", () => {
    const f = feature();
    expect(diffFeature(f, f)).toBe(0);
  });

  it("yalnız kopyalanmış nesne (alan referansları aynı) → 0", () => {
    const f = feature();
    expect(diffFeature(f, { ...f })).toBe(0);
  });

  it.each([
    ["geometry", { geometry: { kind: GEOMETRY_KIND.POINT, coord: [1, 2] } }, FEATURE_CHANGE.GEOMETRY],
    ["style", { style: { color: "blue" } }, FEATURE_CHANGE.STYLE],
    ["props", { props: { sidc: "x" } }, FEATURE_CHANGE.PROPS],
    ["z", { z: 5 }, FEATURE_CHANGE.Z],
    ["hidden", { hidden: true }, FEATURE_CHANGE.HIDDEN],
    ["layerId", { layerId: "l2" }, FEATURE_CHANGE.LAYER],
    ["selectable", { selectable: false }, FEATURE_CHANGE.INTERACTION],
    ["meta", { meta: { fuel: 50 } }, FEATURE_CHANGE.META],
  ] as const)("%s → doğru bit", (_name, change, bit) => {
    const f = feature();
    expect(diffFeature(f, { ...f, ...change } as Feature)).toBe(bit);
  });

  it("birden fazla alan → bitler OR'lanır", () => {
    const f = feature();
    const next = { ...f, z: 1, meta: { fuel: 1 } };
    expect(diffFeature(f, next)).toBe(FEATURE_CHANGE.Z | FEATURE_CHANGE.META);
  });

  it("içeriği aynı yeni style nesnesi de 'değişti' sayılır (referans karşılaştırması)", () => {
    const f = feature();
    expect(diffFeature(f, { ...f, style: { color: "red", size: 10 } })).toBe(FEATURE_CHANGE.STYLE);
  });

  it("kind değişirse tüm bitler", () => {
    const f = feature();
    expect(diffFeature(f, { ...f, kind: "milsym" })).toBe(FEATURE_CHANGE_ALL);
  });

  it("rev karşılaştırılmaz", () => {
    const f = feature({ rev: 1 });
    expect(diffFeature(f, { ...f, rev: 2 })).toBe(0);
  });
});

describe("diffLayer", () => {
  it.each([
    ["name", { name: "x" }, LAYER_CHANGE.NAME],
    ["visible", { visible: false }, LAYER_CHANGE.VISIBLE],
    ["opacity", { opacity: 0.5 }, LAYER_CHANGE.OPACITY],
    ["minZoom", { minZoom: 5 }, LAYER_CHANGE.ZOOM],
    ["maxZoom", { maxZoom: 12 }, LAYER_CHANGE.ZOOM],
    ["selectable", { selectable: false }, LAYER_CHANGE.INTERACTION],
    ["interactive", { interactive: false }, LAYER_CHANGE.INTERACTION],
    ["renderGroup", { renderGroup: true }, LAYER_CHANGE.RENDER_GROUP],
    ["parentId", { parentId: "p" }, LAYER_CHANGE.PARENT],
    ["meta", { meta: { a: 1 } }, LAYER_CHANGE.META],
  ] as const)("%s → doğru bit", (_name, change, bit) => {
    const l = layer();
    expect(diffLayer(l, { ...l, ...change })).toBe(bit);
  });

  it("değişiklik yok → 0", () => {
    const l = layer();
    expect(diffLayer(l, { ...l })).toBe(0);
  });
});

describe("diffBasemap", () => {
  it.each([
    ["source", { source: { type: BASEMAP_SOURCE.TILEJSON, url: "u" } }, BASEMAP_CHANGE.SOURCE],
    ["visible", { visible: false }, BASEMAP_CHANGE.VISIBLE],
    ["opacity", { opacity: 0.3 }, BASEMAP_CHANGE.OPACITY],
    ["order", { order: 2 }, BASEMAP_CHANGE.ORDER],
    ["name", { name: "x" }, BASEMAP_CHANGE.INFO],
    ["attribution", { attribution: "©" }, BASEMAP_CHANGE.INFO],
    ["exclusiveGroup", { exclusiveGroup: "uydu" }, BASEMAP_CHANGE.INFO],
  ] as const)("%s → doğru bit", (_name, change, bit) => {
    const b = basemap();
    expect(diffBasemap(b, { ...b, ...change } as Basemap)).toBe(bit);
  });

  it("değişiklik yok → 0", () => {
    const b = basemap();
    expect(diffBasemap(b, { ...b })).toBe(0);
  });
});

describe("mergeFeaturePatch", () => {
  it("prev değişmez, yeni nesne döner", () => {
    const f = feature();
    const snapshot = structuredClone(f);
    const next = mergeFeaturePatch(f, { id: "f1", z: 3 });
    expect(next).not.toBe(f);
    expect(f).toEqual(snapshot);
    expect(next.z).toBe(3);
  });

  it("style sığ birleştirilir (yalnız gelen anahtar değişir)", () => {
    const f = feature();
    const next = mergeFeaturePatch(f, { id: "f1", style: { color: "blue" } });
    expect(next.style).toEqual({ color: "blue", size: 10 });
    expect(diffFeature(f, next)).toBe(FEATURE_CHANGE.STYLE);
  });

  it("props ve meta da sığ birleştirilir", () => {
    const f = feature({ props: { sidc: "a", label: "x" }, meta: { fuel: 80, ammo: 5 } });
    const next = mergeFeaturePatch(f, { id: "f1", props: { label: "y" }, meta: { fuel: 70 } });
    expect(next.props).toEqual({ sidc: "a", label: "y" });
    expect(next.meta).toEqual({ fuel: 70, ammo: 5 });
  });

  it("geometry birleştirilmez, değiştirilir", () => {
    const f = feature();
    const geometry = { kind: GEOMETRY_KIND.POINT, coord: [1, 2] } as const;
    expect(mergeFeaturePatch(f, { id: "f1", geometry }).geometry).toBe(geometry);
  });

  it("aynı değerleri tekrar gönderen patch → referanslar korunur, maske 0", () => {
    const f = feature();
    const next = mergeFeaturePatch(f, { id: "f1", style: { color: "red" }, meta: { fuel: 80 } });
    expect(next.style).toBe(f.style);
    expect(next.meta).toBe(f.meta);
    expect(diffFeature(f, next)).toBe(0);
  });

  it("değeri undefined olan anahtar alanı temizler", () => {
    const f = feature({ hidden: true });
    const next = mergeFeaturePatch(f, { id: "f1", hidden: undefined, style: undefined });
    expect(next.hidden).toBeUndefined();
    expect(next.style).toBeUndefined();
    expect(diffFeature(f, next)).toBe(FEATURE_CHANGE.HIDDEN | FEATURE_CHANGE.STYLE);
  });

  it("patch'te olmayan anahtarlara dokunulmaz", () => {
    const f = feature({ z: 4 });
    const next = mergeFeaturePatch(f, { id: "f1", hidden: true });
    expect(next.z).toBe(4);
    expect(next.style).toBe(f.style);
  });

  it("id değiştirilemez", () => {
    const f = feature();
    expect(mergeFeaturePatch(f, { id: "baska" }).id).toBe("f1");
  });
});

describe("mergeLayerPatch / mergeBasemapPatch", () => {
  it("katman: alan değişir, meta sığ birleştirilir", () => {
    const l = layer({ meta: { a: 1, b: 2 } });
    const next = mergeLayerPatch(l, { visible: false, meta: { b: 3 } });
    expect(next.visible).toBe(false);
    expect(next.meta).toEqual({ a: 1, b: 3 });
    expect(diffLayer(l, next)).toBe(LAYER_CHANGE.VISIBLE | LAYER_CHANGE.META);
  });

  it("altlık: source birleştirilmez, değiştirilir", () => {
    const b = basemap();
    const source = { type: BASEMAP_SOURCE.TILEJSON, url: "u" } as const;
    const next = mergeBasemapPatch(b, { source });
    expect(next.source).toBe(source);
    expect(next.source).not.toHaveProperty("urlTemplate");
  });
});

describe("shallowMerge", () => {
  it("düz nesne olmayanlarda patch aynen alınır", () => {
    expect(shallowMerge(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(shallowMerge({ a: 1 }, undefined)).toBeUndefined();
    expect(shallowMerge<unknown>([1, 2], [3])).toEqual([3]);
  });

  it("değişiklik yoksa prev referansı döner", () => {
    const prev: Record<string, number> = { a: 1, b: 2 };
    expect(shallowMerge(prev, { a: 1 })).toBe(prev);
  });

  it("yeni anahtar → yeni nesne", () => {
    const prev: Record<string, unknown> = { a: 1 };
    expect(shallowMerge(prev, { a: 1, c: 3 })).toEqual({ a: 1, c: 3 });
  });

  it("undefined değerli yeni anahtar da değişiklik sayılır", () => {
    const prev: Record<string, unknown> = { a: 1 };
    const next = shallowMerge(prev, { b: undefined });
    expect(next).not.toBe(prev);
    expect("b" in next).toBe(true);
  });
});
