// ── <DrawToolbar> ────────────────────────────────────────────────
// Kütüphanenin çizim araç çubuğu (karar: araç çubuğu kütüphanede). Araç düğmeleri + çizim
// sürerken ipucu, canlı ölçüm ve Bitir / Geri al / İptal. Görünüm `className` / `style` ve
// `data-*` öznitelikleriyle özelleştirilir; varsayılan koyu tema.
//
// Askeri semboller gibi backend'den gelen kind'ler burada yoktur: araç çubuğu yalnız geometri çizer.

import {
  DRAW_TOOL,
  formatArea,
  formatDistance,
  type DrawMeasurement,
  type DrawToolKind,
  type ActionResult,
  type DrawToolOptions,
  type Feature,
  type Geometry,
} from '@c2/map-core';
import type { CSSProperties, ReactNode } from 'react';
import { useFeatureActions } from '../hooks/use-feature-actions';
import { useMapDraw } from '../hooks/use-map-draw';

const defaultId = () =>
  `draw-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export const DRAW_TOOL_LABELS: Record<DrawToolKind, string> = {
  point: 'Nokta',
  line: 'Çizgi',
  polygon: 'Poligon',
  circle: 'Daire',
  rectangle: 'Dikdörtgen',
  corridor: 'Koridor',
  ellipse: 'Elips',
};

const ALL_TOOLS = Object.values(DRAW_TOOL);

export type DrawToolbarProps = {
  /** Gösterilecek araçlar ve sırası (varsayılan: hepsi). */
  tools?: readonly DrawToolKind[];
  /** Çizim bitince (iptalde çağrılmaz). `layerId` verildiyse ekleme sonucu da gelir. */
  onComplete?: (geometry: Geometry, tool: DrawToolKind, created?: { feature: Feature; result: ActionResult }) => void;
  /**
   * Verilirse çizim bu katmana unsur olarak EKLENİR — `<Map lifecycle.beforeCreate>`'ten geçerek
   * (ör. önce backend'e kaydet). Verilmezse yalnız `onComplete` çağrılır, ne yapılacağı uygulamanın.
   */
  layerId?: string;
  /** Eklenen unsurun kind'ı (varsayılan `vector`). */
  featureKind?: string;
  /** Eklenen unsurun stili (motora özel; MapLibre `vector` için `VectorStyle`). */
  featureStyle?: unknown;
  /** Yeni unsur id'si (varsayılan `draw-<uuid>`; backend kendi id'sini `beforeCreate` dönüşünde verebilir). */
  createId?: (tool: DrawToolKind) => string;
  /** Araç başına seçenek (ör. `{ corridor: { corridorWidthM: 500 } }`). */
  toolOptions?: Partial<Record<DrawToolKind, DrawToolOptions>>;
  /** Düğme etiketleri (varsayılan Türkçe). */
  labels?: Partial<Record<DrawToolKind, string>>;
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  className?: string;
  style?: CSSProperties;
};

export function DrawToolbar({
  tools = ALL_TOOLS,
  onComplete,
  layerId,
  featureKind = 'vector',
  featureStyle,
  createId = defaultId,
  toolOptions,
  labels,
  position = 'top-right',
  className,
  style,
}: DrawToolbarProps) {
  const draw = useMapDraw();
  const actions = useFeatureActions();
  const activeTool = draw.state?.tool ?? null;
  const right = position.endsWith('right');
  const top = position.startsWith('top');

  const pick = (tool: DrawToolKind) => {
    if (activeTool === tool) return draw.cancel();
    draw.start(tool, toolOptions?.[tool]).then(
      async (geometry) => {
        if (!geometry) return;
        if (layerId === undefined) return onComplete?.(geometry, tool);
        const feature: Feature = {
          id: createId(tool),
          layerId,
          kind: featureKind,
          geometry,
          ...(featureStyle !== undefined ? { style: featureStyle } : {}),
          meta: { tool },
        };
        const result = await actions.create(feature);
        onComplete?.(geometry, tool, { feature, result });
      },
      () => {}, // harita hazır değil: düğme etkisiz
    );
  };

  return (
    <div
      className={className}
      data-c2-draw-toolbar=""
      style={{
        position: 'absolute',
        [right ? 'right' : 'left']: 10,
        [top ? 'top' : 'bottom']: 10,
        display: 'flex',
        flexDirection: right ? 'row-reverse' : 'row',
        alignItems: top ? 'flex-start' : 'flex-end',
        gap: 8,
        zIndex: 5,
        font: '12px system-ui, sans-serif',
        // Dış kutu araç sütunu + panel kadar yer kaplar; boş kısmı haritaya giden tıklamayı
        // yutmasın diye saydam. Yalnız sütun ve panel tıklama alır.
        pointerEvents: 'none',
        ...style,
      }}
    >
      <div role="toolbar" aria-label="Çizim araçları" style={styles.bar}>
        {tools.map((tool) => {
          const label = labels?.[tool] ?? DRAW_TOOL_LABELS[tool];
          const active = activeTool === tool;
          return (
            <button
              key={tool}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={active}
              data-tool={tool}
              data-active={active || undefined}
              onClick={() => pick(tool)}
              style={{ ...styles.button, ...(active ? styles.active : null) }}
            >
              {ICONS[tool]}
            </button>
          );
        })}
      </div>

      {draw.state && (
        <div role="status" data-c2-draw-panel="" style={styles.panel}>
          <div style={styles.title}>{labels?.[draw.state.tool] ?? DRAW_TOOL_LABELS[draw.state.tool]}</div>
          <div>{draw.state.hint}</div>
          <Measurement value={draw.state.measurement} />
          <div style={styles.actions}>
            {draw.state.canFinish && (
              <button type="button" onClick={draw.finish} style={styles.action}>
                Bitir
              </button>
            )}
            <button type="button" onClick={draw.undo} disabled={!draw.state.canUndo} style={styles.action}>
              Geri al
            </button>
            <button type="button" onClick={draw.cancel} style={styles.action}>
              İptal
            </button>
          </div>
          <div style={styles.keys}>Enter bitir · Backspace geri al · Esc iptal</div>
        </div>
      )}
    </div>
  );
}

function Measurement({ value }: { value: DrawMeasurement }) {
  const rows: [string, string][] = [];
  if (value.lengthM !== undefined) rows.push(['Uzunluk', formatDistance(value.lengthM)]);
  if (value.radiusM !== undefined) rows.push(['Yarıçap', formatDistance(value.radiusM)]);
  if (value.semiMajorM !== undefined) rows.push(['Büyük yarı eksen', formatDistance(value.semiMajorM)]);
  if (value.semiMinorM !== undefined) rows.push(['Küçük yarı eksen', formatDistance(value.semiMinorM)]);
  if (value.widthM !== undefined) rows.push(['Genişlik', formatDistance(value.widthM)]);
  if (value.bearingDeg !== undefined) rows.push(['Yön', `${value.bearingDeg.toFixed(1)}°`]);
  if (value.perimeterM !== undefined) rows.push(['Çevre', formatDistance(value.perimeterM)]);
  if (value.areaM2 !== undefined) rows.push(['Alan', formatArea(value.areaM2)]);
  if (rows.length === 0) return null;
  return (
    <table style={styles.table}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td style={{ opacity: 0.7, paddingRight: 8 }}>{k}</td>
            <td style={{ textAlign: 'right' }}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Görünüm ──────────────────────────────────────────────────────

const styles = {
  bar: {
    pointerEvents: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: 4,
    background: 'rgba(20, 24, 30, 0.9)',
    borderRadius: 6,
    boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
  },
  button: {
    width: 32,
    height: 32,
    display: 'grid',
    placeItems: 'center',
    padding: 0,
    border: 0,
    borderRadius: 4,
    background: 'transparent',
    color: '#e6e6e6',
    cursor: 'pointer',
  },
  active: { background: '#ffcc00', color: '#14181e' },
  panel: {
    pointerEvents: 'auto',
    width: 220,
    padding: '8px 10px',
    background: 'rgba(20, 24, 30, 0.92)',
    color: '#e6e6e6',
    borderRadius: 6,
    boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
    lineHeight: 1.4,
  },
  title: { fontWeight: 600, color: '#ffcc00', marginBottom: 2 },
  table: { width: '100%', marginTop: 6, borderCollapse: 'collapse' },
  actions: { display: 'flex', gap: 6, marginTop: 8 },
  action: {
    flex: 1,
    padding: '4px 0',
    border: '1px solid #3a4452',
    borderRadius: 4,
    background: '#20262e',
    color: '#e6e6e6',
    cursor: 'pointer',
  },
  keys: { marginTop: 6, fontSize: 10, opacity: 0.6 },
} satisfies Record<string, CSSProperties>;

const svg = (children: ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    {children}
  </svg>
);

const ICONS: Record<DrawToolKind, ReactNode> = {
  point: svg(<circle cx="12" cy="12" r="4" fill="currentColor" />),
  line: svg(<polyline points="3,18 9,8 15,14 21,5" />),
  polygon: svg(<polygon points="12,3 21,10 17,20 7,20 3,10" />),
  circle: svg(<circle cx="12" cy="12" r="8" />),
  rectangle: svg(<rect x="4" y="6" width="16" height="12" />),
  corridor: svg(
    <>
      <polyline points="3,15 10,8 21,8" />
      <polyline points="3,21 12,13 21,13" />
      <polyline points="3,18 11,10.5 21,10.5" strokeDasharray="2 2" strokeWidth="1" />
    </>,
  ),
  ellipse: svg(<ellipse cx="12" cy="12" rx="9" ry="5" transform="rotate(-25 12 12)" />),
};
