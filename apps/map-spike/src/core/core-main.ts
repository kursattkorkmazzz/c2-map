// core.html: spike'ın yük üreteci + gerçek @c2/map-core boru hattı.
//   üreteç → store.transaction → MapSync (kare başına tek flush) → adapter (MapLibre | deck.gl)
//   adapter hit-test → EventRouter → store (seçim / hover) → MapSync → adapter (feature-state)
// URL: ?engine=deck|maplibre&n=10000&hz=1&apply=10&smooth=0&z=9

import 'maplibre-gl/dist/maplibre-gl.css';
import '../style.css';
import {
  BasemapProviderRegistry,
  createFrameScheduler,
  createMapStore,
  EventRouter,
  FeatureKindRegistry,
  GEOMETRY_KIND,
  MAP_EVENT,
  MapSync,
  SymbologyRegistry,
  type Feature,
  type FeaturePatch,
  type Scheduler,
} from '@c2/map-core';
import { UnitGenerator, type UnitMessage } from '../generator';
import { Stats } from '../stats';
import { buildSidc, ECHELONS, ENTITIES, IDENTITIES, SymbolCache } from '../symbology';
import { SpikeDeckAdapter } from './deck-adapter';
import { SpikeMaplibreAdapter } from './maplibre-adapter';

const ENGINE = { MAPLIBRE: 'maplibre', DECK: 'deck' } as const;
type Engine = (typeof ENGINE)[keyof typeof ENGINE];

const LAYER_ID = 'birlikler';

// ── Ayarlar ──────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const settings = {
  engine: (params.get('engine') === ENGINE.MAPLIBRE ? ENGINE.MAPLIBRE : ENGINE.DECK) as Engine,
  count: Number(params.get('n') ?? 10000),
  perUnitHz: Number(params.get('hz') ?? 1),
  applyHz: Number(params.get('apply') ?? 10),
  smooth: params.get('smooth') !== '0',
  zoom: params.has('z') ? Number(params.get('z')) : 6.5,
};

// ── Çekirdek ─────────────────────────────────────────────────────

const stats = new Stats();
const symbols = new SymbolCache();
const store = createMapStore();
const router = new EventRouter(store);

const adapter =
  settings.engine === ENGINE.DECK
    ? new SpikeDeckAdapter(symbols, () => stats.mapRendered())
    : new SpikeMaplibreAdapter(symbols, () => stats.mapRendered());
if (adapter instanceof SpikeDeckAdapter) {
  adapter.smooth = settings.smooth;
  adapter.durationMs = 1000 / settings.perUnitHz;
}

await adapter.mount(document.getElementById('map')!, {
  initialView: { center: [32.85, 39.9], zoom: settings.zoom },
  events: router,
  kinds: new FeatureKindRegistry(),
  symbology: new SymbologyRegistry(),
  basemapProviders: new BasemapProviderRegistry(),
});

/** MapSync'in flush'larını ölçen zamanlayıcı sarmalayıcısı. */
function timedScheduler(inner: Scheduler): Scheduler {
  return {
    schedule(task) {
      return inner.schedule(() => {
        const t0 = performance.now();
        task();
        stats.work(performance.now() - t0, adapter.lastSent, true);
      });
    },
  };
}

const sync = new MapSync({
  store,
  adapter,
  scheduler: timedScheduler(createFrameScheduler({ maxApplyHz: settings.applyHz })),
});
sync.start();

// ── Yük üreteci → store ──────────────────────────────────────────

const unitId = (n: number) => `u${n}`;
let entityOf: number[] = [];
let echelonOf: number[] = [];

const toFeature = (m: UnitMessage): Feature => ({
  id: unitId(m.id),
  layerId: LAYER_ID,
  kind: 'milsym',
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [m.lon, m.lat] },
  props: { sidc: buildSidc(m.identity ?? 0, m.entity ?? 0, m.echelon ?? 0) },
  meta: { hdg: m.hdg },
});

const generator = new UnitGenerator((msgs) => {
  const t0 = performance.now();
  const patches: FeaturePatch[] = msgs.map((m) => {
    const patch: FeaturePatch = {
      id: unitId(m.id),
      geometry: { kind: GEOMETRY_KIND.POINT, coord: [m.lon, m.lat] },
      meta: { hdg: m.hdg },
    };
    if (m.identity !== undefined) {
      patch.props = { sidc: buildSidc(m.identity, entityOf[m.id] ?? 0, echelonOf[m.id] ?? 0) };
    }
    return patch;
  });
  store.transaction((tx) => tx.patchFeatures(patches)); // bir WS paketi = bir transaction
  stats.work(performance.now() - t0, 0, false);
  stats.messages(msgs.length);
});
generator.perUnitHz = settings.perUnitHz;

function resetUnits(): void {
  const snapshot = generator.reset(settings.count);
  entityOf = snapshot.map((m) => m.entity ?? 0);
  echelonOf = snapshot.map((m) => m.echelon ?? 0);
  // Yeniden bağlanma ile aynı yol: katmanı snapshot ile eşitle
  store.transaction((tx) => tx.replaceLayerContents(LAYER_ID, snapshot.map(toFeature)));
}

store.transaction((tx) =>
  tx.upsertLayers([{ id: LAYER_ID, name: 'Birlikler', parentId: null, visible: true, opacity: 1, renderGroup: true }]),
);
resetUnits();
generator.start();

// ── Olaylar → store ──────────────────────────────────────────────

router.on(MAP_EVENT.CLICK, (e) =>
  store.transaction((tx) => (e.featureId ? tx.select([e.featureId]) : tx.clearSelection())),
);
router.on(MAP_EVENT.POINTER_ENTER, (e) => store.transaction((tx) => tx.setHovered(e.featureId ?? null)));
router.on(MAP_EVENT.POINTER_LEAVE, () => store.transaction((tx) => tx.setHovered(null)));
router.on(MAP_EVENT.VIEW_CHANGE, (e) => e.view && sync.setView(e.view));

// ── Seçili birlik kartı: yalnız o id'ye abone (React useFeature'ın yaptığı) ──

let offSelected: (() => void) | null = null;
let selectedId: string | null = null;
store.subscribeSelection(() => {
  selectedId = [...store.getSelection()][0] ?? null;
  offSelected?.();
  offSelected = selectedId ? store.subscribeFeature(selectedId, renderSelected) : null;
  renderSelected();
});

// ── Kare döngüsü ─────────────────────────────────────────────────

function frame(now: number): void {
  if (adapter instanceof SpikeDeckAdapter && adapter.smooth) {
    const t0 = performance.now();
    adapter.animate(now);
    stats.work(performance.now() - t0, 0, false);
  }
  if (stats.frame(now)) renderStats();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── Panel ────────────────────────────────────────────────────────

const panel = document.getElementById('panel')!;
const option = (value: string | number, label: string, current: string | number) =>
  `<option value="${value}" ${String(value) === String(current) ? 'selected' : ''}>${label}</option>`;

panel.innerHTML = `
  <h1>Çekirdek testi — @c2/map-core</h1>
  <p class="hint">Üreteç → store → MapSync → adapter. <a href="./index.html" style="color:#9ad0ff">Eski spike sayfası</a></p>
  <label>Motor
    <select id="engine">
      ${option(ENGINE.DECK, 'deck.gl', settings.engine)}
      ${option(ENGINE.MAPLIBRE, 'MapLibre (GeoJSON)', settings.engine)}
    </select>
  </label>
  <label>Birlik sayısı
    <select id="count">${[1000, 3000, 10000, 20000, 50000].map((n) => option(n, n.toLocaleString('tr-TR'), settings.count)).join('')}</select>
  </label>
  <label>Mesaj / birlik / sn
    <select id="hz">${[0.5, 1, 2, 5].map((n) => option(n, String(n), settings.perUnitHz)).join('')}</select>
  </label>
  <label>Haritaya uygulama (Hz)
    <select id="apply">${[5, 10, 20, 30].map((n) => option(n, String(n), settings.applyHz)).join('')}</select>
  </label>
  <label ${settings.engine === ENGINE.DECK ? '' : 'style="display:none"'}>Akıcı hareket
    <input type="checkbox" id="smooth" ${settings.smooth ? 'checked' : ''} />
  </label>
  <label>Akışı durdur <input type="checkbox" id="paused" /></label>
  <table id="stats"></table>
  <div class="selected" id="selected"></div>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Motor, uygulama Hz'i ve akıcı hareket sayfa yeniden yüklenerek değişir (temiz ölçüm). */
function reloadWith(changes: Record<string, string>): void {
  const next = new URLSearchParams(location.search);
  next.set('engine', settings.engine);
  next.set('n', String(settings.count));
  next.set('hz', String(settings.perUnitHz));
  next.set('apply', String(settings.applyHz));
  next.set('smooth', settings.smooth ? '1' : '0');
  for (const [k, v] of Object.entries(changes)) next.set(k, v);
  location.search = next.toString();
}

$<HTMLSelectElement>('engine').onchange = (e) => reloadWith({ engine: (e.target as HTMLSelectElement).value });
$<HTMLSelectElement>('apply').onchange = (e) => reloadWith({ apply: (e.target as HTMLSelectElement).value });
$<HTMLInputElement>('smooth').onchange = (e) => reloadWith({ smooth: (e.target as HTMLInputElement).checked ? '1' : '0' });
$<HTMLSelectElement>('count').onchange = (e) => {
  settings.count = Number((e.target as HTMLSelectElement).value);
  resetUnits();
};
$<HTMLSelectElement>('hz').onchange = (e) => {
  settings.perUnitHz = generator.perUnitHz = Number((e.target as HTMLSelectElement).value);
  if (adapter instanceof SpikeDeckAdapter) adapter.durationMs = 1000 / settings.perUnitHz;
};
$<HTMLInputElement>('paused').onchange = (e) => {
  if ((e.target as HTMLInputElement).checked) generator.stop();
  else generator.start();
};

function renderStats(): void {
  const s = stats.snapshot;
  const fmt = (n: number, d = 0) => n.toLocaleString('tr-TR', { maximumFractionDigits: d, minimumFractionDigits: d });
  const grade = (v: number, good: number, warn: number, higher: boolean) =>
    higher ? (v >= good ? 'good' : v >= warn ? 'warn' : 'bad') : v <= good ? 'good' : v <= warn ? 'warn' : 'bad';
  const rows: [string, string, string?][] = [
    ['FPS (sayfa)', fmt(s.fps), grade(s.fps, 50, 30, true)],
    ['Harita çizimi / sn', fmt(s.mapRendersPerSec)],
    ['En uzun kare', `${fmt(s.worstFrameMs)} ms`, grade(s.worstFrameMs, 34, 100, false)],
    ['Gelen mesaj / sn', fmt(s.msgsPerSec)],
    ['MapSync flush / sn', fmt(s.flushesPerSec)],
    ['Haritaya giden unsur / sn', fmt(s.sentPerSec)],
    ['Çekirdek + besleme işi (ms / sn)', fmt(s.mapWorkMsPerSec, 1), grade(s.mapWorkMsPerSec, 70, 150, false)],
    ['En uzun flush', `${fmt(s.maxFlushMs, 1)} ms`, grade(s.maxFlushMs, 4, 16, false)],
    ['Long task (>50 ms)', fmt(s.longTasks), grade(s.longTasks, 0, 2, false)],
    ['Store: düşürülen eski rev', fmt(store.stats.droppedStale)],
    ['Benzersiz sembol', fmt(symbols.size)],
  ];
  $('stats').innerHTML = rows.map(([k, v, c]) => `<tr><td>${k}</td><td class="${c ?? ''}">${v}</td></tr>`).join('');
}

function renderSelected(): void {
  const el = $('selected');
  const f = selectedId ? store.getFeature(selectedId) : undefined;
  if (!f || f.geometry.kind !== 'point') {
    el.textContent = 'Seçmek için bir birliğe tıklayın.';
    return;
  }
  const n = Number(f.id.slice(1));
  const sidc = (f.props as { sidc: string }).sidc;
  const identity = IDENTITIES.find((i) => i.code === sidc[3]);
  el.textContent = [
    `Birlik ${f.id}`,
    `Birim : ${ENTITIES[entityOf[n] ?? 0]?.name} ${ECHELONS[echelonOf[n] ?? 0]?.name}`,
    `Kimlik: ${identity?.name ?? '?'}`,
    `SIDC  : ${sidc}`,
    `Konum : ${f.geometry.coord[1].toFixed(5)}, ${f.geometry.coord[0].toFixed(5)}`,
    `Yön   : ${Math.round((f.meta as { hdg: number }).hdg)}° (meta → haritaya gitmez)`,
  ].join('\n');
}
renderSelected();
