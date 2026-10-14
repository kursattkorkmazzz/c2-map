// ── useMapDraw ───────────────────────────────────────────────────
// Tasarım: plan/design/09-interaction-and-editing.md#çizim-mimarisi-öneri
//
//   const draw = useMapDraw();
//   const geometry = await draw.start('polygon');   // iptalde null
//   if (geometry) store.transaction(tx => tx.upsertFeatures([{ …, geometry }]));
//
// Sonucu ne yapacağı uygulamanın kararıdır (store'a yaz, backend'e gönder, ölçüm göster…).

import type { DrawState, DrawToolKind, DrawToolOptions, Geometry } from '@c2/map-core';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useMapContext } from '../context';

export type MapDrawApi = {
  /** Sürmekte olan çizimin durumu (araç, ipucu, ölçüm); çizim yoksa `null`. */
  readonly state: DrawState | null;
  /** Çizimi başlatır (sürmekte olanı iptal eder). Bitince geometri, iptalde `null`. */
  start(tool: DrawToolKind, options?: DrawToolOptions): Promise<Geometry | null>;
  finish(): void;
  undo(): void;
  cancel(): void;
};

export function useMapDraw(): MapDrawApi {
  const { draw, edit, ready } = useMapContext('useMapDraw');
  const subscribe = useCallback((cb: () => void) => draw.subscribe(cb), [draw]);
  const getState = useCallback(() => draw.getState(), [draw]);
  const state = useSyncExternalStore(subscribe, getState, getState);

  const actions = useMemo(
    () => ({
      start: (tool: DrawToolKind, options?: DrawToolOptions) => {
        if (!ready) return Promise.reject(new Error('Harita henüz hazır değil; çizim başlatılamaz.'));
        edit.cancel(); // çizim ve düzenleme aynı anda olmaz
        return draw.start(tool, options).result;
      },
      finish: () => draw.finish(),
      undo: () => draw.undo(),
      cancel: () => draw.cancel(),
    }),
    [draw, edit, ready],
  );
  return useMemo(() => ({ state, ...actions }), [state, actions]);
}
