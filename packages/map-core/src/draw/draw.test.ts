import { describe, expect, it } from "vitest";
import { MockAdapter } from "../adapter/mock-adapter";
import { EventRouter, MAP_EVENT, type MapEventInput } from "../events/event-router";
import { distance } from "../geo/geodesic";
import { corridorRing, ellipseRing, shapeRings } from "../geo/shapes";
import type { Geometry, LngLat } from "../model/geometry";
import { createMapStore } from "../store/map-store";
import { DrawController } from "./draw-controller";
import { createDrawTool, distanceToPolyline } from "./tools";
import { DRAW_TOOL, type DrawToolKind, type ToolContext } from "./types";

/** Ekran yakınlığı: testte 1 derece = 1000 px (yakın = aynı nokta civarı). */
const ctx: ToolContext = { near: (a, b, px) => Math.hypot(a[0] - b[0], a[1] - b[1]) * 1000 <= px };

const A: LngLat = [32, 39];
const B: LngLat = [32.1, 39];
const C: LngLat = [32.1, 39.1];
const D: LngLat = [32, 39.1];

describe("şekiller (jeodezik)", () => {
  it("elips: büyük eksen ucu rotasyon yönünde, küçük eksen 90° sağında", () => {
    const ring = ellipseRing(A, 4000, 1000, 90, 4); // büyük eksen doğu-batı
    expect(ring).toHaveLength(5);
    expect(distance(A, ring[0]!)).toBeCloseTo(4000, 6);
    expect(ring[0]![0]).toBeGreaterThan(A[0]); // doğuda
    expect(distance(A, ring[1]!)).toBeCloseTo(1000, 6);
    expect(ring[1]![1]).toBeLessThan(A[1]); // 90° + 90° = güney
  });

  it("koridor: kenarlar orta çizgiden yarı genişlik uzakta; köşede miter; tekrar eden nokta yok sayılır", () => {
    const ring = corridorRing([A, B, B], 2000);
    expect(ring).toHaveLength(5); // 2 sol + 2 sağ + kapanış
    for (const p of ring.slice(0, 4)) expect(distanceToPolyline(p, [A, B])).toBeCloseTo(1000, -1);
    const bent = corridorRing([A, B, C], 2000);
    expect(bent).toHaveLength(7);
    expect(distance(B, bent[1]!)).toBeGreaterThan(1000); // köşe dışa uzar
    expect(corridorRing([A], 1000)).toEqual([]);
    expect(corridorRing([A, B], 0)).toEqual([]);
  });

  it("shapeRings: parametrik olanlar poligona, diğerleri null", () => {
    expect(shapeRings({ kind: "circle", center: A, radiusM: 100 }, 8)![0]).toHaveLength(9);
    expect(shapeRings({ kind: "rectangle", min: A, max: C })![0]).toEqual([A, B, C, D, A]);
    expect(shapeRings({ kind: "point", coord: A })).toBeNull();
  });
});

describe("araçlar", () => {
  const run = (kind: DrawToolKind, steps: (["click" | "move", LngLat] | ["finish"] | ["undo"])[], options = {}) => {
    const tool = createDrawTool(kind, ctx, options);
    let done = false;
    for (const [action, coord] of steps) {
      if (action === "move") tool.move(coord!);
      else if (action === "click") done = tool.click(coord!) === "done" || done;
      else if (action === "finish") done = tool.finish() === "done" || done;
      else tool.undo();
    }
    return { tool, done, result: tool.result() };
  };

  it("nokta: tek tık", () => {
    const { done, result } = run(DRAW_TOOL.POINT, [["click", A]]);
    expect(done).toBe(true);
    expect(result).toEqual({ kind: "point", coord: A });
  });

  it("çizgi: tıklar + çift tıkın ikinci tıkı yok sayılır + bitir; en az 2 nokta", () => {
    const { tool } = run(DRAW_TOOL.LINE, [["click", A]]);
    expect(tool.finish()).toBe("invalid");
    const { done, result } = run(DRAW_TOOL.LINE, [["click", A], ["click", B], ["click", B], ["finish"]]);
    expect(done).toBe(true);
    expect(result).toEqual({ kind: "line", coords: [A, B] });
  });

  it("çizgi önizlemesi: imleç lastik bant; ölçüm uzunluk; geri al", () => {
    const { tool } = run(DRAW_TOOL.LINE, [["click", A], ["move", B]]);
    expect(tool.preview().shape).toEqual({ kind: "line", coords: [A, B] });
    expect(tool.measure().lengthM).toBeCloseTo(distance(A, B), 6);
    tool.undo();
    expect(tool.preview()).toEqual({ shape: null, vertices: [B], guides: [] }); // yalnız imleç noktası
    expect(tool.canUndo).toBe(false);
  });

  it("poligon: ilk köşeye tıklayınca kapanır; alan ölçümü", () => {
    const { done, result, tool } = run(DRAW_TOOL.POLYGON, [["click", A], ["click", B], ["click", C], ["click", [32.0001, 39.0001]]]);
    expect(done).toBe(true);
    expect(result).toEqual({ kind: "polygon", rings: [[A, B, C, A]] });
    expect(tool.measure().areaM2).toBeGreaterThan(0);
    // 2 köşeyle kapatma yok
    expect(run(DRAW_TOOL.POLYGON, [["click", A], ["click", B], ["finish"]]).done).toBe(false);
  });

  it("daire: merkez + yarıçap", () => {
    const { done, result, tool } = run(DRAW_TOOL.CIRCLE, [["click", A], ["move", B], ["click", B]]);
    expect(done).toBe(true);
    expect(result).toMatchObject({ kind: "circle", center: A });
    expect((result as { radiusM: number }).radiusM).toBeCloseTo(distance(A, B), 6);
    expect(tool.measure().radiusM).toBeCloseTo(distance(A, B), 6);
    expect(run(DRAW_TOOL.CIRCLE, [["click", A], ["click", A]]).done).toBe(false); // sıfır yarıçap
  });

  it("dikdörtgen: herhangi iki karşı köşe → min/max", () => {
    const { result } = run(DRAW_TOOL.RECTANGLE, [["click", C], ["click", A]]);
    expect(result).toEqual({ kind: "rectangle", min: A, max: C });
    expect(run(DRAW_TOOL.RECTANGLE, [["click", A], ["click", B]]).done).toBe(false); // aynı enlem: alan yok
  });

  it("elips: merkez → büyük eksen (yön) → küçük eksen (dik uzaklık)", () => {
    const north: LngLat = [32, 39.05];
    const east: LngLat = [32.02, 39];
    const { done, result, tool } = run(DRAW_TOOL.ELLIPSE, [["click", A], ["click", north], ["move", east], ["click", east]]);
    expect(done).toBe(true);
    const e = result as Extract<Geometry, { kind: "ellipse" }>;
    expect(e.semiMajorM).toBeCloseTo(distance(A, north), 6);
    expect(e.rotationDeg).toBeCloseTo(0, 6);
    expect(e.semiMinorM).toBeCloseTo(distance(A, east), 0);
    expect(tool.measure().areaM2).toBeCloseTo(Math.PI * e.semiMajorM * e.semiMinorM, 0);
  });

  it("elips: küçük eksen büyükten uzunsa yer değiştirir (rotasyon +90)", () => {
    const { result } = run(DRAW_TOOL.ELLIPSE, [["click", A], ["click", [32, 39.01]], ["click", [32.1, 39]]]);
    const e = result as Extract<Geometry, { kind: "ellipse" }>;
    expect(e.semiMajorM).toBeGreaterThan(e.semiMinorM);
    expect(e.rotationDeg).toBeCloseTo(90, 0);
  });

  it("koridor: orta çizgi → genişlik fareyle; geri al genişlikten çizgiye döner", () => {
    const tool = createDrawTool(DRAW_TOOL.CORRIDOR, ctx);
    tool.click(A);
    tool.click(B);
    expect(tool.finish()).toBe("continue"); // genişlik adımı
    tool.move([32.05, 39.01]); // çizgiden ~1110 m
    expect(tool.preview().shape?.kind).toBe("corridor");
    expect(tool.measure().widthM).toBeCloseTo(2 * distanceToPolyline([32.05, 39.01], [A, B]), 6);
    tool.undo();
    expect(tool.preview().shape?.kind).toBe("line");
    expect(tool.finish()).toBe("continue");
    expect(tool.click([32.05, 39.01])).toBe("done");
    const r = tool.result() as Extract<Geometry, { kind: "corridor" }>;
    expect(r.coords).toEqual([A, B]);
    expect(r.widthM).toBeGreaterThan(2000);
  });

  it("koridor: genişlik seçenekle verilirse adım atlanır", () => {
    const { done, result } = run(DRAW_TOOL.CORRIDOR, [["click", A], ["click", B], ["finish"]], { corridorWidthM: 500 });
    expect(done).toBe(true);
    expect(result).toEqual({ kind: "corridor", coords: [A, B], widthM: 500 });
  });

  it("her aracın bir ipucu metni var", () => {
    for (const kind of Object.values(DRAW_TOOL)) expect(createDrawTool(kind, ctx).hint().length).toBeGreaterThan(5);
  });
});

describe("DrawController", () => {
  const setup = () => {
    const store = createMapStore();
    const router = new EventRouter(store);
    const adapter = new MockAdapter();
    const emitted: MapEventInput[] = [];
    router.on(MAP_EVENT.DRAW_COMPLETE, (e) => emitted.push(e));
    // MockAdapter projeksiyonu özdeşlik: 1 derece = 1 px → testte ölçeği büyüt
    adapter.project = (c) => ({ x: c[0] * 1000, y: c[1] * 1000 });
    const draw = new DrawController({ events: router, adapter });
    const input = (e: MapEventInput) => router.emit(e);
    return { router, adapter, draw, emitted, input };
  };

  it("olaylardan çizer; önizleme adapter'a; bitince sonuç + DRAW_COMPLETE + mod kapanır", async () => {
    const { adapter, draw, emitted, input } = setup();
    const session = draw.start(DRAW_TOOL.LINE);
    expect(adapter.drawMode).toBe(true);
    expect(draw.getState()).toMatchObject({ tool: "line", canFinish: false });

    input({ type: MAP_EVENT.CLICK, coord: A });
    input({ type: MAP_EVENT.POINTER_MOVE, coord: B });
    expect(adapter.drawPreview?.shape).toEqual({ kind: "line", coords: [A, B] });
    expect(draw.getState()!.measurement.lengthM).toBeGreaterThan(0);

    input({ type: MAP_EVENT.CLICK, coord: B });
    input({ type: MAP_EVENT.CLICK, coord: B }); // çift tıkın ikinci tıkı
    input({ type: MAP_EVENT.DBLCLICK, coord: B });

    await expect(session.result).resolves.toEqual({ kind: "line", coords: [A, B] });
    expect(adapter.drawMode).toBe(false);
    expect(adapter.drawPreview).toBeNull();
    expect(draw.getState()).toBeNull();
    expect(draw.isDrawing).toBe(false);
    expect(emitted[0]?.data).toEqual({ tool: "line", geometry: { kind: "line", coords: [A, B] } });
  });

  it("klavye: Esc iptal (null), Enter bitir, Backspace geri al", async () => {
    const { draw, input } = setup();
    const s1 = draw.start(DRAW_TOOL.POLYGON);
    expect(draw.key("Escape")).toBe(true);
    await expect(s1.result).resolves.toBeNull();
    expect(draw.key("Escape")).toBe(false); // çizim yokken işlenmez

    const s2 = draw.start(DRAW_TOOL.POLYGON);
    for (const c of [A, B, C, D]) input({ type: MAP_EVENT.CLICK, coord: c });
    draw.key("Backspace"); // D geri alındı
    expect(draw.key("Enter")).toBe(true);
    await expect(s2.result).resolves.toEqual({ kind: "polygon", rings: [[A, B, C, A]] });
  });

  it("yeni çizim eskisini iptal eder; eski oturumun metodları etkisiz", async () => {
    const { draw, input } = setup();
    const old = draw.start(DRAW_TOOL.LINE);
    const next = draw.start(DRAW_TOOL.POINT);
    await expect(old.result).resolves.toBeNull();
    old.cancel(); // etkisiz
    input({ type: MAP_EVENT.CLICK, coord: A });
    await expect(next.result).resolves.toEqual({ kind: "point", coord: A });
  });

  it("çizim bitince olay dinleyicileri kalkar (tıklama artık araca gitmez)", async () => {
    const { draw, input } = setup();
    const s = draw.start(DRAW_TOOL.POINT);
    input({ type: MAP_EVENT.CLICK, coord: A });
    await s.result;
    expect(() => input({ type: MAP_EVENT.CLICK, coord: B })).not.toThrow();
    expect(draw.getState()).toBeNull();
  });

  it("durum aboneliği: her adımda yeni anlık görüntü", () => {
    const { draw, input } = setup();
    const states: unknown[] = [];
    draw.subscribe(() => states.push(draw.getState()));
    draw.start(DRAW_TOOL.CIRCLE);
    input({ type: MAP_EVENT.CLICK, coord: A });
    input({ type: MAP_EVENT.POINTER_MOVE, coord: B });
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect(new Set(states).size).toBe(states.length);
    draw.cancel();
    expect(states.at(-1)).toBeNull();
  });
});
