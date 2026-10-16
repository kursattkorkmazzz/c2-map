// Test yardımcısı: sahnesiz render bağlamı (gerçek Cesium koleksiyonları, sahte sahne).
import type { LngLat } from '@c2/map-core';
import { FeatureKindRegistry } from '@c2/map-core';
import { CustomDataSource, Event, PrimitiveCollection, SceneMode, type Scene } from 'cesium';
import type { CesiumRenderContext } from '../renderers/types';

export type TestContext = CesiumRenderContext & {
  owners: Map<object, string>;
  frame: { n: number };
  ground: { height: number | undefined };
};

export function testContext(): TestContext {
  const dataSource = new CustomDataSource('test');
  const owners = new Map<object, string>();
  const frame = { n: 0 };
  const ground = { height: 1000 as number | undefined };
  const scene = { preUpdate: new Event(), postRender: new Event(), mode: SceneMode.SCENE3D } as unknown as Scene;
  return {
    scene,
    entities: dataSource.entities,
    primitives: new PrimitiveCollection(),
    dataSource,
    kinds: new FeatureKindRegistry(),
    pixelRatio: 1,
    own: (target, id) => owners.set(target, id),
    disown: (target) => owners.delete(target),
    groundHeight: (_coord: LngLat) => ground.height,
    frameNumber: () => frame.n,
    requestRender: () => {},
    owners,
    frame,
    ground,
  };
}
