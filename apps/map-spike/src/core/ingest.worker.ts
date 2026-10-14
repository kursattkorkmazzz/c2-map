// core.html?ingest=worker — "backend" + ingest Worker'da.
// Gerçekte burada bir WebSocket olurdu (`runIngestWorker({ socket: { url, onMessage } })`); spike'ta
// üreteç Worker'ın içinde çalışır ve mesajları WS gibi JSON METNİ olarak verir. Parse, normalize ve
// tam nesne → patch dönüşümü Worker'da; ana thread yalnız paketi uygular.

import { runIngestWorker, STREAM_FORMAT, type IngestApi, type StreamFormat } from '@c2/map-core';
import { UnitGenerator, type UnitMessage } from '../generator';
import { toWire, UNIT_LAYER, UnitFeed } from './unit-feed';

export type IngestCommand =
  | { type: 'init'; count: number; hz: number; format: StreamFormat; verbose: boolean }
  | { type: 'reset'; count: number }
  | { type: 'pause' }
  | { type: 'resume' };

const feed = new UnitFeed(STREAM_FORMAT.FULL);
let generator: UnitGenerator | null = null;

function reset(api: IngestApi, count: number): void {
  const snapshot = generator!.reset(count);
  api.snapshot(UNIT_LAYER, feed.reset(snapshot)); // yeniden bağlanma ile aynı yol
}

runIngestWorker({
  // Mesajlar burada normalize edilir (aşağıda); motor yalnız tam nesne ↔ patch işini yapar.
  streams: { [UNIT_LAYER]: {} },
  onCommand(command, api) {
    const c = command as IngestCommand;
    if (c.type === 'init') {
      feed.format = c.format;
      generator = new UnitGenerator((msgs: UnitMessage[]) => {
        const wire = toWire(msgs, c.verbose); // "backend" tarafı (ölçüme girmez)
        const parsed = JSON.parse(wire) as UnitMessage[]; // ingest işi: Worker'da
        api.update(UNIT_LAYER, parsed.map(feed.normalize), c.format);
      });
      generator.perUnitHz = c.hz;
      reset(api, c.count);
      generator.start();
    } else if (c.type === 'reset') reset(api, c.count);
    else if (c.type === 'pause') generator?.stop();
    else if (c.type === 'resume') generator?.start();
  },
});
