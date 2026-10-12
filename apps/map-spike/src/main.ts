import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import type { MapGeoJSONFeature, MapMouseEvent } from 'maplibre-gl';
import { DeckUnitRenderer } from './deck-renderer';
import { UnitGenerator, type UnitMessage } from './generator';
import {
  createMap,
  getUnitsSource,
  setBasemapVisible,
  setIconCollision,
  setUnitLayersVisible,
  UNITS_ICON_LAYER,
  UNITS_SOURCE,
} from './map';
import { RENDER_MODE, UnitRenderer, type RenderMode } from './renderer';
import { Stats } from './stats';
import { UnitStore } from './store';

// ── Ayarlar (URL ile de verilebilir: ?n=10000&mode=deck&hz=1&apply=10&smooth=0) ──
const params = new URLSearchParams(location.search);
const settings = {
  count: Number(params.get('n') ?? 3000),
  mode: (params.get('mode') ?? RENDER_MODE.BATCH_DIFF) as RenderMode,
  perUnitHz: Number(params.get('hz') ?? 1),
  applyHz: Number(params.get('apply') ?? 10),
  smooth: params.get('smooth') !== '0',
  collision: false,
  basemap: true,
  paused: false,
};

const map = await createMap(document.getElementById('map')!);
const store = new UnitStore();
const renderer = new UnitRenderer(getUnitsSource(map), store);
const deck = new DeckUnitRenderer(map, store);
const stats = new Stats();

// ── Backend akışı → store (+ NAIVE modda doğrudan harita) ──
const generator = new UnitGenerator((msgs: UnitMessage[]) => {
  stats.messages(msgs.length);
  if (settings.mode === RENDER_MODE.NAIVE) {
    const t0 = performance.now();
    for (const m of msgs) renderer.applyMessage(m, store.apply(m));
    stats.work(performance.now() - t0, msgs.length, false);
  } else {
    // Batch modlarda mesaj yalnız belleğe yazılır; harita bir sonraki flush'ta güncellenir.
    for (const m of msgs) store.apply(m);
  }
});

function resetUnits(): void {
  store.replaceAll(generator.reset(settings.count));
  if (deck.isActive) deck.activate();
  else renderer.loadAll();
  setSelected(null);
}

/** Mod değişince doğru çiziciyi aç, diğerini kapat. */
function applyMode(): void {
  const useDeck = settings.mode === RENDER_MODE.DECK;
  if (useDeck && !deck.isActive) {
    setUnitLayersVisible(map, false);
    deck.activate();
  } else if (!useDeck && deck.isActive) {
    deck.deactivate();
    setUnitLayersVisible(map, true);
    // deck.gl modundayken MapLibre kaynağı güncellenmedi → tam yeniden yükle
    store.drainChanges();
    renderer.loadAll();
  }
  setSelected(selectedId);
}

// ── Kare döngüsü: saniyede en fazla `applyHz` kez flush ──
let lastFlush = 0;
let lastInfo = 0;
function frame(now: number): void {
  if (settings.mode === RENDER_MODE.NAIVE) {
    renderer.discardPending();
  } else if (now - lastFlush >= 1000 / settings.applyHz - 1) {
    lastFlush = now;
    const t0 = performance.now();
    const sent = deck.isActive ? deck.flush(now) : renderer.flush(settings.mode);
    if (sent > 0) stats.work(performance.now() - t0, sent, true);
  }
  if (deck.isActive && deck.smooth) {
    // Akıcı hareket: her karede tüm birliklerin ara konumunu hesapla
    const t0 = performance.now();
    deck.animate(now);
    stats.work(performance.now() - t0, 0, false);
  }

  if (stats.frame(now)) renderStats();
  if (now - lastInfo > 200) {
    lastInfo = now;
    renderSelected();
  }
  requestAnimationFrame(frame);
}

// ── Hover & seçim: feature-state ile (veri güncellemesi yok) ──
let hoveredId: number | null = null;
let selectedId: number | null = null;

function setState(id: number | null, state: Record<string, boolean>): void {
  if (id !== null) map.setFeatureState({ source: UNITS_SOURCE, id }, state);
}

function topUnitAt(e: MapMouseEvent): number | null {
  if (deck.isActive) return deck.pick(e.point.x, e.point.y);
  const hits: MapGeoJSONFeature[] = map.queryRenderedFeatures(e.point, { layers: [UNITS_ICON_LAYER] });
  const id = hits[0]?.id;
  return typeof id === 'number' ? id : null;
}

function setSelected(id: number | null): void {
  setState(selectedId, { selected: false });
  selectedId = id;
  setState(selectedId, { selected: true });
  deck.setSelected(id);
  renderSelected();
}

let hoverQueued: MapMouseEvent | null = null;
map.on('mousemove', (e) => {
  // Fare olaylarını kare başına bire indir
  if (hoverQueued === null) {
    requestAnimationFrame(() => {
      const ev = hoverQueued!;
      hoverQueued = null;
      const id = topUnitAt(ev);
      if (id === hoveredId) return;
      setState(hoveredId, { hovered: false });
      hoveredId = id;
      setState(hoveredId, { hovered: true });
      map.getCanvas().style.cursor = id === null ? '' : 'pointer';
    });
  }
  hoverQueued = e;
});
map.on('click', (e) => setSelected(topUnitAt(e)));

// ── Panel ──
const panel = document.getElementById('panel')!;
panel.innerHTML = `
  <h1>Map Spike — canlı unsur testi</h1>
  <label>Birlik sayısı
    <select id="count">${[1000, 3000, 5000, 10000, 20000, 50000].map((n) => `<option value="${n}">${n.toLocaleString('tr-TR')}</option>`).join('')}</select>
  </label>
  <label>Mesaj / birlik / sn
    <select id="hz">${[0.5, 1, 2, 5].map((n) => `<option value="${n}">${n}</option>`).join('')}</select>
  </label>
  <label>Çizim modu
    <select id="mode">
      <option value="${RENDER_MODE.NAIVE}">1. Her mesajda çiz</option>
      <option value="${RENDER_MODE.BATCH_FULL}">2. Biriktir + hepsini gönder</option>
      <option value="${RENDER_MODE.BATCH_DIFF}">3. Biriktir + yalnız değişeni</option>
      <option value="${RENDER_MODE.DECK}">4. deck.gl (GPU dizileri)</option>
    </select>
  </label>
  <p class="hint" id="mode-hint"></p>
  <label id="smooth-row">Akıcı hareket (deck.gl) <input type="checkbox" id="smooth" /></label>
  <label>Haritaya uygulama (Hz)
    <select id="apply">${[2, 5, 10, 20, 30, 60].map((n) => `<option value="${n}">${n}</option>`).join('')}</select>
  </label>
  <label>İkon çakışma hesabı <input type="checkbox" id="collision" /></label>
  <label>Altlık (OSM) <input type="checkbox" id="basemap" /></label>
  <label>Akışı durdur <input type="checkbox" id="paused" /></label>
  <table id="stats"></table>
  <div class="selected" id="selected"></div>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const countEl = $<HTMLSelectElement>('count');
const hzEl = $<HTMLSelectElement>('hz');
const modeEl = $<HTMLSelectElement>('mode');
const applyEl = $<HTMLSelectElement>('apply');
const collisionEl = $<HTMLInputElement>('collision');
const basemapEl = $<HTMLInputElement>('basemap');
const pausedEl = $<HTMLInputElement>('paused');
const smoothEl = $<HTMLInputElement>('smooth');

countEl.value = String(settings.count);
hzEl.value = String(settings.perUnitHz);
modeEl.value = settings.mode;
applyEl.value = String(settings.applyHz);
collisionEl.checked = settings.collision;
basemapEl.checked = settings.basemap;
smoothEl.checked = settings.smooth;

const MODE_HINTS: Record<RenderMode, string> = {
  [RENDER_MODE.NAIVE]: 'Her mesaj anında haritaya tek tek gider. Haritaya uygulama Hz ayarı kullanılmaz.',
  [RENDER_MODE.BATCH_FULL]: 'Mesajlar biriktirilir; her flush’ta TÜM birlikler yeniden gönderilir.',
  [RENDER_MODE.BATCH_DIFF]: 'Mesajlar biriktirilir; her flush’ta yalnız değişen birlikler gönderilir (planın yolu).',
  [RENDER_MODE.DECK]:
    'Mesajlar biriktirilir; deck.gl konumları doğrudan GPU dizilerine yazar. Akıcı harekette birlikler iki konum arasında kayar (bir mesaj aralığı geriden gelir).',
};
const renderModeHint = (): void => {
  $('mode-hint').textContent = MODE_HINTS[settings.mode];
  $('smooth-row').style.display = settings.mode === RENDER_MODE.DECK ? '' : 'none';
};
renderModeHint();

countEl.onchange = () => {
  settings.count = Number(countEl.value);
  resetUnits();
};
hzEl.onchange = () => {
  settings.perUnitHz = generator.perUnitHz = Number(hzEl.value);
  deck.durationMs = 1000 / settings.perUnitHz;
};
modeEl.onchange = () => {
  settings.mode = modeEl.value as RenderMode;
  renderModeHint();
  applyMode();
};
smoothEl.onchange = () => {
  settings.smooth = deck.smooth = smoothEl.checked;
  if (deck.isActive) deck.activate(); // ara durumları temizle
};
applyEl.onchange = () => {
  settings.applyHz = Number(applyEl.value);
};
collisionEl.onchange = () => setIconCollision(map, (settings.collision = collisionEl.checked));
basemapEl.onchange = () => setBasemapVisible(map, (settings.basemap = basemapEl.checked));
pausedEl.onchange = () => {
  settings.paused = pausedEl.checked;
  if (settings.paused) generator.stop();
  else generator.start();
};

function grade(value: number, good: number, warn: number, higherIsBetter: boolean): string {
  if (higherIsBetter) return value >= good ? 'good' : value >= warn ? 'warn' : 'bad';
  return value <= good ? 'good' : value <= warn ? 'warn' : 'bad';
}

function renderStats(): void {
  const s = stats.snapshot;
  const fmt = (n: number, d = 0) => n.toLocaleString('tr-TR', { maximumFractionDigits: d, minimumFractionDigits: d });
  const rows: [string, string, string?][] = [
    ['FPS', fmt(s.fps), grade(s.fps, 50, 30, true)],
    ['En uzun kare', `${fmt(s.worstFrameMs)} ms`, grade(s.worstFrameMs, 34, 100, false)],
    ['Gelen mesaj / sn', fmt(s.msgsPerSec)],
    ['Haritaya flush / sn', fmt(s.flushesPerSec)],
    ['Gönderilen unsur / sn', fmt(s.sentPerSec)],
    ['Besleme işi (ms / sn)', fmt(s.mapWorkMsPerSec, 1), grade(s.mapWorkMsPerSec, 40, 150, false)],
    ['En uzun flush', `${fmt(s.maxFlushMs, 1)} ms`, grade(s.maxFlushMs, 4, 16, false)],
    ['Long task (>50 ms)', fmt(s.longTasks), grade(s.longTasks, 0, 2, false)],
  ];
  $('stats').innerHTML = rows
    .map(([k, v, cls]) => `<tr><td>${k}</td><td class="${cls ?? ''}">${v}</td></tr>`)
    .join('');
}

function renderSelected(): void {
  const el = $('selected');
  const u = selectedId === null ? undefined : store.get(selectedId);
  if (!u) {
    el.textContent = 'Seçmek için bir birliğe tıklayın.';
    return;
  }
  el.textContent = [
    `Birlik #${u.id}`,
    `Konum : ${u.lat.toFixed(5)}, ${u.lon.toFixed(5)}`,
    `Yön   : ${u.hdg.toFixed(0)}°`,
    `Durum : ${u.status}`,
    `Güncel: ${((performance.now() - u.updatedAt) / 1000).toFixed(1)} sn önce`,
  ].join('\n');
}

// ── Başlat ──
generator.perUnitHz = settings.perUnitHz;
deck.smooth = settings.smooth;
deck.durationMs = 1000 / settings.perUnitHz;
resetUnits();
applyMode();
generator.start();
requestAnimationFrame(frame);
