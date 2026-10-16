// ── Kamera: CameraView (zoom / bearing / pitch) ↔ Cesium kamera ──
// Tasarım: plan/design/05-adapter-and-events.md, Faz 5 "2D ↔ 3D geçiş"
//
// Çekirdeğin kamera modeli MapLibre'ninkidir: merkez + zoom + bearing (kuzeyden saat yönü) +
// pitch (0 = tepeden). Cesium'da kamera bir noktaya MESAFE ve açılarla bakar:
//
//   zoom   → mesafe : zoom'daki metre/piksel × ekran yüksekliği, dikey görüş açısına sığdırılır
//   bearing → heading (aynı: kuzeyden saat yönü)
//   pitch  → Cesium pitch = pitch − 90° (Cesium'da −90° tam aşağı, 0 ufuk)
//
// Böylece aynı `initialView` / `flyTo` iki motorda da yaklaşık aynı alanı gösterir.

/** WGS84 ekvator çevresi (m). */
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** MapLibre'nin karo boyu: zoom z'de dünya 512·2^z piksel. */
const TILE_SIZE = 512;
const RAD = Math.PI / 180;

/** Tam tepeden bakışta Cesium'un heading'i belirsizleşir; biraz eğik tutulur. */
export const MIN_PITCH_DEG = 0;
export const MAX_PITCH_DEG = 89;

/** Enlemde zoom → metre/CSS piksel (MapLibre ile aynı). */
export function metersPerPixel(zoom: number, latDeg: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos(latDeg * RAD)) / (TILE_SIZE * 2 ** zoom);
}

/**
 * Zoom → kameranın merkeze uzaklığı (m). Ekranın dikey yüksekliği (`viewportHeightPx`) dikey görüş
 * açısına (`fovyRad`) sığacak kadar uzak.
 */
export function zoomToRange(zoom: number, latDeg: number, viewportHeightPx: number, fovyRad: number): number {
  const visibleM = metersPerPixel(zoom, latDeg) * Math.max(viewportHeightPx, 1);
  return visibleM / 2 / Math.tan(fovyRad / 2);
}

/** `zoomToRange`'in tersi. */
export function rangeToZoom(rangeM: number, latDeg: number, viewportHeightPx: number, fovyRad: number): number {
  const visibleM = Math.max(rangeM, 1) * 2 * Math.tan(fovyRad / 2);
  const mpp = visibleM / Math.max(viewportHeightPx, 1);
  return Math.log2((EARTH_CIRCUMFERENCE_M * Math.cos(latDeg * RAD)) / (TILE_SIZE * mpp));
}

/** CameraView pitch (0 = tepeden) → Cesium pitch (radyan, −π/2 = tepeden). */
export function toCesiumPitch(pitchDeg: number): number {
  const clamped = Math.min(Math.max(pitchDeg, MIN_PITCH_DEG), MAX_PITCH_DEG);
  // Tam −90°'de heading yön bilgisini kaybeder; −89,9° pratikte aynı görüntü.
  return (Math.max(clamped, 0.1) - 90) * RAD;
}

/** Cesium pitch (radyan) → CameraView pitch (derece). */
export function fromCesiumPitch(pitchRad: number): number {
  return Math.min(Math.max(pitchRad / RAD + 90, 0), 90);
}

/** Bearing (derece) ↔ heading (radyan): ikisi de kuzeyden saat yönü. */
export const toHeading = (bearingDeg: number): number => bearingDeg * RAD;
export function fromHeading(headingRad: number): number {
  const deg = headingRad / RAD;
  // MapLibre bearing'i −180..180 arası verir
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}
