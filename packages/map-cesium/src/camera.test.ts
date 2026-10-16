import { describe, expect, it } from 'vitest';
import { fromCesiumPitch, fromHeading, metersPerPixel, rangeToZoom, toCesiumPitch, toHeading, zoomToRange } from './camera';

const FOVY = (50 * Math.PI) / 180;

describe('kamera dönüşümü', () => {
  it('metre/piksel MapLibre ile aynı (512 px karo)', () => {
    // Ekvatorda zoom 0: 40 075 016 m / 512 px
    expect(metersPerPixel(0, 0)).toBeCloseTo(78271.5, 0);
    // Her zoom yarıya böler, enlemde cos(lat) ile küçülür
    expect(metersPerPixel(10, 0)).toBeCloseTo(metersPerPixel(0, 0) / 1024, 3);
    expect(metersPerPixel(5, 60)).toBeCloseTo(metersPerPixel(5, 0) / 2, 3);
  });

  it('zoom → mesafe → zoom gidiş-dönüş', () => {
    for (const zoom of [3, 7.2, 12.5, 18]) {
      const range = zoomToRange(zoom, 39.9, 900, FOVY);
      expect(rangeToZoom(range, 39.9, 900, FOVY)).toBeCloseTo(zoom, 6);
    }
    // Bir zoom yakın = yarı mesafe
    expect(zoomToRange(9, 40, 900, FOVY) / zoomToRange(10, 40, 900, FOVY)).toBeCloseTo(2, 6);
  });

  it('pitch: 0 tepeden ↔ Cesium −90°; aralık dışı sınırlanır', () => {
    expect(toCesiumPitch(0)).toBeCloseTo((-89.9 * Math.PI) / 180, 6); // tam −90 değil (heading korunur)
    expect(toCesiumPitch(60)).toBeCloseTo((-30 * Math.PI) / 180, 6);
    expect(toCesiumPitch(120)).toBeCloseTo((-1 * Math.PI) / 180, 6); // en çok 89°
    expect(fromCesiumPitch((-30 * Math.PI) / 180)).toBeCloseTo(60, 6);
    expect(fromCesiumPitch(toCesiumPitch(45))).toBeCloseTo(45, 6);
  });

  it('bearing ↔ heading (−180..180)', () => {
    expect(fromHeading(toHeading(90))).toBeCloseTo(90, 6);
    expect(fromHeading(toHeading(270))).toBeCloseTo(-90, 6);
    expect(fromHeading(toHeading(-20))).toBeCloseTo(-20, 6);
  });
});
