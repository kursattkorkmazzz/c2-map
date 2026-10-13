// Bildirimsel bileşenlerin ortak yaşam döngüsü:
//   mount (veya id değişimi) → upsert       unmount → YALNIZ kendi id'sini sil
//   prop değişimi            → yalnız değişen alanlar (patch) veya tam nesne (upsert)
//
// Neden değişen alanlar: kullanıcı katmanı LayerTree'den kapattıysa, bileşenin başka bir prop'u
// (ör. ad) değişti diye `visible` prop'u o kararı ezmemeli. Prop, yalnız kendisi değişince yazılır.

import type { MapTx } from '@c2/map-core';
import { useEffect, useRef } from 'react';
import { useMapContext } from '../context';

type Entity = { id: string };

export type DeclarativeOps<T extends Entity> = {
  upsert(tx: MapTx, value: T): void;
  remove(tx: MapTx, id: string): void;
  /** Verilmezse herhangi bir alan değişince tam upsert. */
  patch?(tx: MapTx, id: string, changed: Partial<T>): void;
};

export function useDeclarative<T extends Entity>(hook: string, value: T, ops: DeclarativeOps<T>): void {
  const { writer } = useMapContext(hook);
  const latest = useRef(value);
  const written = useRef<T | null>(null);
  latest.current = value;

  useEffect(() => {
    const current = latest.current;
    writer.enqueue((tx) => ops.upsert(tx, current));
    written.current = current;
    return () => {
      written.current = null;
      writer.enqueue((tx) => ops.remove(tx, current.id));
    };
    // ops modül sabiti; değer güncellemeleri aşağıdaki effect'te.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writer, value.id]);

  useEffect(() => {
    const before = written.current;
    if (!before || before === value) return;
    written.current = value;
    const changed = changedFields(before, value);
    if (!changed) return;
    if (ops.patch) writer.enqueue((tx) => ops.patch!(tx, value.id, changed));
    else writer.enqueue((tx) => ops.upsert(tx, value));
  });
}

/** Referansı değişen alanlar (yoksa `null`). İçerik eşitliği store'un işi (stabilize). */
function changedFields<T extends Entity>(before: T, after: T): Partial<T> | null {
  let changed: Partial<T> | null = null;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof T>;
  for (const key of keys) {
    if (Object.is(before[key], after[key])) continue;
    (changed ??= {} as Partial<T>)[key] = after[key];
  }
  return changed;
}
