// Test yardımcıları (paket dışına açılmaz).
import {
  createManualScheduler,
  createMapStore,
  MockAdapter,
  type MapStore,
  type MountOptions,
} from '@c2/map-core';
import { act, render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { Map, type MapProps } from './map';

/**
 * Mount asenkron (gerçek adapter'lar gibi). Daha sıkı: önceki mount BİTMEDEN veya unmount
 * edilmeden ikinci mount → hata (MaplibreAdapter bu durumda sessizce iki harita kurardı).
 */
export class StrictMockAdapter extends MockAdapter {
  mountCount = 0;
  unmountCount = 0;
  private busy = false;
  override async mount(container: HTMLElement, options: MountOptions): Promise<void> {
    if (this.busy) throw new Error('önceki mount sürüyor veya unmount edilmedi');
    this.busy = true;
    this.mountCount++;
    await Promise.resolve();
    await super.mount(container, options);
  }
  override unmount(): void {
    this.busy = false;
    this.unmountCount++;
    super.unmount();
  }
}

/** Mikro görevleri (bildirimsel yazıcı, mount) ve React güncellemelerini boşaltır. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

export type Harness = {
  adapter: StrictMockAdapter;
  store: MapStore;
  scheduler: ReturnType<typeof createManualScheduler>;
  /** Bekleyen yazmaları uygula + MapSync'i bir kare ilerlet. */
  frame(): Promise<void>;
  rerender(children: ReactNode): void;
  unmount(): void;
};

export async function renderMap(
  children: ReactNode,
  props: Partial<MapProps> = {},
  wrap: (ui: ReactElement) => ReactElement = (ui) => ui,
): Promise<Harness> {
  const adapter = (props.adapter as StrictMockAdapter | undefined) ?? new StrictMockAdapter();
  const store = props.store ?? createMapStore();
  const scheduler = createManualScheduler();
  const ui = (content: ReactNode) =>
    wrap(
      <Map adapter={adapter} store={store} scheduler={scheduler} initialView={{ center: [32, 39], zoom: 7 }} {...props}>
        {content}
      </Map>,
    );
  const result = render(ui(children));
  await settle();
  return {
    adapter,
    store,
    scheduler,
    async frame() {
      await settle();
      act(() => scheduler.run());
    },
    rerender: (next) => result.rerender(ui(next)),
    unmount: () => result.unmount(),
  };
}
