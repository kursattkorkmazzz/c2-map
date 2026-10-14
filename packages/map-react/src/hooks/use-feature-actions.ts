// ── İzinli işlemler ──────────────────────────────────────────────
// Tasarım: plan/design/09-interaction-and-editing.md#izinler-ve-yaşam-döngüsü
//
//   const { canDelete, pending } = useFeaturePermissions(id);
//   const actions = useFeatureActions();
//   await actions.delete(id);   // bayrak → <Map lifecycle.beforeDelete> → store

import type { FeatureActions, FeaturePermissions } from '@c2/map-core';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useMapContext } from '../context';

/** Ekle / güncelle / sil — bayrak + yaşam döngüsü kurallarıyla. Sonuç: `ACTION_RESULT`. */
export function useFeatureActions(): Pick<FeatureActions, 'create' | 'update' | 'delete' | 'canEdit' | 'canDelete' | 'isPending'> {
  const { actions } = useMapContext('useFeatureActions');
  return useMemo(
    () => ({
      create: (feature) => actions.create(feature),
      update: (feature) => actions.update(feature),
      delete: (id) => actions.delete(id),
      canEdit: (id) => actions.canEdit(id),
      canDelete: (id) => actions.canDelete(id),
      isPending: (id) => actions.isPending(id),
    }),
    [actions],
  );
}

/** Unsurun izinleri; unsur, katman zinciri veya bekleme durumu değişince render olur. */
export function useFeaturePermissions(id: string): FeaturePermissions {
  const { actions } = useMapContext('useFeaturePermissions');
  const subscribe = useCallback((cb: () => void) => actions.subscribe(id, cb), [actions, id]);
  const getSnapshot = useMemo(() => {
    let last: FeaturePermissions | null = null;
    return () => {
      const next = actions.permissions(id);
      if (last && last.canEdit === next.canEdit && last.canDelete === next.canDelete && last.pending === next.pending) return last;
      return (last = next);
    };
  }, [actions, id]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
