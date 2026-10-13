import { describe, expect, it } from "vitest";
import { BASEMAP_SOURCE, type Basemap } from "../model/basemap";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND } from "../model/geometry";
import type { Layer } from "../model/layer";
import { deepEqual, stabilizeBasemap, stabilizeFeature, stabilizeLayer } from "./stabilize";

/** JSON'dan her mesajda yeniden üretilmiş gibi: içerik aynı, tüm iç nesneler yeni. */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const unit: Feature = {
  id: "u1",
  layerId: "birlikler",
  kind: "milsym",
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [32.85, 39.9] },
  style: { size: 24, halo: { color: "#fff", width: 2 } },
  props: { sidc: "10031000161211000000", modifiers: ["A", "B"] },
  meta: { yakit: 80 },
  rev: 1,
};

describe("deepEqual", () => {
  it.each<[string, unknown, unknown, boolean]>([
    ["ilkel", 1, 1, true],
    ["NaN", NaN, NaN, true],
    ["farklı ilkel", 1, 2, false],
    ["iç içe nesne", { a: { b: [1, 2] } }, { a: { b: [1, 2] } }, true],
    ["dizi uzunluğu", [1, 2], [1, 2, 3], false],
    ["anahtar sayısı", { a: 1 }, { a: 1, b: undefined }, false],
    ["dizi ↔ nesne", [1], { 0: 1 }, false],
    ["null ↔ nesne", null, {}, false],
    ["anahtar sırası önemsiz", { a: 1, b: 2 }, { b: 2, a: 1 }, true],
  ])("%s", (_name, a, b, expected) => {
    expect(deepEqual(a, b)).toBe(expected);
  });

  it("düz olmayan nesneler yalnız referansla eşit", () => {
    expect(deepEqual(new Date(0), new Date(0))).toBe(false);
    expect(deepEqual(new Float32Array([1]), new Float32Array([1]))).toBe(false);
  });
});

describe("stabilizeFeature", () => {
  it("tamamen aynı içerikli yeni nesne → prev'in kendisi döner", () => {
    expect(stabilizeFeature(unit, fresh(unit))).toBe(unit);
  });

  it("yalnız rev farklı → prev döner (rev store'da ayrı tutulur)", () => {
    expect(stabilizeFeature(unit, { ...fresh(unit), rev: 2 })).toBe(unit);
  });

  it("yalnız konum değişti → geometry yeni, diğer nesneler eski referans", () => {
    const next = fresh(unit);
    next.geometry = { kind: GEOMETRY_KIND.POINT, coord: [33, 40] };
    const result = stabilizeFeature(unit, next);
    expect(result.geometry).toBe(next.geometry);
    expect(result.style).toBe(unit.style);
    expect(result.props).toBe(unit.props);
    expect(result.meta).toBe(unit.meta);
  });

  it("iç içe alan değişti → o nesne yeni, diğerleri eski", () => {
    const next = fresh(unit);
    (next.style as { halo: { width: number } }).halo.width = 3;
    const result = stabilizeFeature(unit, next);
    expect(result.style).toBe(next.style);
    expect(result.geometry).toBe(unit.geometry);
  });

  it("ilkel alan değişti (hidden) → nesne alanları yine eski referans", () => {
    const result = stabilizeFeature(unit, { ...fresh(unit), hidden: true });
    expect(result).not.toBe(unit);
    expect(result.hidden).toBe(true);
    expect(result.props).toBe(unit.props);
  });

  it("korunacak alan yoksa next'in kendisi döner (gereksiz kopya yok)", () => {
    const next: Feature = {
      ...unit,
      geometry: { kind: GEOMETRY_KIND.POINT, coord: [1, 1] },
      style: { size: 1 },
      props: { sidc: "x" },
      meta: { yakit: 1 },
    };
    expect(stabilizeFeature(unit, next)).toBe(next);
  });
});

describe("stabilizeLayer / stabilizeBasemap", () => {
  it("katman: aynı içerikli meta eski referans", () => {
    const layer: Layer = { id: "l", name: "L", parentId: null, visible: true, opacity: 1, meta: { renk: "kırmızı" } };
    const result = stabilizeLayer(layer, { ...fresh(layer), visible: false });
    expect(result.meta).toBe(layer.meta);
    expect(result.visible).toBe(false);
  });

  it("altlık: aynı içerikli source eski referans (tile kaynağı baştan yüklenmesin)", () => {
    const basemap: Basemap = {
      id: "b",
      name: "B",
      source: { type: BASEMAP_SOURCE.WMS, url: "u", layers: "l", params: { TIME: "2026" } },
      visible: true,
      opacity: 1,
      order: 0,
    };
    const result = stabilizeBasemap(basemap, { ...fresh(basemap), opacity: 0.5 });
    expect(result.source).toBe(basemap.source);
  });
});
