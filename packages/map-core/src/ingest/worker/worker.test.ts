import { describe, expect, it, vi } from "vitest";
import type { Feature } from "../../model/feature";
import type { FeaturePatch } from "../../store/diff";
import { createMapStore } from "../../store/map-store";
import { deepEqual } from "../../store/stabilize";
import { applyIngestPacket, connectIngestWorker } from "./connect-ingest-worker";
import { featureDelta, mergePatches } from "./feature-delta";
import { IngestEngine } from "./ingest-engine";
import type { IngestInbound, IngestOutbound, MessageEndpoint } from "./protocol";
import { runIngestWorker, type WebSocketLike } from "./run-ingest-worker";

const unit = (id: string, over: Partial<Feature> = {}): Feature => ({
  id,
  layerId: "birlikler",
  kind: "milsym",
  geometry: { kind: "point", coord: [32, 39] },
  props: { sidc: "S1", name: "A" },
  ...over,
});

describe("featureDelta", () => {
  it("aynı içerik (yeni nesneler) → same", () => {
    expect(featureDelta(unit("a"), unit("a"))).toEqual({ type: "same" });
  });

  it("yalnız konum → yalnız geometry (+ rev)", () => {
    const next = unit("a", { geometry: { kind: "point", coord: [33, 39] }, rev: 7 });
    expect(featureDelta(unit("a"), next)).toEqual({ type: "patch", patch: { id: "a", geometry: next.geometry, rev: 7 } });
  });

  it("props değeri değişti → props tam hâliyle; alt anahtar silindi → full; alan kalktı → undefined", () => {
    expect(featureDelta(unit("a"), unit("a", { props: { sidc: "S2", name: "A" } }))).toEqual({
      type: "patch",
      patch: { id: "a", props: { sidc: "S2", name: "A" } },
    });
    expect(featureDelta(unit("a"), unit("a", { props: { sidc: "S1" } }))).toEqual({ type: "full" });
    const withStyle = unit("a", { style: { color: "red" } });
    expect(featureDelta(withStyle, unit("a"))).toEqual({ type: "patch", patch: { id: "a", style: undefined } });
  });

  it("kind değişti → full; skaler alanlar (z, hidden, layerId…)", () => {
    expect(featureDelta(unit("a"), unit("a", { kind: "marker" }))).toEqual({ type: "full" });
    expect(featureDelta(unit("a"), unit("a", { hidden: true, z: 3 }))).toEqual({ type: "patch", patch: { id: "a", hidden: true, z: 3 } });
  });

  it("mergePatches: sonra gelen kazanır, nesne alanları sığ birleşir", () => {
    expect(mergePatches({ id: "a", props: { x: 1 }, z: 1 }, { id: "a", props: { y: 2 }, hidden: true })).toEqual({
      id: "a",
      props: { x: 1, y: 2 },
      z: 1,
      hidden: true,
    });
  });
});

describe("denklik: Worker paketleri ≡ doğrudan tam nesne", () => {
  /** Tekrarlanabilir rastgele */
  const rnd = (() => {
    let s = 7;
    return () => ((s = (s * 1664525 + 1013904223) % 2 ** 32), s / 2 ** 32);
  })();
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;

  /** Rastgele bir tam nesne mesajı: konum / props / stil / meta / kind / alan kaldırma karışık. */
  function randomMessage(id: string): Feature {
    const f: Feature = {
      id,
      layerId: "birlikler",
      kind: pick(["milsym", "milsym", "milsym", "marker"]),
      geometry: { kind: "point", coord: [32 + Math.floor(rnd() * 4) / 10, 39] },
      props: pick([{ sidc: "S1", name: "A" }, { sidc: "S2", name: "A" }, { sidc: "S1" }, { sidc: "S1", name: "A", tag: 1 }]),
    };
    if (rnd() < 0.5) f.style = pick([{ color: "red" }, { color: "blue", size: 2 }]);
    if (rnd() < 0.5) f.meta = pick([{ fuel: 80 }, { fuel: 70, status: "ok" }, { status: "ok" }]);
    if (rnd() < 0.3) f.z = Math.floor(rnd() * 3);
    if (rnd() < 0.2) f.hidden = true;
    return f;
  }

  it("2000 rastgele mesaj, araya giren drain'ler, silme ve snapshot: iki store her adımda aynı", () => {
    const direct = createMapStore();
    const viaWorker = createMapStore();
    const engine = new IngestEngine({ streams: { birlikler: {} }, touchIntervalMs: 0 });
    const ids = ["a", "b", "c", "d", "e"];

    for (let step = 0; step < 2000; step++) {
      const r = rnd();
      if (r < 0.05) {
        const id = pick(ids);
        direct.transaction((tx) => tx.removeFeatures([id]));
        engine.update("birlikler", [{ id, removed: true }]);
      } else if (r < 0.07) {
        const snap = ids.filter(() => rnd() < 0.6).map(randomMessage);
        direct.transaction((tx) => tx.replaceLayerContents("birlikler", snap));
        engine.snapshot("birlikler", snap);
      } else {
        const msgs = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => randomMessage(pick(ids)));
        direct.transaction((tx) => tx.upsertFeatures(msgs));
        engine.update("birlikler", msgs);
      }
      if (rnd() < 0.3) {
        const packet = engine.drain();
        if (packet) applyIngestPacket(viaWorker, packet);
        for (const id of ids) {
          const a = direct.getFeature(id);
          const b = viaWorker.getFeature(id);
          // Alanı `undefined` olan anahtar ile alanın hiç olmaması aynı sayılır (store'da da öyle).
          expect(deepEqual(clean(a), clean(b)), `adım ${step}, ${id}`).toBe(true);
        }
      }
    }
  });

  it("patch akışı: 2000 rastgele patch (alan kaldırma + yeniden ekleme dahil) sırayla uygulanmışla aynı", () => {
    const direct = createMapStore();
    const viaWorker = createMapStore();
    const engine = new IngestEngine({ streams: { birlikler: { format: "patch" } }, touchIntervalMs: 0 });
    const ids = ["a", "b", "c"];
    const initial = ids.map((id) => unit(id, { meta: { fuel: 1, status: "ok" } }));
    direct.transaction((tx) => tx.upsertFeatures(initial));
    engine.update("birlikler", initial, "full");
    applyIngestPacket(viaWorker, engine.drain()!);

    for (let step = 0; step < 2000; step++) {
      const id = pick(ids);
      const patch = pick<Record<string, unknown>>([
        { meta: undefined },
        { meta: { fuel: Math.floor(rnd() * 5) } },
        { meta: { status: pick(["ok", "low"]) } },
        { props: { sidc: pick(["S1", "S2"]) } },
        { props: undefined },
        { geometry: { kind: "point", coord: [32 + Math.floor(rnd() * 5) / 10, 39] } },
        { z: Math.floor(rnd() * 3) },
      ]);
      const p = { id, ...patch } as FeaturePatch;
      direct.transaction((tx) => tx.patchFeatures([p]));
      engine.update("birlikler", [p]);
      if (rnd() < 0.25) {
        const packet = engine.drain();
        if (packet) applyIngestPacket(viaWorker, packet);
        for (const x of ids) expect(deepEqual(clean(direct.getFeature(x)), clean(viaWorker.getFeature(x))), `adım ${step}, ${x}`).toBe(true);
      }
    }
  });

  const clean = (f: Feature | undefined) => (f ? Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) : undefined);
});

describe("IngestEngine", () => {
  it("tam nesne akışı: ilk mesaj tam, sonrakiler yalnız değişen; aynı içerik gönderilmez", () => {
    const engine = new IngestEngine({ streams: { birlikler: {} }, touchIntervalMs: 0 });
    engine.update("birlikler", [unit("a")]);
    expect(engine.drain()!.streams[0]!.upserts).toEqual([unit("a")]);
    engine.update("birlikler", [unit("a"), unit("a", { geometry: { kind: "point", coord: [33, 39] } })]);
    const s = engine.drain()!.streams[0]!;
    expect(s.upserts).toEqual([]);
    expect(s.patches).toEqual([{ id: "a", geometry: { kind: "point", coord: [33, 39] } }]);
    engine.update("birlikler", [unit("a", { geometry: { kind: "point", coord: [33, 39] } })]);
    expect(engine.drain()).toBeNull();
    expect(engine.stats).toMatchObject({ unchanged: 2, sentFull: 1, sentPatches: 1 });
  });

  it("aynı unsurun ara mesajları tek öğede birleşir (yeni unsur + değişiklik → tek tam nesne)", () => {
    const engine = new IngestEngine({ streams: { birlikler: {} }, touchIntervalMs: 0 });
    engine.update("birlikler", [unit("a"), unit("a", { z: 1 }), unit("a", { z: 2 })]);
    const s = engine.drain()!.streams[0]!;
    expect(s.upserts).toEqual([unit("a", { z: 2 })]);
    expect(s.patches).toEqual([]);
  });

  it("canlılık: içerik aynı kalsa da touchIntervalMs'de bir { id, rev } gider", () => {
    let now = 0;
    const engine = new IngestEngine({ streams: { birlikler: {} }, touchIntervalMs: 1000, now: () => now });
    engine.update("birlikler", [unit("a", { rev: 1 })]);
    engine.drain();
    now = 500;
    engine.update("birlikler", [unit("a", { rev: 2 })]);
    expect(engine.drain()).toBeNull();
    now = 1000;
    engine.update("birlikler", [unit("a", { rev: 3 })]);
    expect(engine.drain()!.streams[0]!.patches).toEqual([{ id: "a", rev: 3 }]);
  });

  it("patch formatı, normalize (null atla), yanlış katman, silme", () => {
    const engine = new IngestEngine({
      streams: {
        birlikler: { format: "patch", normalize: (m: { uid: string; lon?: number; gone?: boolean } | null) => (!m ? null : m.gone ? { id: m.uid, removed: true } : { id: m.uid, geometry: { kind: "point", coord: [m.lon!, 39] } }) },
        diger: {},
      },
    });
    engine.update("birlikler", [{ uid: "a", lon: 1 }, null, { uid: "a", lon: 2 }, { uid: "b", gone: true }]);
    engine.update("diger", [unit("x", { layerId: "baska" })]);
    const packet = engine.drain()!;
    expect(packet.streams).toHaveLength(1);
    expect(packet.streams[0]).toMatchObject({ patches: [{ id: "a", geometry: { coord: [2, 39] } }], removes: ["b"] });
    expect(engine.stats).toMatchObject({ skipped: 1, wrongLayer: 1 });
    expect(() => engine.update("yok", [])).toThrow(/tanımsız akış/);
  });

  it("snapshot: önceki bekleyenler atılır, sonrakiler snapshot'tan sonra uygulanır", () => {
    const engine = new IngestEngine({ streams: { birlikler: {} }, touchIntervalMs: 0 });
    engine.update("birlikler", [unit("old")]);
    engine.snapshot("birlikler", [unit("a"), unit("b")]);
    engine.update("birlikler", [unit("a", { z: 5 })]);
    const s = engine.drain()!.streams[0]!;
    expect(s.snapshot!.map((f) => f.id)).toEqual(["a", "b"]);
    expect(s.upserts).toEqual([]);
    expect(s.patches).toEqual([{ id: "a", z: 5 }]);
  });
});

// ── Uçtan uca: ana thread ↔ Worker (sahte uç noktalar) ─────────────

function channel() {
  type L<T> = (event: { data: T }) => void;
  const toWorker = new Set<L<IngestInbound>>();
  const toMain = new Set<L<IngestOutbound>>();
  const queue: (() => void)[] = [];
  const main: MessageEndpoint<IngestOutbound, IngestInbound> = {
    postMessage: (m) => queue.push(() => toWorker.forEach((l) => l({ data: structuredClone(m) }))),
    addEventListener: (_t, l) => toMain.add(l),
    removeEventListener: (_t, l) => toMain.delete(l),
  };
  const worker: MessageEndpoint<IngestInbound, IngestOutbound> = {
    postMessage: (m) => queue.push(() => toMain.forEach((l) => l({ data: structuredClone(m) }))),
    addEventListener: (_t, l) => toWorker.add(l),
    removeEventListener: (_t, l) => toWorker.delete(l),
  };
  /** Kuyruktaki tüm mesajları teslim et (postMessage asenkron gibi). */
  const deliver = () => {
    while (queue.length) queue.shift()!();
  };
  return { main, worker, deliver };
}

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.({});
  }
}

describe("runIngestWorker + connectIngestWorker", () => {
  it("soket → Worker'da parse + normalize → kare başına bir pull → store; tek transaction", () => {
    FakeSocket.all = [];
    const { main, worker, deliver } = channel();
    runIngestWorker(
      {
        streams: { birlikler: { normalize: (m: { uid: string; x: number }) => ({ id: m.uid, kind: "milsym", geometry: { kind: "point", coord: [m.x, 39] } }) } },
        touchIntervalMs: 0,
        socket: {
          url: "wss://test",
          WebSocket: FakeSocket,
          onOpen: (ws) => ws.send("subscribe"),
          onMessage: (data, api) => api.update("birlikler", JSON.parse(String(data))),
        },
      },
      worker,
    );
    const store = createMapStore();
    const frames: (() => void)[] = [];
    const statuses: string[] = [];
    const conn = connectIngestWorker(store, main, {
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: () => {},
      onStatus: (s) => statuses.push(s),
    });
    const frame = () => {
      const run = frames.splice(0);
      run.forEach((cb) => cb());
      deliver();
    };

    const ws = FakeSocket.all[0]!;
    ws.onopen!({});
    expect(ws.sent).toEqual(["subscribe"]);
    ws.onmessage!({ data: JSON.stringify([{ uid: "a", x: 1 }, { uid: "b", x: 2 }]) });
    ws.onmessage!({ data: JSON.stringify([{ uid: "a", x: 3 }]) });

    const spy = vi.spyOn(store, "transaction");
    frame();
    expect(spy).toHaveBeenCalledTimes(1); // iki soket mesajı → tek paket → tek transaction
    expect(store.getFeature("a")!.geometry).toEqual({ kind: "point", coord: [3, 39] });
    expect(conn.stats).toMatchObject({ packets: 1, items: 2 });
    deliver();
    expect(statuses).toContain("open");

    frame(); // bekleyen yok → paket null, store'a dokunulmaz
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("json taşıma: paket metin olarak gelir, aynı sonuç", () => {
    const { main, worker, deliver } = channel();
    const handle = runIngestWorker({ streams: { birlikler: {} }, touchIntervalMs: 0 }, worker);
    const seen: unknown[] = [];
    main.addEventListener("message", (e) => e.data.type === "packet" && seen.push(e.data.packet));
    const store = createMapStore();
    const frames: (() => void)[] = [];
    connectIngestWorker(store, main, { requestFrame: (cb) => frames.push(cb), cancelFrame: () => {}, transport: "json" });
    handle.api.update("birlikler", [unit("a")]);
    frames.splice(0).forEach((cb) => cb());
    deliver();
    expect(typeof seen[0]).toBe("string");
    expect(store.getFeature("a")).toEqual(unit("a"));
  });

  it("geri basınç: cevap gelmeden ikinci pull gönderilmez", () => {
    const { main, worker, deliver } = channel();
    const pulls = vi.fn();
    worker.addEventListener("message", (e) => e.data.type === "pull" && pulls());
    const frames: (() => void)[] = [];
    connectIngestWorker(createMapStore(), main, { requestFrame: (cb) => frames.push(cb), cancelFrame: () => {} });
    for (let i = 0; i < 3; i++) frames.splice(0).forEach((cb) => cb()); // 3 kare, teslim yok
    deliver();
    expect(pulls).toHaveBeenCalledTimes(1);
  });

  it("soket koparsa artan beklemeyle yeniden bağlanır; stop sonrası bağlanmaz", () => {
    FakeSocket.all = [];
    const { worker } = channel();
    const timers: { cb: () => void; ms: number }[] = [];
    const handle = runIngestWorker(
      {
        streams: { birlikler: {} },
        socket: { url: "wss://t", WebSocket: FakeSocket, onMessage: () => {}, reconnect: { minMs: 100, maxMs: 300 } },
        setTimeout: (cb, ms) => timers.push({ cb, ms }),
        clearTimeout: () => {},
      },
      worker,
    );
    FakeSocket.all[0]!.close();
    FakeSocket.all.at(-1)!; // yeni soket henüz yok
    timers.shift()!.cb();
    FakeSocket.all[1]!.close();
    timers.shift()!.cb();
    FakeSocket.all[2]!.close();
    expect(timers.map((t) => t.ms)).toEqual([300]); // 100, 200, 300 (sınır)
    handle.stop();
    timers.shift()!.cb();
    expect(FakeSocket.all).toHaveLength(3);
  });

  it("ana thread'den push / command; hata ana thread'e iletilir", () => {
    const { main, worker, deliver } = channel();
    const onCommand = vi.fn();
    runIngestWorker({ streams: { birlikler: {} }, onCommand }, worker);
    const errors: string[] = [];
    const frames: (() => void)[] = [];
    const store = createMapStore();
    const conn = connectIngestWorker(store, main, { requestFrame: (cb) => frames.push(cb), cancelFrame: () => {}, onError: (m) => errors.push(m) });
    conn.push("birlikler", [unit("a")]);
    conn.command({ hz: 2 });
    conn.push("yok", []);
    deliver();
    frames.splice(0).forEach((cb) => cb());
    deliver();
    expect(store.getFeature("a")).toBeDefined();
    expect(onCommand).toHaveBeenCalledWith({ hz: 2 }, expect.anything());
    expect(errors[0]).toMatch(/tanımsız akış/);
  });
});
