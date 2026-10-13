// ── Değer karşılaştırmasıyla referans koruma ─────────────────────
// Tasarım: plan/design/03-store.md#en-kötü-durum-her-mesajda-tam-nesne
//
// Store değişikliği referansla bulur (hızlı yol). Ama backend her mesajda birliğin TAMAMINI
// gönderirse JSON'dan her seferinde yeni `geometry` / `props` / `style` / `meta` nesneleri gelir;
// içerik aynı olsa bile "değişti" sayılırlar ve adapter ikon/stil gibi pahalı işleri boşuna yapar.
//
// Burada, referansı değişmiş alanların İÇERİĞİ karşılaştırılır; aynıysa eski referans korunur.
// Sonra `diff*` (referans karşılaştırması) gerçekten değişen alanları bulur.
// Maliyet yalnız referansı farklı alanlarda ödenir; aynı referans gelirse karşılaştırma yapılmaz.

import type { Basemap } from "../model/basemap";
import type { Feature } from "../model/feature";
import type { Layer } from "../model/layer";

/**
 * JSON benzeri değerlerin (ilkel, dizi, düz nesne) yapısal eşitliği.
 * Düz olmayan nesneler (Date, Map, typed array, sınıf örnekleri) yalnız referansla eşittir.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) if (!deepEqual(arrA[i], arrB[i])) return false;
    return true;
  }

  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/** İçerik aynıysa önceki referansı, değilse yenisini döner. */
function stable<T>(prev: T, next: T): T {
  return Object.is(prev, next) || deepEqual(prev, next) ? prev : next;
}

/**
 * `next`'teki referansı değişmiş ama içeriği aynı alanların yerine `prev`'inkini koyar.
 * Hiçbir şey değişmediyse `prev`'in kendisini döner (store eski nesneyi korur → abone bildirimi yok).
 */
export function stabilizeFeature(prev: Feature, next: Feature): Feature {
  if (prev === next) return prev;

  const geometry = stable(prev.geometry, next.geometry);
  const style = stable(prev.style, next.style);
  const props = stable(prev.props, next.props);
  const meta = stable(prev.meta, next.meta);

  const sameScalars =
    prev.layerId === next.layerId &&
    prev.kind === next.kind &&
    Object.is(prev.z, next.z) &&
    Object.is(prev.hidden, next.hidden) &&
    Object.is(prev.selectable, next.selectable);

  if (
    sameScalars &&
    geometry === prev.geometry &&
    style === prev.style &&
    props === prev.props &&
    meta === prev.meta
  ) {
    return prev; // `rev` farkı önemsiz: store `rev`'i ayrıca tutar
  }
  if (geometry === next.geometry && style === next.style && props === next.props && meta === next.meta) {
    return next; // korunacak alan yok
  }
  return { ...next, geometry, style, props, meta };
}

/** Katmanda yalnız `meta` nesnedir; diğer alanlar ilkel. */
export function stabilizeLayer(prev: Layer, next: Layer): Layer {
  if (prev === next) return prev;
  const meta = stable(prev.meta, next.meta);
  return meta === next.meta ? next : { ...next, meta };
}

/**
 * Altlıkta `source` nesnedir. Korunması önemli: yeni referanslı `source` adapter'da tile
 * kaynağının baştan yüklenmesi demektir.
 */
export function stabilizeBasemap(prev: Basemap, next: Basemap): Basemap {
  if (prev === next) return prev;
  const source = stable(prev.source, next.source);
  return source === next.source ? next : { ...next, source };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
