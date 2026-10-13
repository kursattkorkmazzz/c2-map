// ── Çekirdek performans ölçümü (Faz 1.5.3'ün tarayıcısız kısmı) ──
// Çalıştırma:  pnpm --filter @c2/map-core bench
//
// Store ve MapSync'in 50k unsurdaki maliyetini ölçer. Adapter "hiçbir şey yapmayan" bir
// sahte adapter'dır: ölçülen yalnız çekirdektir (motor maliyeti Faz 1.5'te tarayıcıda ölçülür).
// Her senaryoda kurulum (ör. bekleyen değişiklikleri hazırlamak) ölçüme DAHİL DEĞİLDİR.

import {
  createManualScheduler,
  createMapStore,
  GEOMETRY_KIND,
  MapSync,
  type Feature,
  type FeaturePatch,
  type Layer,
  type MapStore,
  type RenderBatch,
} from "../src/index";

// ── Ayarlar ──────────────────────────────────────────────────────

const UNITS = 50_000;
const GROUPS = 5; // 5 alt katman × 10k unsur
const APPLY_HZ = 10; // MapSync haritaya saniyede en fazla 10 kez uygular
const PACKETS_PER_SEC = 20; // WS: saniyede 20 paket (her biri 2.500 mesaj)

// ── Ölçüm altyapısı ──────────────────────────────────────────────

type Result = { name: string; median: number; p95: number; budget?: number; note?: string };
const results: Result[] = [];

function measure(
  name: string,
  options: { iterations?: number; warmup?: number; budget?: number; note?: string },
  setup: () => void,
  run: () => void,
): void {
  const iterations = options.iterations ?? 30;
  const warmup = options.warmup ?? 5;
  const times: number[] = [];
  for (let i = 0; i < warmup + iterations; i++) {
    setup();
    const t0 = performance.now();
    run();
    const elapsed = performance.now() - t0;
    if (i >= warmup) times.push(elapsed);
  }
  times.sort((a, b) => a - b);
  const pick = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!;
  results.push({ name, median: pick(0.5), p95: pick(0.95), budget: options.budget, note: options.note });
}

// ── Veri üretimi ─────────────────────────────────────────────────

const layer = (id: string, parentId: string | null, over: Partial<Layer> = {}): Layer => ({
  id,
  name: id,
  parentId,
  visible: true,
  opacity: 1,
  ...over,
});

const groupOf = (i: number) => `birlikler-${i % GROUPS}`;
const unitId = (i: number) => `u${i}`;
let tick = 0; // her ölçümde farklı koordinat → değişiklik garanti
const point = (i: number) => ({ kind: GEOMETRY_KIND.POINT, coord: [32 + (i % 1000) / 1000, 39 + tick / 1e6] }) as const;

function unit(i: number): Feature {
  return {
    id: unitId(i),
    layerId: groupOf(i),
    kind: "milsym",
    geometry: point(i),
    props: { sidc: `1003100016${String(i % 12).padStart(4, "0")}000000` },
    meta: { yakit: 100 },
  };
}

function seededStore(): MapStore {
  const store = createMapStore();
  store.transaction((tx) => {
    tx.upsertLayers([
      layer("harekat", null, { renderGroup: true }),
      ...Array.from({ length: GROUPS }, (_, g) => layer(`birlikler-${g}`, "harekat")),
      layer("kontrol", null),
    ]);
    tx.upsertFeatures(Array.from({ length: UNITS }, (_, i) => unit(i)));
  });
  store.drainChanges();
  return store;
}

/** `count` birliğin konumunu değiştiren patch'ler (1 Hz akışın bir dilimi). */
function positionPatches(count: number, offset = 0): FeaturePatch[] {
  tick++;
  return Array.from({ length: count }, (_, k) => {
    const i = (offset + k) % UNITS;
    return { id: unitId(i), geometry: point(i) };
  });
}

/** Hiçbir şey çizmeyen adapter: son batch'in boyutunu tutar (doğrulama için). */
function nullAdapter() {
  const stats = { upserts: 0, removes: 0, states: 0 };
  return {
    stats,
    applyBatch(batch: RenderBatch) {
      stats.upserts = batch.features?.upsert.length ?? 0;
      stats.removes = batch.features?.remove.length ?? 0;
      stats.states = batch.state?.length ?? 0;
    },
  };
}

function startedSync(store: MapStore) {
  const adapter = nullAdapter();
  const sync = new MapSync({ store, adapter, scheduler: createManualScheduler() });
  sync.start();
  return { sync, adapter };
}

/** Doğrulama hataları raporun sonunda listelenir (tablo yine basılır); varsa çıkış kodu 1. */
const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

// ── Senaryolar ───────────────────────────────────────────────────

console.log(`Kurulum: ${UNITS.toLocaleString("tr-TR")} birlik, ${GROUPS} alt katman…`);

// 1) İlk yükleme: 50k unsuru store'a yazmak
measure(
  "Store: 50k unsur ilk yükleme (tek transaction)",
  { iterations: 5, warmup: 1, note: "uygulama açılışı / ilk snapshot" },
  () => {},
  () => {
    seededStore();
  },
);

const store = seededStore();
const perPacket = UNITS / PACKETS_PER_SEC;
/** Ölçümden önce (setup'ta) hazırlanan paketler. */
let packets: (FeaturePatch[] | Feature[])[] = [];

// 2) Store yazma: 1 saniyelik canlı yük (50k mesaj, 20 paket)
measure(
  `Store: 1 sn'lik akış (${PACKETS_PER_SEC} paket × ${perPacket.toLocaleString("tr-TR")} konum)`,
  {
    iterations: 20,
    budget: 100,
    note: "ms/sn = ana thread'in yüzde kaçı (100 ms = %10). Mesaj nesneleri ölçüm DIŞINDA üretilir (gerçekte JSON parse üretir)",
  },
  () => {
    store.drainChanges();
    packets = Array.from({ length: PACKETS_PER_SEC }, (_, p) => positionPatches(perPacket, p * perPacket));
  },
  () => {
    for (const patches of packets as FeaturePatch[][]) store.transaction((tx) => tx.patchFeatures(patches));
  },
);

// 2b) Aynı yük, EN KÖTÜ DURUM: her mesaj birliğin tamamı (her iç nesne yeni — JSON gibi)
/** `count` birliğin tam nesnesi; konum değişir, props/meta/style içerikleri aynı ama yeni nesne. */
function fullObjects(count: number, offset = 0): Feature[] {
  tick++;
  return Array.from({ length: count }, (_, k) => ({ ...unit((offset + k) % UNITS), style: { size: 24 } }));
}
store.transaction((tx) => tx.upsertFeatures(fullObjects(UNITS))); // style alanını bir kez yerleştir
measure(
  `Store: 1 sn'lik akış, TAM NESNE (${PACKETS_PER_SEC} paket × ${perPacket.toLocaleString("tr-TR")})`,
  { iterations: 20, budget: 100, note: "en kötü durum (karar #10): içerik karşılaştırması dahil; mesajlar ölçüm dışında üretilir" },
  () => {
    store.drainChanges();
    packets = Array.from({ length: PACKETS_PER_SEC }, (_, p) => fullObjects(perPacket, p * perPacket));
  },
  () => {
    for (const features of packets as Feature[][]) store.transaction((tx) => tx.upsertFeatures(features));
  },
);

// 3) Aynı yük + 200 id bazlı abone (React kartları / tablo satırları)
{
  const offs = Array.from({ length: 200 }, (_, i) => store.subscribeFeature(unitId(i * 250), () => {}));
  measure(
    "Store: aynı 1 sn'lik akış + 200 unsur abonesi",
    { iterations: 20, budget: 100 },
    () => {
      store.drainChanges();
      packets = Array.from({ length: PACKETS_PER_SEC }, (_, p) => positionPatches(perPacket, p * perPacket));
    },
    () => {
      for (const patches of packets as FeaturePatch[][]) store.transaction((tx) => tx.patchFeatures(patches));
    },
  );
  offs.forEach((off) => off());
}

// 4) MapSync ilk senkron (50k → adapter)
measure(
  "MapSync: ilk senkron (50k unsur)",
  { iterations: 10, warmup: 2, note: "uygulama açılışı" },
  () => {},
  () => {
    startedSync(store).sync.stop();
  },
);

const { sync, adapter } = startedSync(store);
const perFlush = UNITS / APPLY_HZ;

// 5) MapSync flush: 10 Hz'de bir flush'a düşen değişiklik (%10)
measure(
  `MapSync flush: ${perFlush.toLocaleString("tr-TR")} değişen unsur (%10)`,
  { iterations: 30, budget: 4, note: "plan bütçesi: flush < 4 ms" },
  () => {
    const patches = positionPatches(perFlush, (tick * perFlush) % UNITS);
    store.transaction((tx) => tx.patchFeatures(patches));
  },
  () => sync.flush(),
);
check(adapter.stats.upserts === perFlush, `flush ${perFlush} upsert üretmeli (${adapter.stats.upserts})`);

// 5b) Aynı flush, EN KÖTÜ DURUM: değişiklikler tam nesne olarak geldi
let onlyGeometry = true;
const geometryOnlyAdapter = {
  applyBatch(batch: RenderBatch) {
    adapter.applyBatch(batch);
    onlyGeometry = (batch.features?.upsert ?? []).every((rf) => rf.changed === 1 /* GEOMETRY */);
  },
};
{
  const fullSync = new MapSync({ store, adapter: geometryOnlyAdapter, scheduler: createManualScheduler() });
  sync.stop();
  fullSync.start();
  measure(
    `MapSync flush: ${perFlush.toLocaleString("tr-TR")} değişen, TAM NESNE (%10)`,
    { iterations: 30, budget: 4, note: "adapter yalnız GEOMETRY bitini görmeli (ikon/stil yeniden hesaplanmaz)" },
    () => {
      const features = fullObjects(perFlush, (tick * perFlush) % UNITS);
      store.transaction((tx) => tx.upsertFeatures(features));
    },
    () => fullSync.flush(),
  );
  check(onlyGeometry, "tam nesne akışında adapter'a yalnız GEOMETRY biti gitmeli");
  fullSync.stop();
  sync.start();
  adapter.stats.upserts = 0;
}

// 6) MapSync flush: düşük yük (%1)
measure(
  "MapSync flush: 500 değişen unsur (%1)",
  { iterations: 30, budget: 4 },
  () => {
    const patches = positionPatches(500, (tick * 500) % UNITS);
    store.transaction((tx) => tx.patchFeatures(patches));
  },
  () => sync.flush(),
);

// 7) Yalnız META değişimi (harita hiçbir şey almamalı)
measure(
  `MapSync flush: ${perFlush.toLocaleString("tr-TR")} yalnız-META değişimi`,
  { iterations: 30, budget: 4, note: "adapter'a hiçbir şey gitmemeli" },
  () => {
    tick++;
    const patches = Array.from({ length: perFlush }, (_, k) => ({ id: unitId(k), meta: { yakit: tick } }));
    store.transaction((tx) => tx.patchFeatures(patches));
  },
  () => sync.flush(),
);

// 8) Katman kapat / aç (10k unsurlu alt katman → REMOVE / ADD)
let layerVisible = true;
measure(
  "MapSync flush: 10k unsurlu katmanı kapat/aç",
  { iterations: 20, budget: 16, note: "kullanıcı işlemi; bir kare (16 ms) içinde kalmalı" },
  () => {
    layerVisible = !layerVisible;
    store.transaction((tx) => tx.patchLayer("birlikler-0", { visible: layerVisible }));
  },
  () => sync.flush(),
);
check(adapter.stats.upserts + adapter.stats.removes === UNITS / GROUPS, "katman aç/kapa 10k unsuru etkilemeli");

// 9) Katman taşı (yapı değişimi → 50k tam yeniden değerlendirme)
let moveToFront = true;
measure(
  "MapSync flush: katman taşı (50k tam değerlendirme)",
  { iterations: 20, budget: 50, note: "nadir kullanıcı işlemi (sürükle-bırak)" },
  () => {
    moveToFront = !moveToFront;
    store.transaction((tx) => tx.moveLayer("kontrol", null, moveToFront ? 0 : 1));
  },
  () => sync.flush(),
);

// 10) Seçim değişimi (100 unsur)
measure(
  "MapSync flush: 100 unsurluk seçim değişimi",
  { iterations: 30, budget: 4 },
  () => {
    tick++;
    const ids = Array.from({ length: 100 }, (_, k) => unitId((tick * 100 + k) % UNITS));
    store.transaction((tx) => tx.select(ids));
  },
  () => sync.flush(),
);

// 11) Yeniden bağlanma: 10k'lık katman snapshot'ı (içerik aynı / %10 değişmiş)
const snapshotSame = Array.from(store.getFeatureIds("birlikler-1"), (id) => store.getFeature(id)!);
measure(
  "Store: 10k snapshot (replaceLayerContents), içerik aynı",
  { iterations: 20, note: "yeniden bağlanma; değişiklik yoksa günlük boş kalmalı" },
  () => store.drainChanges(),
  () => store.transaction((tx) => tx.replaceLayerContents("birlikler-1", snapshotSame)),
);
measure(
  "Store: 10k snapshot, %10 konum değişmiş",
  { iterations: 20 },
  () => {
    store.drainChanges();
    tick++;
  },
  () => {
    const snapshot = snapshotSame.map((f, k) => (k % 10 === 0 ? { ...f, geometry: point(k) } : f));
    store.transaction((tx) => tx.replaceLayerContents("birlikler-1", snapshot));
  },
);

sync.stop();

// ── Rapor ────────────────────────────────────────────────────────

const fmt = (n: number) => n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
console.log("");
console.table(
  results.map((r) => ({
    Senaryo: r.name,
    "Medyan (ms)": fmt(r.median),
    "p95 (ms)": fmt(r.p95),
    "Bütçe (ms)": r.budget === undefined ? "—" : fmt(r.budget),
    Durum: r.budget === undefined ? "bilgi" : r.p95 <= r.budget ? "✓" : "✗ AŞILDI",
  })),
);
for (const r of results) if (r.note) console.log(`• ${r.name}: ${r.note}`);
// Çekirdeğin tsconfig'inde Node tipleri bilinçli olarak yok; `process`'e tipsiz erişiyoruz.
const node = (globalThis as {
  process?: { version: string; platform: string; arch: string; exitCode?: number };
}).process;
if (node) console.log(`\nNode ${node.version} · ${node.platform} ${node.arch}`);

if (failures.length > 0) {
  console.log("\n✗ DOĞRULAMA HATALARI:");
  for (const f of failures) console.log(`  - ${f}`);
  if (node) node.exitCode = 1;
}
