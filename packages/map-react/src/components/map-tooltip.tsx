import { MAP_EVENT, type MapStore } from '@c2/map-core';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useMapContext } from '../context';
import { useHovered } from '../hooks/store-hooks';

export type MapTooltipProps = {
  /** Üzerine gelinen unsurun içeriği. `null` → o unsur için tooltip yok. */
  children: (featureId: string) => ReactNode;
  /** Yalnız bu katmanın alt ağacındaki unsurlar için. */
  layerId?: string;
  /** İmlece göre piksel kaydırma [x, y]. Varsayılan [14, 14]. */
  offset?: readonly [number, number];
  className?: string;
  style?: CSSProperties;
};

/**
 * Fare altındaki unsurun tooltip'i (store'daki hover; `<Map defaultInteractions>` açık olmalı).
 * React yalnız hover edilen unsur değişince render olur; imleci takip DOM'a doğrudan yazılır.
 */
export function MapTooltip({ children, layerId, offset = DEFAULT_OFFSET, className, style }: MapTooltipProps) {
  const { router, store } = useMapContext('<MapTooltip>');
  const hovered = useHovered();
  const element = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const shift = useRef(offset);
  useEffect(() => {
    shift.current = offset;
  });

  // İmleç konumu her zaman izlenir: tooltip açıldığı anda doğru yerde belirsin.
  useEffect(() => {
    const place = () => {
      const div = element.current;
      const p = pointer.current;
      if (!div || !p) return;
      div.style.transform = `translate(${p.x + shift.current[0]}px, ${p.y + shift.current[1]}px)`;
      div.style.visibility = 'visible';
    };
    place();
    return router.on(MAP_EVENT.POINTER_MOVE, (e) => {
      if (!e.screen) return;
      pointer.current = e.screen;
      place();
    });
  });

  if (hovered === null || (layerId !== undefined && !isInLayer(store, hovered, layerId))) return null;
  const content = children(hovered);
  if (content == null) return null;
  return (
    <div
      ref={element}
      className={className}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', visibility: 'hidden', ...style }}
    >
      {content}
    </div>
  );
}

const DEFAULT_OFFSET = [14, 14] as const;

/** Unsur `layerId` katmanında veya onun altındaki bir katmanda mı? */
export function isInLayer(store: MapStore, featureId: string, layerId: string): boolean {
  let current = store.getFeature(featureId)?.layerId ?? null;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    if (current === layerId) return true;
    seen.add(current);
    current = store.getLayer(current)?.parentId ?? null;
  }
  return false;
}
