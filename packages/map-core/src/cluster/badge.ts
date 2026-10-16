// ── Küme rozeti (görüntü) ────────────────────────────────────────
// Motorların ortak görünümü: renkli daire + sayı. Canvas ile çizilir → TARAYICI gerektirir (yalnız
// çağrılınca; çekirdeğin geri kalanı Node / Worker'da da çalışır). Adapter'lar bunu kendi ikon /
// billboard yoluna verir (MapLibre + deck.gl: data URL, Cesium: canvas).
//
// Etiket sınırlı bir küme: 1–99 tam, sonra iki anlamlı basamak (140, 1,2b, 15b). Böylece sayı her
// değiştiğinde yeni görüntü üretilmez; dokular (ikon atlası) şişmez.

export type ClusterBadgeOptions = {
  /** Anahtar → dolgu rengi (CSS). Varsayılan: mavi. */
  color?: (key: string) => string;
  /** Kenar rengi. Varsayılan beyaz. */
  stroke?: string;
  /** Çizim yoğunluğu (keskinlik). Varsayılan 2. */
  pixelRatio?: number;
};

export type ClusterBadge = {
  /** Görüntü anahtarı (etiket + renk + boy): aynı anahtar = aynı görüntü. */
  id: string;
  canvas: HTMLCanvasElement;
  /** Ekrandaki boy (CSS px, kare). */
  size: number;
};

/** Sayının kısa etiketi: 1–99 tam; sonra iki anlamlı basamak, binler "b". */
export function clusterLabel(count: number): string {
  if (count < 100) return String(count);
  if (count < 1000) return String(Math.round(count / 10) * 10);
  const k = count / 1000;
  return k < 10 ? `${(Math.round(k * 10) / 10).toLocaleString("tr-TR")}b` : `${Math.round(k)}b`;
}

/** Sayıya göre rozet boyu (CSS px). */
export function clusterBadgeSize(count: number): number {
  return count < 10 ? 28 : count < 100 ? 34 : count < 1000 ? 40 : 48;
}

const cache = new Map<string, ClusterBadge>();

/** Kümenin rozeti (önbellekli). */
export function clusterBadge(count: number, key: string, options: ClusterBadgeOptions = {}): ClusterBadge {
  const label = clusterLabel(count);
  const size = clusterBadgeSize(count);
  const fill = options.color?.(key) ?? "#3d8bfd";
  const stroke = options.stroke ?? "#ffffff";
  const ratio = options.pixelRatio ?? 2;
  const id = `c2-cluster|${label}|${fill}|${stroke}|${size}|${ratio}`;
  let badge = cache.get(id);
  if (badge) return badge;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.ceil(size * ratio);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(ratio, ratio);
  const r = size / 2;
  // Dış hale: kalabalık hissi + açık / koyu altlıkta okunurluk
  ctx.beginPath();
  ctx.arc(r, r, r - 1, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(fill, 0.35);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(r, r, r - 6, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${label.length > 3 ? 11 : 13}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, r, r + 0.5);

  badge = { id, canvas, size };
  cache.set(id, badge);
  return badge;
}

/** `#rrggbb` → `rgba(…, a)`; başka biçimler olduğu gibi. */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  return m ? `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${alpha})` : color;
}
