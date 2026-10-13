// ── Olay hook'ları ───────────────────────────────────────────────
// Tasarım: plan/design/07-react-api.md#hooklar
//
// latest-ref deseni: her render'da yeni callback verilse bile router'a yeniden abone olunmaz;
// abonelik yalnız olay türü veya hedef değişince yenilenir. Kabarma: unsur → katmanları → global
// (`event.stopPropagation()` zinciri keser).

import type { MapEventListener, MapEventTarget, MapEventType } from '@c2/map-core';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useMapContext } from '../context';

function useRouterListener(
  hook: string,
  type: MapEventType,
  target: MapEventTarget,
  targetKey: string,
  handler: MapEventListener,
): void {
  const { router } = useMapContext(hook);
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(
    () => router.on(type, (event) => latest.current(event), target),
    // `target` her render'da yeni nesne; kimliği `targetKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, type, targetKey],
  );
}

/** Global: tüm olaylar (unsur/katman dinleyicileri `stopPropagation` demediyse). */
export function useMapEvent(type: MapEventType, handler: MapEventListener): void {
  useRouterListener('useMapEvent', type, undefined, '*', handler);
}

/** Katmanın alt ağacındaki herhangi bir unsurda olan olaylar. */
export function useLayerEvent(layerId: string, type: MapEventType, handler: MapEventListener): void {
  useRouterListener('useLayerEvent', type, { layerId }, `l:${layerId}`, handler);
}

/** Tek unsurun olayları. */
export function useFeatureEvent(featureId: string, type: MapEventType, handler: MapEventListener): void {
  useRouterListener('useFeatureEvent', type, { featureId }, `f:${featureId}`, handler);
}
