import type { LngLat } from '@c2/map-core';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useMapContext } from '../context';

export type MapOverlayProps = {
  /** Koordinat. `null`/`undefined` → hiçbir şey çizilmez. */
  anchor: LngLat | null | undefined;
  /** Piksel kaydırma [x, y]. Kutunun SOL ÜST köşesi `anchor + offset`'e gelir. */
  offset?: readonly [number, number];
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

/**
 * Koordinata sabit React DOM (birlik kartı, açıklama balonu). Konum her karede `adapter.project`
 * ile DOM'a doğrudan yazılır (React render'ı yok): harita kayarken kart da kayar.
 * Ortalamak için içeriğe `transform: translate(-50%, -100%)` verin.
 */
export function MapOverlay({ anchor, offset, className, style, children }: MapOverlayProps) {
  const { adapter, ready } = useMapContext('<MapOverlay>');
  const element = useRef<HTMLDivElement>(null);
  const target = useRef({ anchor, offset });
  useEffect(() => {
    target.current = { anchor, offset };
  });
  const visible = anchor != null;

  useEffect(() => {
    if (!ready || !visible) return;
    let frame = 0;
    let last = '';
    const tick = () => {
      const { anchor: coord, offset: shift } = target.current;
      const point = coord ? adapter.project(coord) : null;
      const div = element.current;
      if (div) {
        const next = point ? `translate(${point.x + (shift?.[0] ?? 0)}px, ${point.y + (shift?.[1] ?? 0)}px)` : '';
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
