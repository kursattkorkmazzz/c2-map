// ── Tam nesne → patch (Worker tarafı) ────────────────────────────
// Tasarım: plan/design/03-store.md#ingest-worker-faz-36
//
// Backend her mesajda unsurun TAMAMINI gönderiyorsa (karar #10, en kötü durum), Worker son hâli
// tutar ve ana thread'e yalnız değişeni gönderir. Store patch'te `style` / `props` / `meta`'yı SIĞ
// birleştirir: patch bir alt anahtarı silemez. Bu yüzden:
//   - değişmeyen alan patch'e girmez; hiçbir şey değişmediyse `same`
//   - değişen nesne alanı, eski anahtarların hepsi duruyorsa tam hâliyle patch'e girer
//     (sığ birleştirme sonucu yeni nesneye eşit olur)
//   - bir alt anahtar silindiyse veya kind değiştiyse → `full` (tam nesne gönderilir; nadir)
//   - kalkan üst düzey alan → `alan: undefined` (store'da birleştirme onu kaldırır)

import type { Feature } from "../../model/feature";
import type { FeaturePatch } from "../../store/diff";
import { deepEqual, geometryEqual } from "../../store/stabilize";

export type FeatureDelta = { type: "same" } | { type: "patch"; patch: FeaturePatch } | { type: "full" };

/** Birleştirilen nesne alanları (store `mergeFeaturePatch` ile aynı). */
const MERGED = ["style", "props", "meta"] as const;
/** Doğrudan yazılan alanlar. */
const SCALARS = ["layerId", "z", "hidden", "selectable", "editable", "deletable"] as const;

export function featureDelta(prev: Feature, next: Feature): FeatureDelta {
  if (prev.kind !== next.kind) return { type: "full" };

  const patch: Record<string, unknown> = {};
  let changed = false;

  if (!geometryEqual(prev.geometry, next.geometry)) {
    patch.geometry = next.geometry;
    changed = true;
  }
  for (const key of SCALARS) {
    if (Object.is(prev[key], next[key])) continue;
    patch[key] = next[key];
    changed = true;
  }
  for (const key of MERGED) {
    const a = prev[key];
    const b = next[key];
    if (a === b || deepEqual(a, b)) continue;
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const k of Object.keys(a)) if (!(k in b)) return { type: "full" }; // alt anahtar silindi
    }
    patch[key] = b; // undefined → alan kalkar; düz olmayan → değiştirilir
    changed = true;
  }

  if (!changed) return { type: "same" };
  patch.id = next.id;
  if (next.rev !== undefined) patch.rev = next.rev;
  return { type: "patch", patch: patch as FeaturePatch };
}

/**
 * İki patch tek patch'e kayıpsız birleşebilir mi? Store patch'leri sırayla uygularken nesne alanını
 * sığ birleştirir; ilki alanı kaldırıyor / düz olmayan değere çeviriyor, ikincisi düz nesne veriyorsa
 * tek patch "önce kaldır" bilgisini taşıyamaz (eski anahtarlar kalırdı) → ayrı gönderilmeli.
 */
export function canMergePatches(first: FeaturePatch, second: FeaturePatch): boolean {
  for (const key of MERGED) {
    if (!(key in first) || !(key in second)) continue;
    const a = (first as Record<string, unknown>)[key];
    const b = (second as Record<string, unknown>)[key];
    if (!isPlainObject(a) && isPlainObject(b)) return false;
  }
  return true;
}

/** İki patch'i sırayla birleştirir (sonra gelen kazanır; nesne alanları store gibi sığ birleşir). Önce `canMergePatches`. */
export function mergePatches(first: FeaturePatch, second: FeaturePatch): FeaturePatch {
  const merged: Record<string, unknown> = { ...first, ...second };
  for (const key of MERGED) {
    if (!(key in second)) continue;
    const a = (first as Record<string, unknown>)[key];
    const b = (second as Record<string, unknown>)[key];
    merged[key] = key in first && isPlainObject(a) && isPlainObject(b) ? { ...a, ...b } : b;
  }
  return merged as FeaturePatch;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
