import type { LngLat } from '@c2/map-core';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useMapContext } from '../context';

/** Kutunun hangi noktası koordinata (+ offset) gelir. */
export const OVERLAY_ALIGN = {
  /** Sol üst köşe (kutu noktanın sağ altında). */
  TOP_LEFT: 'top-left',
  /** Orta. */
  CENTER: 'center',
  /** Alt orta (kutu noktanın üstünde: kart / balon). */
  BOTTOM: 'bottom',
  /** Üst orta (kutu noktanın altında). */
  TOP: 'top',
} as const;
export type OverlayAlign = (typeof OVERLAY_ALIGN)[keyof typeof OVERLAY_ALIGN];

const ALIGN_SHIFT: Record<OverlayAlign, string> = {
  'top-left': '',
  center: ' translate(-50%, -50%)',
  bottom: ' translate(-50%, -100%)',
  top: ' translate(-50%, 0)',
};

export type MapOverlayProps = {
  /** Koordinat. `null`/`undefined` → hiçbir şey çizilmez. */
  anchor: LngLat | null | undefined;
  /** Hizalama (varsayılan `top-left`). */
  align?: OverlayAlign;
  /** Piksel kaydırma [x, y]. */
  offset?: readonly [number, number];
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

/**
 * Koordinata sabit React DOM (birlik kartı, açıklama balonu). Konum her karede `adapter.project`
 * ile DOM'a doğrudan yazılır (React render'ı yok): harita kayarken kart da kayar.
 *
 * Hizalama `align` ile yapılır, içeriğe CSS `transform` vererek DEĞİL: kaydırma kutunun kendisine
 * uygulanınca tıklanabilir alan görünen kartla aynı yerdedir. İçerik kaydırılırsa kutunun eski
 * yeri haritanın üstünde görünmez bir engel olarak kalır ve tıklamaları yutar.
 */
export function MapOverlay({ anchor, align = OVERLAY_ALIGN.TOP_LEFT, offset, className, style, children }: MapOverlayProps) {
  const { adapter, ready } = useMapContext('<MapOverlay>');
  const element = useRef<HTMLDivElement>(null);
  const target = useRef({ anchor, offset, align });
  useEffect(() => {
    target.current = { anchor, offset, align };
  });
  const visible = anchor != null;

  useEffect(() => {
    if (!ready || !visible) return;
    let frame = 0;
    let last = '';
    const tick = () => {
      const { anchor: coord, offset: shift, align: origin } = target.current;
      const point = coord ? adapter.project(coord) : null;
      const div = element.current;
      if (div) {
        const next = point
          ? `translate(${point.x + (shift?.[0] ?? 0)}px, ${point.y + (shift?.[1] ?? 0)}px)${ALIGN_SHIFT[origin]}`
          : '';
        if (next !== last) {
          last = next;
          div.style.transform = next;
          div.style.visibility = point ? 'visible' : 'hidden';
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [ready, visible, adapter]);

  if (!visible) return null;
  return (
    <div
      ref={element}
      className={className}
      // İlk konum hesaplanana kadar gizli (sol üstte bir kare görünmesin).
      style={{ position: 'absolute', left: 0, top: 0, visibility: 'hidden', ...style }}
    >
      {children}
    </div>
  );
}
