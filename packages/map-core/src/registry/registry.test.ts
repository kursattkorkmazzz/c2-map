import { describe, expect, it, vi } from "vitest";
import { BASEMAP_SOURCE, type Basemap } from "../model/basemap";
import type { Feature } from "../model/feature";
import { GEOMETRY_KIND, type Geometry } from "../model/geometry";
import { BasemapProviderRegistry } from "./basemap-provider-registry";
import { geometryBounds } from "./bounds";
import { FeatureKindRegistry } from "./feature-kind-registry";
import { Registry } from "./registry";
import { SymbologyRegistry, type SymbologyProvider } from "./symbology-registry";

const feature = (kind: string, over: Partial<Feature> = {}): Feature => ({
  id: "f",
  layerId: "l",
  kind,
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [10, 20] },
  ...over,
});

describe("Registry (ortak)", () => {
  it("kayıt, okuma, aynı anahtar ikinci kez → hata, replace ile değiştirme", () => {
    const r = new Registry<{ id: string; v: number }>("öğe", (x) => x.id);
    r.register({ id: "a", v: 1 });
    expect(r.get("a")?.v).toBe(1);
    expect(() => r.register({ id: "a", v: 2 })).toThrow(/zaten kayıtlı/);
    r.register({ id: "a", v: 3 }, { replace: true });
    expect(r.get("a")?.v).toBe(3);
    expect(r.keys()).toEqual(["a"]);
  });

  it("geri alma yalnız hâlâ aynı nesne kayıtlıysa siler", () => {
    const r = new Registry<{ id: string }>("öğe", (x) => x.id);
    const first = { id: "a" };
    const undoFirst = r.register(first);
    const second = { id: "a" };
    r.register(second, { replace: true });
    undoFirst(); // artık `second` kayıtlı, silinmemeli
    expect(r.get("a")).toBe(second);
  });
});

describe("FeatureKindRegistry", () => {
  it("validate: tanımın doğrulayıcısı; tanım yoksa geçerli", () => {
    const kinds = new FeatureKindRegistry();
    kinds.register({
      kind: "milsym",
      validate: (f) => (typeof (f.props as { code?: string } | undefined)?.code === "string" ? null : "SIDC yok"),
    });
    expect(kinds.validate(feature("milsym"))).toBe("SIDC yok");
    expect(kinds.validate(feature("milsym", { props: { code: "100310" } }))).toBeNull();
    expect(kinds.validate(feature("bilinmeyen"))).toBeNull();
  });

  it("withDefaults: varsayılanlar sığ birleşir, unsurun değeri baskın; varsayılan yoksa aynı referans", () => {
    const kinds = new FeatureKindRegistry();
    kinds.register({ kind: "vector", defaultStyle: { stroke: "#000", width: 2 } });
    const f = feature("vector", { style: { stroke: "#f00" } });
    expect(kinds.withDefaults(f).style).toEqual({ stroke: "#f00", width: 2 });

    const plain = feature("marker");
    expect(kinds.withDefaults(plain)).toBe(plain);
  });

  it("bounds: tanımın bounds'u, yoksa geometriden", () => {
    const kinds = new FeatureKindRegistry();
    kinds.register({ kind: "ozel", bounds: () => ({ min: [0, 0], max: [1, 1] }) });
    expect(kinds.bounds(feature("ozel"))).toEqual({ min: [0, 0], max: [1, 1] });
    expect(kinds.bounds(feature("marker"))).toEqual({ min: [10, 20], max: [10, 20] });
  });

  it("resolveFor: desteklenene kadar fallback zinciri; ulaşılamazsa null", () => {
    const kinds = new FeatureKindRegistry();
    kinds.register({ kind: "model3d", fallback: (f) => ({ ...f, kind: "milsym" }) });
    kinds.register({ kind: "milsym", fallback: (f) => ({ ...f, kind: "marker" }) });

    const only2d = (k: string) => k === "marker";
    expect(kinds.resolveFor(feature("model3d"), only2d)?.kind).toBe("marker");
    expect(kinds.resolveFor(feature("milsym"), (k) => k === "milsym")?.kind).toBe("milsym");
    expect(kinds.resolveFor(feature("bilinmeyen"), only2d)).toBeNull();
  });

  it("resolveFor: zaten destekleniyorsa aynı referans; döngülü fallback sonsuza gitmez", () => {
    const kinds = new FeatureKindRegistry();
    kinds.register({ kind: "a", fallback: (f) => ({ ...f, kind: "b" }) });
    kinds.register({ kind: "b", fallback: (f) => ({ ...f, kind: "a" }) });
    const f = feature("a");
    expect(kinds.resolveFor(f, () => true)).toBe(f);
    expect(kinds.resolveFor(f, () => false)).toBeNull();
  });
});

describe("geometryBounds", () => {
  it.each<[string, Geometry, [number, number, number, number]]>([
    ["line", { kind: GEOMETRY_KIND.LINE, coords: [[0, 0], [2, -1], [1, 3]] }, [0, -1, 2, 3]],
    ["polygon", { kind: GEOMETRY_KIND.POLYGON, rings: [[[0, 0], [4, 0], [4, 4], [0, 0]]] }, [0, 0, 4, 4]],
    ["multi-polygon", {
      kind: GEOMETRY_KIND.MULTI_POLYGON,
      polygons: [[[[0, 0], [1, 1], [0, 1]]], [[[5, 5], [6, 6], [5, 6]]]],
    }, [0, 0, 6, 6]],
    ["rectangle", { kind: GEOMETRY_KIND.RECTANGLE, min: [1, 2], max: [3, 4] }, [1, 2, 3, 4]],
  ])("%s", (_name, geometry, [minLon, minLat, maxLon, maxLat]) => {
    expect(geometryBounds(geometry)).toEqual({ min: [minLon, minLat], max: [maxLon, maxLat] });
  });

  it("circle: yarıçap metreden yaklaşık derece kutusu", () => {
    const b = geometryBounds({ kind: GEOMETRY_KIND.CIRCLE, center: [0, 0], radiusM: 111_320 })!;
    expect(b.min[1]).toBeCloseTo(-1, 5);
    expect(b.max[0]).toBeCloseTo(1, 5);
  });

  it("boş geometri → null", () => {
    expect(geometryBounds({ kind: GEOMETRY_KIND.LINE, coords: [] })).toBeNull();
  });
});

describe("BasemapProviderRegistry", () => {
  const custom = (over: Partial<Basemap> = {}): Basemap => ({
    id: "b",
    name: "b",
    source: { type: "custom:firma-a", config: { katman: "uydu" } },
    visible: true,
    opacity: 1,
    order: 0,
    ...over,
  });

  it("custom kaynak sağlayıcının resolve'u ile standart tipe çevrilir (tip adından sağlayıcı)", () => {
    const providers = new BasemapProviderRegistry();
    providers.register({
      id: "firma-a",
      resolve: () => ({ type: BASEMAP_SOURCE.XYZ, urlTemplate: "https://firma-a/{z}/{x}/{y}" }),
    });
    expect(providers.resolveSource(custom())).toEqual({
      type: BASEMAP_SOURCE.XYZ,
      urlTemplate: "https://firma-a/{z}/{x}/{y}",
    });
  });

  it("altlığın provider alanı tip adından önceliklidir", () => {
    const providers = new BasemapProviderRegistry();
    providers.register({ id: "firma-a", resolve: () => ({ type: BASEMAP_SOURCE.TILEJSON, url: "a" }) });
    providers.register({ id: "kurum", resolve: () => ({ type: BASEMAP_SOURCE.TILEJSON, url: "kurum" }) });
    expect(providers.resolveSource(custom({ provider: "kurum" }))).toEqual({ type: BASEMAP_SOURCE.TILEJSON, url: "kurum" });
  });

  it("standart kaynak aynen döner; çözülemeyen custom → null", () => {
    const providers = new BasemapProviderRegistry();
    const xyz = custom({ source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: "u" } });
    expect(providers.resolveSource(xyz)).toBe(xyz.source);
    expect(providers.resolveSource(custom())).toBeNull();
  });

  it("transformRequest: sağlayıcı varsa onun dönüşümü, yoksa URL aynen", () => {
    const providers = new BasemapProviderRegistry();
    const transform = vi.fn((url: string) => ({ url: `${url}?imza=1`, headers: { Authorization: "Bearer x" } }));
    providers.register({ id: "firma-a", transformRequest: transform });
    expect(providers.transformRequest(custom({ provider: "firma-a" }), "https://t/1")).toEqual({
      url: "https://t/1?imza=1",
      headers: { Authorization: "Bearer x" },
    });
    expect(providers.transformRequest(custom(), "https://t/1")).toEqual({ url: "https://t/1" });
  });
});

describe("SymbologyRegistry", () => {
  it("standart adıyla kayıt ve okuma", () => {
    const symbology = new SymbologyRegistry();
    const app6: SymbologyProvider = {
      id: "app6d",
      validate: (code) => code.length === 20,
      cacheKey: (code, _mods, size) => `app6d:${code}:${size}`,
      render: () => {
        throw new Error("testte çizim yok");
      },
    };
    symbology.register(app6);
    expect(symbology.get("app6d")).toBe(app6);
    expect(symbology.standards()).toEqual(["app6d"]);
    expect(symbology.get("app6d")?.cacheKey("10031000161211000000", {}, 24)).toBe("app6d:10031000161211000000:24");
  });
});
