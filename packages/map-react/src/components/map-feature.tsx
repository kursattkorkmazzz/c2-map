import { GEOMETRY_KIND, type Feature, type Geometry, type LngLat } from '@c2/map-core';
import { useContext } from 'react';
import { LayerContext } from '../context';
import { compact } from './compact';
import { useDeclarative, type DeclarativeOps } from './use-declarative';

/** Hazır kısayolların kullandığı kind'lar (adapter'da bu adlarla renderer olmalı). */
export const BUILTIN_KIND = {
  VECTOR: 'vector',
  MARKER: 'marker',
  MILSYM: 'milsym',
} as const;

export type MapFeatureProps<S = unknown, P = unknown> = {
  id: string;
  kind: string;
  geometry: Geometry;
  style?: S;
  props?: P;
  z?: number;
  hidden?: boolean;
  selectable?: boolean;
  /** Görsel olmayan veri: haritaya gitmez, yalnız `useFeature` abonelerine. */
  meta?: Record<string, unknown>;
};

const featureOps: DeclarativeOps<Feature> = {
  // Unsurda tam upsert: store içeriği aynı alanları zaten ayıklar (stabilize), satır içi
  // `geometry={{…}}` her render'da yeni nesne olsa da haritaya iş gitmez.
  upsert: (tx, feature) => tx.upsertFeatures([feature]),
  remove: (tx, id) => tx.removeFeatures([id]),
};

/**
 * Statik / az sayıda unsur (kontrol tedbirleri, çizimler) için. Bir <MapLayer> içinde olmalı.
 * Canlı birlikler bileşen olarak DEĞİL, store'a akışla yazılır (`createLayerStream`).
 */
export function MapFeature<S = unknown, P = unknown>(props: MapFeatureProps<S, P>) {
  const layerId = useContext(LayerContext);
  if (layerId === null) throw new Error(`<MapFeature id="${props.id}"> bir <MapLayer> içinde olmalı.`);
  const feature = compact<Feature>({
    id: props.id,
    layerId,
    kind: props.kind,
    geometry: props.geometry,
    style: props.style,
    props: props.props,
    z: props.z,
    hidden: props.hidden,
    selectable: props.selectable,
    meta: props.meta,
  });
  useDeclarative('<MapFeature>', feature, featureOps);
  return null;
}

// ── Kısayollar ─────────────────────────────────────────────────

type Common<S> = Omit<MapFeatureProps<S>, 'kind' | 'geometry' | 'props'>;
/** Stil tipi motora özeldir (ör. MapLibre `VectorStyle`); burada serbest bırakılır. */
type AnyStyle = Record<string, unknown>;

export function Polygon<S = AnyStyle>({ rings, ...rest }: Common<S> & { rings: readonly (readonly LngLat[])[] }) {
  return <MapFeature {...rest} kind={BUILTIN_KIND.VECTOR} geometry={{ kind: GEOMETRY_KIND.POLYGON, rings }} />;
}

export function Polyline<S = AnyStyle>({ coords, ...rest }: Common<S> & { coords: readonly LngLat[] }) {
  return <MapFeature {...rest} kind={BUILTIN_KIND.VECTOR} geometry={{ kind: GEOMETRY_KIND.LINE, coords }} />;
}

export function Circle<S = AnyStyle>({ center, radiusM, ...rest }: Common<S> & { center: LngLat; radiusM: number }) {
  return <MapFeature {...rest} kind={BUILTIN_KIND.VECTOR} geometry={{ kind: GEOMETRY_KIND.CIRCLE, center, radiusM }} />;
}

export function Marker<S = AnyStyle>({
  coord,
  icon,
  props,
  ...rest
}: Common<S> & { coord: LngLat; icon?: string; props?: Record<string, unknown> }) {
  return (
    <MapFeature
      {...rest}
      kind={BUILTIN_KIND.MARKER}
      geometry={{ kind: GEOMETRY_KIND.POINT, coord }}
      props={icon === undefined ? props : { ...props, icon }}
    />
  );
}

/** Askeri sembol (APP-6 / 2525 SIDC). Çizimi adapter'daki `milsym` renderer'ı yapar. */
export function MilSymbol<S = AnyStyle>({
  coord,
  sidc,
  props,
  ...rest
}: Common<S> & { coord: LngLat; sidc: string; props?: Record<string, unknown> }) {
  return (
    <MapFeature
      {...rest}
      kind={BUILTIN_KIND.MILSYM}
      geometry={{ kind: GEOMETRY_KIND.POINT, coord }}
      props={{ ...props, sidc }}
    />
  );
}
