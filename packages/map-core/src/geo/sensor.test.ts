import { describe, expect, it } from "vitest";
import type { LngLat } from "../model/geometry";
import { bearing, distance } from "./geodesic";
import { sensorFootprint } from "./sensor";

const P: LngLat = [32.85, 39.9];
const H = 3000;

describe("sensör izi", () => {
  it("tam aşağı, 90° görüş: merkez altta, köşeler h·√2 uzakta (kare)", () => {
    const f = sensorFootprint(P, H, 0, { panDeg: 0, tiltDeg: 90, hfovDeg: 90, vfovDeg: 90 });
    expect(distance(f.center, P)).toBeLessThan(0.01);
    for (const c of f.corners) expect(distance(P, c)).toBeCloseTo(H * Math.SQRT2, 0);
    expect(f.apex).toEqual([P[0], P[1], H]);
    expect(f.clipped).toBe(false);
  });

  it("45° eğim: merkez bakış yönünde h kadar ileride; burun yönü + pan", () => {
    const north = sensorFootprint(P, H, 0, { panDeg: 0, tiltDeg: 45, hfovDeg: 10, vfovDeg: 10 });
    expect(distance(P, north.center)).toBeCloseTo(H, 0);
    expect(bearing(P, north.center)).toBeCloseTo(0, 3);

    const east = sensorFootprint(P, H, 90, { panDeg: 0, tiltDeg: 45, hfovDeg: 10, vfovDeg: 10 });
    expect(bearing(P, east.center)).toBeCloseTo(90, 3);
    const relative = sensorFootprint(P, H, 90, { panDeg: -90, tiltDeg: 45, hfovDeg: 10, vfovDeg: 10 });
    expect(relative.azimuthDeg).toBe(0);
    expect(bearing(P, relative.center)).toBeCloseTo(0, 3);
  });

  it("yamuk: uzak kenar yakın kenardan geniş; sol / sağ doğru tarafta", () => {
    const f = sensorFootprint(P, H, 0, { panDeg: 0, tiltDeg: 40, hfovDeg: 30, vfovDeg: 20 });
    const [farLeft, farRight, nearRight, nearLeft] = f.corners;
    expect(distance(farLeft, farRight)).toBeGreaterThan(distance(nearLeft, nearRight));
    expect(farLeft[0]).toBeLessThan(farRight[0]); // kuzeye bakarken sol = batı
    expect(distance(P, farLeft)).toBeGreaterThan(distance(P, nearLeft));
  });

  it("ufka bakış: menzilde kesilir, clipped", () => {
    const f = sensorFootprint(P, H, 0, { panDeg: 0, tiltDeg: 5, hfovDeg: 20, vfovDeg: 20, maxRangeM: 10_000 });
    expect(f.clipped).toBe(true);
    for (const c of f.corners) expect(distance(P, c)).toBeLessThanOrEqual(10_000.01);
  });
});
