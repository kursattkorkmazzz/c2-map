import { describe, expect, it } from "vitest";
import {
  BASEMAP_CHANGE,
  BASEMAP_CHANGE_ALL,
  FEATURE_CHANGE,
  FEATURE_CHANGE_ALL,
  FEATURE_CHANGE_VISUAL,
  LAYER_CHANGE,
  LAYER_CHANGE_ALL,
} from "./change";

describe.each([
  ["FEATURE_CHANGE", FEATURE_CHANGE, FEATURE_CHANGE_ALL],
  ["LAYER_CHANGE", LAYER_CHANGE, LAYER_CHANGE_ALL],
  ["BASEMAP_CHANGE", BASEMAP_CHANGE, BASEMAP_CHANGE_ALL],
] as const)("%s", (_name, bits, all) => {
  const values = Object.values(bits);

  it("her değer tek bir bit (2'nin kuvveti)", () => {
    for (const v of values) {
      expect(v > 0 && (v & (v - 1)) === 0).toBe(true);
    }
  });

  it("bitler çakışmıyor", () => {
    expect(new Set(values).size).toBe(values.length);
  });

  it("ALL tüm bitleri içeriyor, fazlasını değil", () => {
    expect(all).toBe(values.reduce((acc, v) => acc | v, 0));
  });
});

describe("FEATURE_CHANGE_VISUAL", () => {
  it("META hariç tüm bitler", () => {
    expect(FEATURE_CHANGE_VISUAL & FEATURE_CHANGE.META).toBe(0);
    expect(FEATURE_CHANGE_VISUAL | FEATURE_CHANGE.META).toBe(FEATURE_CHANGE_ALL);
  });
});
