// core.html: spike'ın yük üreteci + gerçek @c2/map-core boru hattı.
//   üreteç → store.transaction → MapSync (kare başına tek flush) → adapter (MapLibre | deck.gl)
//   adapter hit-test → EventRouter → store (seçim / hover) → MapSync → adapter (feature-state)
// URL: ?engine=deck|maplibre&format=full|patch&n=10000&hz=1&apply=10&motion=off|on|auto&z=9

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
  STREAM_FORMAT,
  SymbologyRegistry,
  createLayerStream,
  type Feature,
  type FeaturePatch,
  type Scheduler,
  type StreamFormat,
  type StreamItem,
} from '@c2/map-core';
import { UnitGenerator, type UnitMessage } from '../generator';
import { Stats } from '../stats';
import { buildSidc, ECHELONS, ENTITIES, IDENTITIES, SymbolCache } from '../symbology';
import { createMaplibreAdapter, markerRenderer, MOTION_MODE, type DeckIcon, type MotionMode } from '@c2/map-maplibre';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { BASEMAPS, ORTOFOTO_ID } from './basemaps';

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
  motion: (Object.values(MOTION_MODE) as string[]).includes(params.get('motion') ?? '')
    ? (params.get('motion') as MotionMode)
    : MOTION_MODE.AUTO,
  zoom: params.has('z') ? Number(params.get('z')) : 6.5,
  /** Mesaj formatı: en kötü durum (tam nesne) varsayılan — karar #10. */
  format: (params.get('format') === STREAM_FORMAT.PATCH ? STREAM_FORMAT.PATCH : STREAM_FORMAT.FULL) as StreamFormat,
};

// ── Çekirdek ─────────────────────────────────────────────────────

const stats = new Stats();
const symbols = new SymbolCache();
const store = createMapStore();
const router = new EventRouter(store);

// Tek paket: @c2/map-maplibre. `milsym` kind'ı motor seçimine göre ya deck.gl'e (`deckRenderers`) ya
// MapLibre `marker` renderer'ına gider; altlıklar her iki durumda da aynı MapLibre haritasında.
const sidcOf = (f: Feature) => (f.props as { sidc?: string } | undefined)?.sidc;
const deckIcons = new Map<string, DeckIcon>();
const deckIcon = (sidc: string): DeckIcon => {
  let icon = deckIcons.get(sidc);
  if (!icon) {
    const img = symbols.get(sidc);
    icon = { id: sidc, url: symbols.dataUrl(sidc), width: img.canvas.width, height: img.canvas.height };
    deckIcons.set(sidc, icon);
  }
  return icon;
};

const adapter = createMaplibreAdapter({
  // Stil yalnız arka plan; altlıklar store'dan gelir (Faz 1.2).
  workerUrl,
  ...(settings.engine === ENGINE.DECK
    ? {
        deckRenderers: {
          milsym: {
            icon: (f) => {
              const sidc = sidcOf(f);
              return sidc ? deckIcon(sidc) : undefined;
            },
            size: (f) => symbols.get(sidcOf(f)!).height, // CSS px
          },
        },
        motion: settings.motion,
        motionDurationMs: 1000 / settings.perUnitHz,
      }
    : {
        renderers: { milsym: markerRenderer({ icon: sidcOf }) },
        resolveImage: (sidc: string) => {
          const img = symbols.get(sidc);
          const ctx = img.canvas.getContext('2d')!;
          return { image: ctx.getImageData(0, 0, img.canvas.width, img.canvas.height), pixelRatio: img.pixelRatio };
        },
      }),
});

await adapter.mount(document.getElementById('map')!, {
  initialView: { center: [32.85, 39.9], zoom: settings.zoom },
  events: router,
  kinds: new FeatureKindRegistry(),
  symbology: new SymbologyRegistry(),
  basemapProviders: new BasemapProviderRegistry(),
});
// Ölçüm paneli: harita çizim sayacı motorun kendisinden (kaçış kapısı `getEngine`).
adapter.getEngine().on('render', () => stats.mapRendered());
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

// ── Yük üreteci → akış (createLayerStream) → store ───────────────
// Üretecin mesajları "backend biçimi" sayılır; normalize onları modele çevirir.
//   full  : her mesaj birliğin TAMAMI (en kötü durum; props/meta/style her seferinde yeni nesne)
//   patch : yalnız değişen alanlar (konum + varsa yeni sembol)

const unitId = (n: number) => `u${n}`;
let entityOf: number[] = [];
let echelonOf: number[] = [];
let identityOf: number[] = [];

const fullFeature = (m: UnitMessage): StreamItem => ({
  id: unitId(m.id),
  kind: 'milsym',
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [m.lon, m.lat] },
  props: { sidc: buildSidc(identityOf[m.id] ?? 0, entityOf[m.id] ?? 0, echelonOf[m.id] ?? 0) },
  style: { size: 24 },
  meta: { hdg: m.hdg },
});

const normalize = (m: UnitMessage): StreamItem => {
  if (m.identity !== undefined) identityOf[m.id] = m.identity;
  if (settings.format === STREAM_FORMAT.FULL) return fullFeature(m);
  const patch: FeaturePatch = {
    id: unitId(m.id),
    geometry: { kind: GEOMETRY_KIND.POINT, coord: [m.lon, m.lat] },
    meta: { hdg: m.hdg },
  };
  if (m.identity !== undefined) patch.props = { sidc: buildSidc(m.identity, entityOf[m.id] ?? 0, echelonOf[m.id] ?? 0) };
  return patch;
};

const stream = createLayerStream<UnitMessage>(store, { layerId: LAYER_ID, format: settings.format, normalize });

const generator = new UnitGenerator((msgs) => {
  const t0 = performance.now();
  stream.update(msgs); // bir WS paketi = bir transaction
  stats.work(performance.now() - t0, 0, false);
  stats.messages(msgs.length);
});
generator.perUnitHz = settings.perUnitHz;

function resetUnits(): void {
  const snapshot = generator.reset(settings.count);
  entityOf = snapshot.map((m) => m.entity ?? 0);
  echelonOf = snapshot.map((m) => m.echelon ?? 0);
  identityOf = snapshot.map((m) => m.identity ?? 0);
  // Yeniden bağlanma ile aynı yol: katmanı snapshot ile eşitle (snapshot her zaman tam nesne)
  store.transaction((tx) =>
    tx.replaceLayerContents(LAYER_ID, snapshot.map((m) => ({ ...(fullFeature(m) as Feature), layerId: LAYER_ID }))),
  );
}

store.transaction((tx) => {
  tx.upsertLayers([{ id: LAYER_ID, name: 'Birlikler', parentId: null, visible: true, opacity: 1, renderGroup: true }]);
  tx.upsertBasemaps(BASEMAPS);
});
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
  <label>Mesaj formatı
    <select id="format">
      ${option(STREAM_FORMAT.FULL, 'Tam nesne (en kötü)', settings.format)}
      ${option(STREAM_FORMAT.PATCH, 'Kısmi patch', settings.format)}
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
    <select id="motion">
      ${option(MOTION_MODE.AUTO, 'Otomatik (FPS)', settings.motion)}
      ${option(MOTION_MODE.ON, 'Açık', settings.motion)}
      ${option(MOTION_MODE.OFF, 'Kapalı', settings.motion)}
    </select>
  </label>
  <div>
    <label>Altlık
      <select id="basemap">${BASEMAPS.filter((b) => b.id !== ORTOFOTO_ID)
        .map((b) => option(b.id, b.name, BASEMAPS.find((x) => x.visible && x.id !== ORTOFOTO_ID)?.id ?? ''))
        .join('')}</select>
    </label>
    <label>Altlık opaklığı <input type="range" id="basemap-opacity" min="0" max="1" step="0.05" value="0.6" /></label>
    <label>Ortofoto (IMAGE) <input type="checkbox" id="ortofoto" /></label>
  </div>
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
  next.set('motion', settings.motion);
  next.set('format', settings.format);
  for (const [k, v] of Object.entries(changes)) next.set(k, v);
  location.search = next.toString();
}

$<HTMLSelectElement>('engine').onchange = (e) => reloadWith({ engine: (e.target as HTMLSelectElement).value });
$<HTMLSelectElement>('apply').onchange = (e) => reloadWith({ apply: (e.target as HTMLSelectElement).value });
// Mod canlı değişir (sayfa yenilenmez): adapter.setMotionMode
$<HTMLSelectElement>('motion').onchange = (e) => {
  settings.motion = (e.target as HTMLSelectElement).value as MotionMode;
  adapter.setMotionMode(settings.motion);
};
$<HTMLSelectElement>('count').onchange = (e) => {
  settings.count = Number((e.target as HTMLSelectElement).value);
  resetUnits();
};
$<HTMLSelectElement>('hz').onchange = (e) => {
  reloadWith({ hz: (e.target as HTMLSelectElement).value }); // kayma süresi mount'ta verilir
};
$<HTMLSelectElement>('format').onchange = (e) => reloadWith({ format: (e.target as HTMLSelectElement).value });
// Altlıklar store üzerinden: radyo davranışını store'un exclusiveGroup kuralı sağlar.
$<HTMLSelectElement>('basemap').onchange = (e) =>
  store.transaction((tx) => tx.patchBasemap((e.target as HTMLSelectElement).value, { visible: true }));
$<HTMLInputElement>('basemap-opacity').oninput = (e) => {
  const opacity = Number((e.target as HTMLInputElement).value);
  store.transaction((tx) => {
    for (const b of store.getBasemaps()) if (b.exclusiveGroup) tx.patchBasemap(b.id, { opacity });
  });
};
$<HTMLInputElement>('ortofoto').onchange = (e) =>
  store.transaction((tx) => tx.patchBasemap(ORTOFOTO_ID, { visible: (e.target as HTMLInputElement).checked }));
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
    ['Akıcı hareket', settings.engine === ENGINE.DECK ? `${adapter.motion.mode} → ${adapter.motion.active ? 'açık' : 'kapalı'}` : '—'],
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
