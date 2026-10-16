// react.html: @c2/map-react ile aynı boru hattı (Faz 1.4 tarayıcı doğrulaması).
//   - Altlıklar ve kontrol tedbirleri: bildirimsel bileşenler (<MapBasemap>, <MapLayer>, <Polygon>…)
//   - Canlı birlikler: React'ten GEÇMEZ; üreteç → createLayerStream → store (07-react-api.md#canlı-veri)
//   - Seçili birlik kartı: <MapOverlay> + useFeature (yalnız o birlik değişince render)
// URL: ?n=3000&motion=auto|on|off&cluster=1|0

import 'maplibre-gl/dist/maplibre-gl.css';
import '../style.css';
import './react.css';
import {
  createLayerStream,
  createMapStore,
  distance,
  formatCoordinate,
  formatDistance,
  GEOMETRY_KIND,
  parseCoordinate,
  toMgrs,
  MAP_EVENT,
  SELECT_MODE,
  STREAM_FORMAT,
  type DrawToolKind,
  type Feature,
  type FeatureLifecycle,
  type StreamItem,
} from '@c2/map-core';
import { clusterIconRenderer, createMaplibreAdapter, MOTION_MODE, uavRenderer, type DeckIcon, type MotionMode, type UavProps } from '@c2/map-maplibre';
import { startUavStream, UAV_LAYER, UAV_VIEW } from './uav-sim';
import {
  Circle,
  CompositeFeature,
  DRAW_TOOL_LABELS,
  DrawToolbar,
  Map,
  MapBasemap,
  MapContextMenu,
  MapLayer,
  MapOverlay,
  MapTooltip,
  type ContextMenuState,
  Polygon,
  Polyline,
  useBasemaps,
  useFeature,
  useFeatureActions,
  useFeaturePermissions,
  useLayerVisibility,
  useMap,
  useMapEdit,
  useMapEvent,
  useMapStore,
  useSelection,
} from '@c2/map-react';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BASEMAPS } from '../core/basemaps';
import { UnitGenerator, type UnitMessage } from '../generator';
import { buildSidc, ECHELONS, ENTITIES, SymbolCache } from '../symbology';
import { clusterColor, ClusterControls, unitClusterStage } from '../clustering';

const params = new URLSearchParams(location.search);
const COUNT = Number(params.get('n') ?? 3000);
const MOTION = (params.get('motion') ?? MOTION_MODE.AUTO) as MotionMode;
const UNITS = 'birlikler';
const DRAWINGS = 'cizimler';
const CLUSTER_DEFAULT = params.get('cluster') !== '0';

// ── Uygulama düzeyi nesneler (React dışında, bir kez) ────────────

const symbols = new SymbolCache();
const deckIcons = new globalThis.Map<string, DeckIcon>();
const sidcOf = (f: Feature) => (f.props as { sidc?: string } | undefined)?.sidc;

const adapter = createMaplibreAdapter({
  workerUrl,
  deckRenderers: {
    // Composite: tek unsurdan 3B model + sensör konisi + iz + etiket (deck/uav-renderer.ts)
    uav: uavRenderer({ modelUrl: `${import.meta.env.BASE_URL}models/predator.glb`, modelScale: 8, minPixels: 46 }),
    // Kümeler (ClusterStage): birliklerle aynı ikon katmanında, kimlik renginde rozet
    cluster: clusterIconRenderer({ color: clusterColor }),
    milsym: {
      icon: (f) => {
        const sidc = sidcOf(f);
        if (!sidc) return undefined;
        let icon = deckIcons.get(sidc);
        if (!icon) {
          const img = symbols.get(sidc);
          icon = { id: sidc, url: symbols.dataUrl(sidc), width: img.canvas.width, height: img.canvas.height };
          deckIcons.set(sidc, icon);
        }
        return icon;
      },
      size: (f) => symbols.get(sidcOf(f)!).height,
    },
  },
  motion: MOTION,
});

const store = createMapStore();
(window as unknown as Record<string, unknown>).c2Store = store;
(window as unknown as Record<string, unknown>).c2Adapter = adapter;
const clusterStage = unitClusterStage(UNITS);
(window as unknown as Record<string, unknown>).c2Cluster = clusterStage;

// ── Canlı akış (React dışı) ──────────────────────────────────────

let entityOf: number[] = [];
let echelonOf: number[] = [];
let identityOf: number[] = [];
const unitFeature = (m: UnitMessage): StreamItem => ({
  id: `u${m.id}`,
  kind: 'milsym',
  geometry: { kind: GEOMETRY_KIND.POINT, coord: [m.lon, m.lat] },
  props: { sidc: buildSidc(identityOf[m.id] ?? 0, entityOf[m.id] ?? 0, echelonOf[m.id] ?? 0) },
  meta: { hdg: m.hdg, birim: `${ENTITIES[entityOf[m.id] ?? 0]?.name} ${ECHELONS[echelonOf[m.id] ?? 0]?.name}` },
});
const stream = createLayerStream<UnitMessage>(store, {
  layerId: UNITS,
  format: STREAM_FORMAT.FULL,
  normalize: (m) => {
    if (m.identity !== undefined) identityOf[m.id] = m.identity;
    return unitFeature(m);
  },
});
const generator = new UnitGenerator((msgs) => stream.update(msgs));

function startStream(): () => void {
  const snapshot = generator.reset(COUNT);
  entityOf = snapshot.map((m) => m.entity ?? 0);
  echelonOf = snapshot.map((m) => m.echelon ?? 0);
  identityOf = snapshot.map((m) => m.identity ?? 0);
  store.transaction((tx) =>
    tx.replaceLayerContents(UNITS, snapshot.map((m) => ({ ...(unitFeature(m) as Feature), layerId: UNITS }))),
  );
  generator.start();
  return () => generator.stop();
}

// ── Sahte backend (yaşam döngüsü kancaları) ──────────────────────
// Gerçek uygulamada burada HTTP istekleri olur; hata / zaman aşımı uygulamanın.

const DRAWING_STYLE = { fillColor: '#4dd0e1', fillOpacity: 0.2, strokeColor: '#4dd0e1', strokeWidth: 2, pointColor: '#4dd0e1' };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let serverSeq = 0;

/** İşlem sonucu panelde görünsün (spike'a özel küçük olay). */
const report = (text: string) => window.dispatchEvent(new CustomEvent('c2-action', { detail: text }));

const lifecycle: FeatureLifecycle = {
  // Çizim: backend'e kaydet, kalıcı id + rev dön.
  async beforeCreate(feature) {
    report(`${feature.meta?.tool ?? 'unsur'} kaydediliyor…`);
    await wait(400);
    const saved = { ...feature, id: `srv-${++serverSeq}`, rev: 1 };
    report(`${saved.id} kaydedildi`);
    return saved;
  },
  // Düzenleme: `next.rev` düzenlemeye başlanan sürüm, `prev` güncel hâl → çakışmaya backend karar verir.
  async beforeUpdate(next, prev) {
    report(`${next.id} kaydediliyor…`);
    await wait(400);
    const saved = { ...next, rev: (prev.rev ?? 0) + 1 };
    report(`${next.id} kaydedildi (rev ${saved.rev})`);
    return saved;
  },
  // Silme: backend'de yetki + silme; onay gelince haritadan kalkar.
  async beforeDelete(feature) {
    report(`${feature.id} siliniyor…`);
    await wait(800);
    if (feature.id === 'hedef-bolge') {
      report(`${feature.id}: backend reddetti (yetki yok)`);
      return false;
    }
    report(`${feature.id} silindi`);
    return true;
  },
};

// ── Bileşenler ───────────────────────────────────────────────────

function useRenderCount(): number {
  const count = useRef(0);
  count.current++;
  return count.current;
}

function UnitCard({ id }: { id: string }) {
  const unit = useFeature(id);
  const renders = useRenderCount();
  if (!unit || unit.geometry.kind !== GEOMETRY_KIND.POINT) return null;
  const [lon, lat] = unit.geometry.coord;
  return (
    <div className="unit-card">
      <b>{id}</b> — {String(unit.meta?.birim)}
      <div>
        {lat.toFixed(4)}, {lon.toFixed(4)} · yön {Math.round(Number(unit.meta?.hdg))}°
      </div>
      <small>kart render: {renders}</small>
    </div>
  );
}

function UavTooltip({ id }: { id: string }) {
  const p = useFeature(id, (f) => f?.props as UavProps | undefined);
  if (!p) return null;
  return (
    <>
      <b>{p.callsign ?? id}</b> · {Math.round(p.altitudeM)} m · burun {Math.round(p.headingDeg)}°
      {p.sensor && (
        <>
          {' '}
          · kamera pan {Math.round(p.sensor.panDeg)}° / eğim {Math.round(p.sensor.tiltDeg)}°
        </>
      )}
    </>
  );
}

function UnitTooltip({ id }: { id: string }) {
  const birim = useFeature(id, (f) => String(f?.meta?.birim ?? ''));
  return (
    <>
      <b>{id}</b> {birim}
    </>
  );
}

function ContextMenu({ featureId, coord, close }: ContextMenuState) {
  const map = useMap();
  const { select } = useSelection();
  const actions = useFeatureActions();
  // "Sil" izinden gelir: birlikler katmanı deletable={false}; çizimler ve kontrol tedbirleri açık.
  const { canDelete, canEdit, pending } = useFeaturePermissions(featureId ?? '');
  const edit = useMapEdit();
  const drawingTool = useFeature(featureId ?? '', (f) => (f?.layerId === DRAWINGS ? String(f.meta?.tool ?? '') : null));
  const run = (action: () => void) => () => {
    action();
    close();
  };
  return (
    <>
      <div className="context-title">{featureId ? (drawingTool ? `Çizim: ${DRAW_TOOL_LABELS[drawingTool as DrawToolKind] ?? drawingTool}` : featureId) : 'Harita'}</div>
      {featureId ? (
        <>
          {drawingTool === null && <button onClick={run(() => select(featureId, SELECT_MODE.ADD))}>Seçime ekle</button>}
          <button onClick={run(() => coord && map.flyTo({ center: coord, zoom: 10 }))}>Merkeze al</button>
          {canEdit && !pending && <button onClick={run(() => edit.start(featureId))}>Düzenle</button>}
          {canDelete && (
            <button className="danger" disabled={pending} onClick={run(() => void actions.delete(featureId))}>
              {pending ? 'Siliniyor…' : 'Sil'}
            </button>
          )}
        </>
      ) : (
        <button onClick={run(() => coord && map.flyTo({ center: coord }))}>Buraya git</button>
      )}
    </>
  );
}

function SelectedOverlay() {
  const { selected } = useSelection();
  const id = selected.size === 1 ? [...selected][0] : undefined; // çoklu seçimde kart yok
  const coord = useFeature(id ?? '', (f) => (f?.geometry.kind === GEOMETRY_KIND.POINT ? f.geometry.coord : undefined));
  if (!id) return null;
  return (
    <MapOverlay anchor={coord} align="bottom" offset={[0, -24]}>
      <UnitCard id={id} />
    </MapOverlay>
  );
}

function LayerToggle({ id, label }: { id: string; label: string }) {
  const [visible, setVisible] = useLayerVisibility(id);
  return (
    <label>
      {label}
      <input type="checkbox" checked={visible ?? false} onChange={(e) => setVisible(e.target.checked)} />
    </label>
  );
}

function BasemapPicker() {
  const store = useMapStore();
  const basemaps = useBasemaps().filter((b) => b.exclusiveGroup);
  const current = basemaps.find((b) => b.visible)?.id ?? '';
  return (
    <label>
      Altlık
      <select
        value={current}
        onChange={(e) => store.transaction((tx) => tx.patchBasemap(e.target.value, { visible: true }))}
      >
        {basemaps.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Fare altındaki koordinat (MGRS + DMS) — React render'ı yok, DOM'a doğrudan. */
function PointerCoordinate() {
  const el = useRef<HTMLTableCellElement>(null);
  useMapEvent(MAP_EVENT.POINTER_MOVE, (e) => {
    if (!e.coord || !el.current) return;
    el.current.textContent = `${toMgrs(e.coord)}\n${formatCoordinate(e.coord, { hemispheres: 'tr' })}`;
  });
  return <td ref={el} className="coord" />;
}

function GoTo() {
  const map = useMap();
  const [message, setMessage] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const coord = parseCoordinate(new FormData(e.currentTarget).get('q') as string);
        if (!coord) return setMessage('tanınmadı');
        setMessage(`Ankara'ya ${formatDistance(distance([32.85, 39.9], coord))}`);
        map.flyTo({ center: coord, zoom: 12 });
      }}
    >
      <input name="q" placeholder="MGRS / UTM / DMS / DD" />
      <button>Git</button> <small className="goto-message">{message}</small>
    </form>
  );
}

function SelectionCount() {
  return <>{useSelection().selected.size}</>;
}

type PanelProps = { gozcuPan: number; onGozcuPan: (pan: number) => void; clustering: boolean; onClustering: (on: boolean) => void };

function Panel({ gozcuPan, onGozcuPan, clustering, onClustering }: PanelProps) {
  const map = useMap();
  const renders = useRenderCount();
  const [fps, setFps] = useState(0);
  const [lastClick, setLastClick] = useState('—');
  const [lastAction, setLastAction] = useState('—');
  useEffect(() => {
    const on = (e: Event) => setLastAction((e as CustomEvent<string>).detail);
    window.addEventListener('c2-action', on);
    return () => window.removeEventListener('c2-action', on);
  }, []);
  useMapEvent(MAP_EVENT.CLICK, (e) => setLastClick(e.featureId ?? 'boş'));

  useEffect(() => {
    let frames = 0;
    let start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      frames++;
      if (now - start >= 1000) {
        setFps(Math.round((frames * 1000) / (now - start)));
        frames = 0;
        start = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <aside id="panel">
      <h1>React testi — @c2/map-react</h1>
      <p className="hint attribution">
        İHA modeli: "Predator Drone" — sftwr314r8, <a href="https://poly.pizza/m/3Eio09miiAF">Poly Pizza</a>,{' '}
        <a href="https://creativecommons.org/licenses/by/3.0/">CC BY 3.0</a>
      </p>
      <p className="hint">
        {COUNT.toLocaleString('tr-TR')} birlik, 1 Hz · <a href="./core.html">çekirdek sayfası</a>
      </p>
      <BasemapPicker />
      <LayerToggle id="harekat" label="Harekât (kontrol tedbirleri)" />
      <LayerToggle id={UNITS} label="Birlikler" />
      <ClusterControls stage={clusterStage} enabled={clustering} onToggle={onClustering} />
      <button onClick={() => map.flyTo({ center: [32.85, 39.9], zoom: 9, pitchDeg: 0, bearingDeg: 0 })}>Ankara'ya uç</button>{' '}
      <button onClick={() => map.flyTo(UAV_VIEW)}>İHA'lara git (3B)</button>
      <GoTo />
      <label>
        GÖZCÜ kamera (JSX) {gozcuPan}°
        <input type="range" min={-180} max={180} value={gozcuPan} onChange={(e) => onGozcuPan(Number(e.target.value))} />
      </label>
      <table>
        <tbody>
          <tr><td>FPS (sayfa)</td><td>{fps}</td></tr>
          <tr><td>Panel render</td><td>{renders}</td></tr>
          <tr><td>Son tıklama</td><td>{lastClick}</td></tr>
          <tr><td>Son işlem</td><td className="action-log">{lastAction}</td></tr>
          <tr><td>Seçili</td><td><SelectionCount /></td></tr>
          <tr><td>İmleç</td><PointerCoordinate /></tr>
        </tbody>
      </table>
    </aside>
  );
}

function App() {
  useEffect(startStream, []);
  useEffect(() => startUavStream(store, 5), []);
  const [gozcuPan, setGozcuPan] = useState(0);
  const [clustering, setClustering] = useState(CLUSTER_DEFAULT);
  const stages = useMemo(() => (clustering ? [clusterStage] : []), [clustering]);
  return (
    <Map adapter={adapter} store={store} lifecycle={lifecycle} stages={stages} initialView={{ center: [32.85, 39.9], zoom: 6.5 }} style={{ position: 'absolute', inset: 0 }}>
      {BASEMAPS.map((b) => (
        <MapBasemap key={b.id} {...b} />
      ))}

      <MapLayer id="harekat" name="Harekât" renderGroup>
        <MapLayer id="kontrol" name="Kontrol tedbirleri">
          <Polygon
            id="fh-altin"
            rings={[[[32.2, 39.6], [33.4, 39.6], [33.4, 40.3], [32.2, 40.3], [32.2, 39.6]]]}
            style={{ fillColor: '#ffcc00', fillOpacity: 0.12, strokeColor: '#ffcc00' }}
          />
          <Polyline id="sinir-hatti" coords={[[31.5, 39.2], [33, 39.4], [34.5, 39.1]]} style={{ strokeColor: '#ff4d4d', strokeWidth: 3 }} />
          <Circle id="hedef-bolge" center={[32.85, 39.93]} radiusM={15000} style={{ fillColor: '#ff4d4d', fillOpacity: 0.15 }} />
        </MapLayer>
      </MapLayer>

      {/* Kullanıcı çizimleri: araç çubuğundan gelen geometri store'a (uygulamanın kararı) */}
      <MapLayer id={DRAWINGS} name="Çizimler" />
      <DrawToolbar layerId={DRAWINGS} featureStyle={DRAWING_STYLE} />

      {/* Canlı birlikler: içi boş katman; unsurlar akıştan store'a */}
      <MapLayer id={UNITS} name="Birlikler" renderGroup editable={false} deletable={false} />
      {/* İHA'lar: composite kind 'uav', backend akışından (uav-sim.ts); birliklerin üstünde */}
      <MapLayer id={UAV_LAYER} name="İHA'lar" renderGroup editable={false} deletable={false} />
      {/* Bildirimsel composite: aynı 'uav' kind'ı, React state'inden (kaydırıcı) */}
      <MapLayer id="gozlem" name="Gözlem" renderGroup editable={false} deletable={false}>
        <CompositeFeature<UavProps>
          id="gozcu-1"
          kind="uav"
          position={[32.85, 39.93]}
          props={{
            callsign: 'GÖZCÜ (JSX)',
            headingDeg: 45,
            altitudeM: 3500,
            sensor: { panDeg: gozcuPan, tiltDeg: 50, hfovDeg: 25, vfovDeg: 16, maxRangeM: 20_000 },
          }}
        />
      </MapLayer>
      <MapTooltip layerId={UAV_LAYER} className="unit-tooltip">
        {(id) => <UavTooltip id={id} />}
      </MapTooltip>

      <SelectedOverlay />
      <MapTooltip layerId={UNITS} className="unit-tooltip">
        {(id) => <UnitTooltip id={id} />}
      </MapTooltip>
      <MapContextMenu className="context-menu">{(menu) => <ContextMenu {...menu} />}</MapContextMenu>
      <Panel gozcuPan={gozcuPan} onGozcuPan={setGozcuPan} clustering={clustering} onClustering={setClustering} />
    </Map>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
