// cesium.html: aynı çekirdek + aynı React binding, motor Cesium (3B küre, arazi, uydu görüntüsü).
//   - react sayfasıyla AYNI uygulama kodu: <Map>, <MapLayer>, <Polygon>, <DrawToolbar>, hook'lar …
//     Değişen tek şey adapter: createCesiumAdapter (Faz 5 hedefi: "aynı uygulama kodu, 3B motor").
//   - Cesium ion YOK: arazi Terrarium (AWS Open Data), görüntü Esri World Imagery (XYZ altlık).
//   - Rastgele birlikler (sayı / hız ayarlanabilir) ve İHA'lar (irtifa MSL, sayı ayarlanabilir).
// URL: ?n=2000&hz=1&uav=6&uavhz=5&q=balanced|high|fast&cluster=1|0

import 'cesium/Build/Cesium/Widgets/CesiumWidget/CesiumWidget.css';
import '../style.css';
import '../react/react.css';
import './cesium.css';
import {
  BASEMAP_SOURCE,
  createLayerStream,
  createMapStore,
  formatCoordinate,
  GEOMETRY_KIND,
  MAP_EVENT,
  SELECT_MODE,
  STREAM_FORMAT,
  toMgrs,
  type Basemap,
  type DrawToolKind,
  type Feature,
  type StreamItem,
  type UavProps,
} from '@c2/map-core';
import {
  billboardRenderer,
  cesiumClusterRenderer,
  cesiumUavRenderer,
  createCesiumAdapter,
  RENDER_QUALITY,
  vectorRenderer,
  type RenderQuality,
} from '@c2/map-cesium';
import { Cartographic } from 'cesium';
import {
  Circle,
  DRAW_TOOL_LABELS,
  DrawToolbar,
  Map,
  MapBasemap,
  MapContextMenu,
  MapLayer,
  MapTooltip,
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
  useMapReady,
  useMapStore,
  useSelection,
  type ContextMenuState,
} from '@c2/map-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { UnitGenerator, type UnitMessage } from '../generator';
import { buildSidc, ECHELONS, ENTITIES, SymbolCache } from '../symbology';
import { clusterColor, ClusterControls, unitClusterStage } from '../clustering';
import { startUavFeed, UAV_LAYER, UAV_VIEW } from './uav-feed';

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => (params.has(key) ? Number(params.get(key)) : fallback);
const INITIAL = { units: num('n', 2000), unitHz: num('hz', 1), uavs: num('uav', 6), uavHz: num('uavhz', 5) };

const QUALITY = (Object.values(RENDER_QUALITY) as string[]).includes(params.get('q') ?? '')
  ? (params.get('q') as RenderQuality)
  : RENDER_QUALITY.BALANCED;

const UNITS = 'birlikler';
const DRAWINGS = 'cizimler';
const CLUSTER_DEFAULT = params.get('cluster') !== '0';
const ANKARA = { center: [32.85, 39.9] as [number, number], zoom: 7.2, pitchDeg: 45, bearingDeg: 0 };

// ── Altlıklar: hepsi ücretsiz, anahtarsız ────────────────────────

const group = { exclusiveGroup: 'altlik', order: 0, opacity: 1 } as const;
const BASEMAPS: Basemap[] = [
  {
    id: 'uydu',
    name: 'Uydu — Esri World Imagery',
    source: {
      type: BASEMAP_SOURCE.XYZ,
      urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 19,
    },
    attribution: 'Görüntü © Esri, Maxar, Earthstar Geographics',
    visible: true,
    ...group,
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 },
    attribution: '© OpenStreetMap katkıcıları',
    visible: false,
    ...group,
  },
  {
    id: 'topo',
    name: 'OpenTopoMap',
    source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', maxZoom: 17 },
    attribution: '© OpenStreetMap katkıcıları, SRTM | © OpenTopoMap (CC-BY-SA)',
    visible: false,
    ...group,
  },
  {
    id: 'etiketler',
    name: 'Sınırlar ve yer adları',
    source: {
      type: BASEMAP_SOURCE.XYZ,
      urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 19,
    },
    attribution: '© Esri',
    visible: true,
    opacity: 0.9,
    order: 10, // altlıkların üstünde
  },
];

// ── Uygulama düzeyi nesneler (React dışında, bir kez) ────────────

const symbols = new SymbolCache();
const sidcOf = (f: Feature) => (f.props as { sidc?: string } | undefined)?.sidc;

const adapter = createCesiumAdapter({
  baseUrl: `${import.meta.env.BASE_URL}cesium/`,
  quality: QUALITY,
  renderers: {
    vector: vectorRenderer,
    // Birlikler: sembol görüntüsü SIDC başına bir kez (SymbolCache), billboard'lar onu paylaşır
    milsym: billboardRenderer({
      image: (f) => {
        const sidc = sidcOf(f);
        if (!sidc) return undefined;
        const img = symbols.get(sidc);
        return { key: sidc, image: img.canvas, width: img.width, height: img.height };
      },
    }),
    // Kümeler (ClusterStage): kimlik renginde rozet billboard'u
    cluster: cesiumClusterRenderer({ color: clusterColor }),
    // Composite İHA: glTF + sensör konisi + iz (aynı model dosyası, aynı props)
    uav: cesiumUavRenderer({ modelUrl: `${import.meta.env.BASE_URL}models/predator.glb`, modelScale: 8, minPixels: 48 }),
  },
});

// Tarayıcı testleri / konsol için (motora kaçış kapısı)
(window as unknown as { c2Adapter: typeof adapter }).c2Adapter = adapter;

const store = createMapStore();
const clusterStage = unitClusterStage(UNITS);
(window as unknown as Record<string, unknown>).c2Cluster = clusterStage;
(window as unknown as { c2Store: typeof store }).c2Store = store;

// ── Canlı birlik akışı (React dışı) ──────────────────────────────

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

function startUnits(count: number, hz: number): () => void {
  generator.perUnitHz = hz;
  const snapshot = generator.reset(count);
  entityOf = snapshot.map((m) => m.entity ?? 0);
  echelonOf = snapshot.map((m) => m.echelon ?? 0);
  identityOf = snapshot.map((m) => m.identity ?? 0);
  store.transaction((tx) =>
    tx.replaceLayerContents(UNITS, snapshot.map((m) => ({ ...(unitFeature(m) as Feature), layerId: UNITS }))),
  );
  generator.start();
  return () => generator.stop();
}

// ── Bileşenler ───────────────────────────────────────────────────

function UavTooltip({ id }: { id: string }) {
  const p = useFeature(id, (f) => f?.props as UavProps | undefined);
  if (!p) return null;
  return (
    <>
      <b>{p.callsign ?? id}</b> · irtifa {Math.round(p.altitudeM)} m (MSL) · burun {Math.round(p.headingDeg)}°
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
  const { canDelete, canEdit, pending } = useFeaturePermissions(featureId ?? '');
  const edit = useMapEdit();
  const drawingTool = useFeature(featureId ?? '', (f) => (f?.layerId === DRAWINGS ? String(f.meta?.tool ?? '') : null));
  const run = (action: () => void) => () => {
    action();
    close();
  };
  return (
    <>
      <div className="context-title">
        {featureId ? (drawingTool ? `Çizim: ${DRAW_TOOL_LABELS[drawingTool as DrawToolKind] ?? drawingTool}` : featureId) : 'Harita'}
      </div>
      {featureId ? (
        <>
          {drawingTool === null && <button onClick={run(() => select(featureId, SELECT_MODE.ADD))}>Seçime ekle</button>}
          <button onClick={run(() => coord && map.flyTo({ center: coord, zoom: 11, pitchDeg: 55 }))}>Yakından bak</button>
          {canEdit && !pending && <button onClick={run(() => edit.start(featureId))}>Düzenle</button>}
          {canDelete && (
            <button className="danger" disabled={pending} onClick={run(() => void actions.delete(featureId))}>
              Sil
            </button>
          )}
        </>
      ) : (
        <button onClick={run(() => coord && map.flyTo({ center: coord }))}>Buraya git</button>
      )}
    </>
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

function BasemapControls() {
  const store = useMapStore();
  const basemaps = useBasemaps();
  const exclusive = basemaps.filter((b) => b.exclusiveGroup);
  const labels = basemaps.find((b) => b.id === 'etiketler');
  return (
    <>
      <label>
        Altlık
        <select
          value={exclusive.find((b) => b.visible)?.id ?? ''}
          onChange={(e) => store.transaction((tx) => tx.patchBasemap(e.target.value, { visible: true }))}
        >
          {exclusive.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      {labels && (
        <label>
          Sınırlar / yer adları
          <input
            type="checkbox"
            checked={labels.visible}
            onChange={(e) => store.transaction((tx) => tx.patchBasemap(labels.id, { visible: e.target.checked }))}
          />
        </label>
      )}
    </>
  );
}

/** Arazi yükseklik abartısı (motora özel: kaçış kapısı `getEngine`). */
function TerrainExaggeration() {
  const ready = useMapReady();
  const [value, setValue] = useState(1);
  useEffect(() => {
    if (ready) adapter.getEngine().scene.verticalExaggeration = value;
  }, [ready, value]);
  return (
    <label>
      Arazi abartısı ×{value.toFixed(1)}
      <input type="range" min={1} max={4} step={0.5} value={value} onChange={(e) => setValue(Number(e.target.value))} />
    </label>
  );
}

/** Görüntü kalitesi ↔ kare hızı (entegre GPU'da MSAA / atmosfer / sis pahalı). */
function QualityPicker() {
  const [quality, setQuality] = useState<RenderQuality>(QUALITY);
  const ready = useMapReady();
  useEffect(() => {
    if (ready) adapter.setQuality(quality);
  }, [ready, quality]);
  const labels: Record<RenderQuality, string> = { high: 'Yüksek (MSAA, atmosfer, sis)', balanced: 'Dengeli', fast: 'Hızlı' };
  return (
    <label>
      Görüntü
      <select value={quality} onChange={(e) => setQuality(e.target.value as RenderQuality)}>
        {Object.values(RENDER_QUALITY).map((q) => (
          <option key={q} value={q}>
            {labels[q]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Fare altındaki koordinat (MGRS + DMS) + arazi yüksekliği — React render'ı yok, DOM'a doğrudan. */
function PointerCoordinate() {
  const el = useRef<HTMLTableCellElement>(null);
  useMapEvent(MAP_EVENT.POINTER_MOVE, (e) => {
    if (!e.coord || !el.current) return;
    const scene = adapter.getEngine().scene;
    const h = scene.globe.getHeight(Cartographic.fromDegrees(e.coord[0], e.coord[1]));
    el.current.textContent = `${toMgrs(e.coord)}\n${formatCoordinate(e.coord, { hemispheres: 'tr' })}${h !== undefined ? `\nyükseklik ≈ ${Math.round(h)} m` : ''}`;
  });
  return <td ref={el} className="coord" />;
}

type Settings = typeof INITIAL;

type PanelProps = { settings: Settings; onApply: (s: Settings) => void; clustering: boolean; onClustering: (on: boolean) => void };

function Panel({ settings, onApply, clustering, onClustering }: PanelProps) {
  const map = useMap();
  const [draft, setDraft] = useState(settings);
  const [fps, setFps] = useState(0);
  const [lastClick, setLastClick] = useState('—');
  const { selected } = useSelection();
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

  const field = (key: keyof Settings, label: string, min: number, max: number, step = 1) => (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
      />
    </label>
  );
  const changed = JSON.stringify(draft) !== JSON.stringify(settings);

  return (
    <aside id="panel">
      <h1>3B test — @c2/map-cesium</h1>
      <p className="hint">
        Aynı çekirdek ve React bileşenleri; motor Cesium. Ion yok: arazi Terrarium (AWS), görüntü Esri ·{' '}
        <a href="./react.html">2B sayfa</a>
      </p>
      <p className="hint attribution">
        İHA modeli: "Predator Drone" — sftwr314r8, <a href="https://poly.pizza/m/3Eio09miiAF">Poly Pizza</a>,{' '}
        <a href="https://creativecommons.org/licenses/by/3.0/">CC BY 3.0</a>
      </p>
      <BasemapControls />
      <TerrainExaggeration />
      <QualityPicker />
      <LayerToggle id="harekat" label="Kontrol tedbirleri" />
      <LayerToggle id={UNITS} label="Birlikler" />
      <ClusterControls stage={clusterStage} enabled={clustering} onToggle={onClustering} />
      <LayerToggle id={UAV_LAYER} label="İHA'lar" />
      <fieldset>
        <legend>Simülasyon</legend>
        {field('units', 'Birlik sayısı', 0, 20000, 500)}
        {field('unitHz', 'Birlik mesajı (Hz)', 0.2, 5, 0.2)}
        {field('uavs', 'İHA sayısı', 0, 30)}
        {field('uavHz', 'İHA mesajı (Hz)', 1, 20)}
        <button disabled={!changed} onClick={() => onApply(draft)}>
          Uygula
        </button>
      </fieldset>
      <button onClick={() => map.flyTo(ANKARA)}>Ankara'ya uç</button>{' '}
      <button onClick={() => map.flyTo(UAV_VIEW)}>İHA'lara git</button>{' '}
      <button onClick={() => map.flyTo({ center: map.getView().center, pitchDeg: 0, bearingDeg: 0 })}>Tepeden</button>
      <table>
        <tbody>
          <tr><td>FPS (sayfa)</td><td>{fps}</td></tr>
          <tr><td>Birlik / İHA</td><td>{settings.units.toLocaleString('tr-TR')} / {settings.uavs}</td></tr>
          <tr><td>Son tıklama</td><td>{lastClick}</td></tr>
          <tr><td>Seçili</td><td>{selected.size}</td></tr>
          <tr><td>İmleç</td><PointerCoordinate /></tr>
        </tbody>
      </table>
    </aside>
  );
}

const DRAWING_STYLE = { fillColor: '#4dd0e1', fillOpacity: 0.25, strokeColor: '#4dd0e1', strokeWidth: 3, pointColor: '#4dd0e1' };

function App() {
  const [settings, setSettings] = useState(INITIAL);
  const [clustering, setClustering] = useState(CLUSTER_DEFAULT);
  const stages = useMemo(() => (clustering ? [clusterStage] : []), [clustering]);
  useEffect(() => startUnits(settings.units, settings.unitHz), [settings.units, settings.unitHz]);
  useEffect(() => startUavFeed(store, { count: settings.uavs, hz: settings.uavHz }), [settings.uavs, settings.uavHz]);
  return (
    <Map adapter={adapter} store={store} stages={stages} initialView={ANKARA} style={{ position: 'absolute', inset: 0 }}>
      {BASEMAPS.map((b) => (
        <MapBasemap key={b.id} {...b} />
      ))}

      <MapLayer id="harekat" name="Harekât" renderGroup>
        <Polygon
          id="fh-altin"
          rings={[[[32.2, 39.6], [33.4, 39.6], [33.4, 40.3], [32.2, 40.3], [32.2, 39.6]]]}
          style={{ fillColor: '#ffcc00', fillOpacity: 0.12, strokeColor: '#ffcc00' }}
        />
        <Polyline id="sinir-hatti" coords={[[31.5, 39.2], [33, 39.4], [34.5, 39.1]]} style={{ strokeColor: '#ff4d4d', strokeWidth: 3 }} />
        <Circle id="hedef-bolge" center={[32.85, 39.93]} radiusM={15000} style={{ fillColor: '#ff4d4d', fillOpacity: 0.15, strokeColor: '#ff4d4d' }} />
      </MapLayer>

      <MapLayer id={DRAWINGS} name="Çizimler" />
      <DrawToolbar layerId={DRAWINGS} featureStyle={DRAWING_STYLE} />

      <MapLayer id={UNITS} name="Birlikler" renderGroup editable={false} deletable={false} />
      <MapLayer id={UAV_LAYER} name="İHA'lar" renderGroup editable={false} deletable={false} />

      <MapTooltip layerId={UAV_LAYER} className="unit-tooltip">
        {(id) => <UavTooltip id={id} />}
      </MapTooltip>
      <MapTooltip layerId={UNITS} className="unit-tooltip">
        {(id) => <UnitTooltip id={id} />}
      </MapTooltip>
      <MapContextMenu className="context-menu">{(menu) => <ContextMenu {...menu} />}</MapContextMenu>
      <Panel settings={settings} onApply={setSettings} clustering={clustering} onClustering={setClustering} />
    </Map>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
