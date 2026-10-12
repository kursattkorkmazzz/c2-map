import type { LngLat } from "./geometry";

export type CameraView = {
  center: LngLat;
  zoom?: number;
  bearingDeg?: number;
  pitchDeg?: number;
};
export type Bounds = { min: LngLat; max: LngLat };
