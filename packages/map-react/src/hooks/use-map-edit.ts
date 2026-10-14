// ── useMapEdit ───────────────────────────────────────────────────
// Tasarım: plan/design/09-interaction-and-editing.md#düzenleme-faz-252
//
//   const edit = useMapEdit();
//   edit.start(id);           // izin yoksa false (bayrak / bekleyen işlem / düzenlenemez geometri)
//   await edit.save();        // <Map lifecycle.beforeUpdate> → onayda taslak kalkar

import type { ActionResult, EditState } from '@c2/map-core';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useMapContext } from '../context';

export type MapEditApi = {
  /** Düzenlenen unsurun durumu (ipucu, çakışma, kaydediliyor…); düzenleme yoksa `null`. */
  readonly state: EditState | null;
  /** Düzenlemeyi başlatır (sürmekte olan çizim / düzenleme iptal olur). Başlamadıysa `false`. */
  start(featureId: string): boolean;
  save(): Promise<ActionResult | null>;
  undo(): void;
  cancel(): void;
};

export function useMapEdit(): MapEditApi {
  const { edit, draw, ready } = useMapContext('useMapEdit');
  const subscribe = useCallback((cb: () => void) => edit.subscribe(cb), [edit]);
  const getState = useCallback(() => edit.getState(), [edit]);
  const state = useSyncExternalStore(subscribe, getState, getState);
  const actions = useMemo(
    () => ({
      start: (featureId: string) => {
        if (!ready) return false;
        draw.cancel();
        return edit.start(featureId);
      },
      save: () => edit.save(),
      undo: () => edit.undo(),
      cancel: () => edit.cancel(),
    }),
    [edit, draw, ready],
  );
  return useMemo(() => ({ state, ...actions }), [state, actions]);
}
