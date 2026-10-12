// ── FeatureKindRegistry ──────────────────────────────────────────
// Tasarım: plan/design/08-extensibility-symbology.md#registryler
//
// Unsur türlerinin (kind) motor-bağımsız tanımı. Yeni bir tür (ör. 'model3d') çekirdeği
// değiştirmeden buraya kaydedilir; çizimini adapter'daki renderer yapar.

import type { Bounds } from "../model/camera";
import type { Feature } from "../model/feature";
import { geometryBounds } from "./bounds";
import { Registry, type RegisterOptions } from "./registry";

export interface FeatureKindDefinition<S = unknown, P = unknown> {
  kind: string;
  /** Unsur geçerliyse `null`, değilse hata açıklaması. */
  validate?(feature: Feature): string | null;
  /** Unsurun `style`'ı ile sığ birleştirilen varsayılan (unsurun değeri baskın). */
  defaultStyle?: S;
  /** Unsurun `props`'u ile sığ birleştirilen varsayılan (unsurun değeri baskın). */
  defaultProps?: P;
  /** Sınır kutusu. Verilmezse geometriden hesaplanır. */
  bounds?(feature: Feature): Bounds | null;
  /**
   * Motor bu kind'i desteklemiyorsa daha basit bir kind'e çevirir (ör. model3d → marker).
   * Çevrilemiyorsa `null`: unsur o motorda çizilmez.
   */
  fallback?(feature: Feature): Feature | null;
}

/** Fallback zincirinin en fazla uzunluğu (tanımlar arası döngüye karşı). */
const MAX_FALLBACK_DEPTH = 8;

export class FeatureKindRegistry {
  private readonly registry = new Registry<FeatureKindDefinition>("kind", (def) => def.kind);

  register(definition: FeatureKindDefinition, options?: RegisterOptions): () => void {
    return this.registry.register(definition, options);
  }

  get(kind: string): FeatureKindDefinition | undefined {
    return this.registry.get(kind);
  }

  has(kind: string): boolean {
    return this.registry.has(kind);
  }

  kinds(): string[] {
    return this.registry.keys();
  }

  /** Kayıtlı tanımın doğrulayıcısını çalıştırır. Tanımı veya doğrulayıcısı yoksa geçerli sayılır. */
  validate(feature: Feature): string | null {
    return this.get(feature.kind)?.validate?.(feature) ?? null;
  }

  /** Varsayılan stil/props uygulanmış unsur. Varsayılan yoksa aynı referans döner. */
  withDefaults(feature: Feature): Feature {
    const def = this.get(feature.kind);
    if (!def || (def.defaultStyle === undefined && def.defaultProps === undefined)) return feature;
    return {
      ...feature,
      style: mergeDefaults(def.defaultStyle, feature.style),
      props: mergeDefaults(def.defaultProps, feature.props),
    };
  }

  bounds(feature: Feature): Bounds | null {
    const def = this.get(feature.kind);
    return def?.bounds ? def.bounds(feature) : geometryBounds(feature.geometry);
  }

  /**
   * Motorun desteklediği bir kind'e ulaşana kadar fallback zincirini izler.
   * Zaten destekleniyorsa aynı unsur; ulaşılamıyorsa `null`.
   */
  resolveFor(feature: Feature, isSupported: (kind: string) => boolean): Feature | null {
    let current: Feature | null = feature;
    for (let depth = 0; current && depth <= MAX_FALLBACK_DEPTH; depth++) {
      if (isSupported(current.kind)) return current;
      const definition: FeatureKindDefinition | undefined = this.get(current.kind);
      current = definition?.fallback ? definition.fallback(current) : null;
    }
    return null;
  }
}

function mergeDefaults<T>(defaults: T | undefined, value: T | undefined): T | undefined {
  if (defaults === undefined) return value;
  if (value === undefined) return defaults;
  if (isPlainObject(defaults) && isPlainObject(value)) return { ...defaults, ...value } as T;
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
