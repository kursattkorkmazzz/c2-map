// ── DrawController ───────────────────────────────────────────────
// Tasarım: plan/design/09-interaction-and-editing.md#çizim-mimarisi-öneri
//
// Aracı haritaya bağlar: EventRouter'dan CLICK / DBLCLICK / POINTER_MOVE alır, araca verir,
// önizlemeyi adapter'a (`setDrawPreview`) basar. Klavye (Esc / Enter / Backspace) UI katmanından
// `key()` ile gelir (çekirdek DOM bilmez). Aynı anda tek çizim; yenisi eskisini iptal eder.
//
// Sonuç (geometri) uygulamaya döner: store'a yazmak / backend'e göndermek uygulamanın kararıdır.

import type { MapAdapter } from "../adapter/types";
import { MAP_EVENT, type MapEventInput, type MapEventListener, type MapEventType } from "../events/event-router";
import type { Geometry, LngLat } from "../model/geometry";
import { createDrawTool } from "./tools";
import { EMPTY_PREVIEW, type DrawMeasurement, type DrawTool, type DrawToolKind, type DrawToolOptions } from "./types";

export type DrawControllerOptions = {
  events: {
    on(type: MapEventType, listener: MapEventListener): () => void;
    emit(event: MapEventInput): void;
  };
  adapter: Pick<MapAdapter, "setDrawMode" | "setDrawPreview" | "project">;
};

/** UI'ın gösterdiği anlık durum (değişmez anlık görüntü; değişince yeni nesne). */
export type DrawState = {
  readonly tool: DrawToolKind;
  readonly hint: string;
  readonly measurement: DrawMeasurement;
  readonly canFinish: boolean;
  readonly canUndo: boolean;
};

export type DrawSession = {
  readonly tool: DrawToolKind;
  /** Bitince geometri; iptalde `null`. */
  readonly result: Promise<Geometry | null>;
  finish(): void;
  cancel(): void;
  undo(): void;
};

type Active = {
  tool: DrawTool;
  session: DrawSession;
  resolve: (geometry: Geometry | null) => void;
  offs: (() => void)[];
};

export class DrawController {
  private active: Active | null = null;
  private state: DrawState | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: DrawControllerOptions) {}

  get isDrawing(): boolean {
    return this.active !== null;
  }

  get session(): DrawSession | null {
    return this.active?.session ?? null;
  }

  /** Yeni çizim başlatır (sürmekte olan iptal edilir). */
  start(kind: DrawToolKind, toolOptions: DrawToolOptions = {}): DrawSession {
    this.cancel();
    const { adapter, events } = this.options;
    const tool = createDrawTool(kind, { near: (a, b, px) => this.near(a, b, px) }, toolOptions);

    let resolve!: (geometry: Geometry | null) => void;
    const result = new Promise<Geometry | null>((r) => (resolve = r));
    const session: DrawSession = {
      tool: kind,
      result,
      finish: () => this.isCurrent(session) && this.finish(),
      cancel: () => this.isCurrent(session) && this.cancel(),
      undo: () => this.isCurrent(session) && this.undo(),
    };

    const offs = [
      events.on(MAP_EVENT.POINTER_MOVE, (e) => {
        if (!e.coord) return;
        tool.move(e.coord);
        this.render();
      }),
      events.on(MAP_EVENT.CLICK, (e) => {
        if (!e.coord) return;
        tool.move(e.coord);
        if (tool.click(e.coord) === "done") this.complete();
        else this.render(true);
      }),
      events.on(MAP_EVENT.DBLCLICK, () => this.finish()),
    ];

    this.active = { tool, session, resolve, offs };
    adapter.setDrawMode(true);
    this.render();
    return session;
  }

  /** Enter / çift tık: bitir veya sonraki adıma geç. */
  finish(): void {
    const active = this.active;
    if (!active) return;
    const outcome = active.tool.finish();
    if (outcome === "done") this.complete();
    else if (outcome === "continue") this.render(true);
  }

  undo(): void {
    if (!this.active) return;
    this.active.tool.undo();
    this.render(true);
  }

  cancel(): void {
    this.end(null);
  }

  /** Klavye: Escape → iptal, Enter → bitir, Backspace → geri al. İşlendiyse `true`. */
  key(key: string): boolean {
    if (!this.active) return false;
    if (key === "Escape") this.cancel();
    else if (key === "Enter") this.finish();
    else if (key === "Backspace") this.undo();
    else return false;
    return true;
  }

  // ── UI aboneliği (useSyncExternalStore uyumlu) ────────────────

  getState(): DrawState | null {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.cancel();
    this.listeners.clear();
  }

  // ── İç ─────────────────────────────────────────────────────────

  private isCurrent(session: DrawSession): boolean {
    return this.active?.session === session;
  }

  private complete(): void {
    const active = this.active;
    if (!active) return;
    const geometry = active.tool.result();
    if (!geometry) return; // araç "bitti" dedi ama sonuç geçersiz: çizime devam
    this.end(geometry);
  }

  private end(geometry: Geometry | null): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    for (const off of active.offs) off();
    this.options.adapter.setDrawPreview(null);
    this.options.adapter.setDrawMode(false);
    this.setState(null);
    if (geometry) {
      this.options.events.emit({ type: MAP_EVENT.DRAW_COMPLETE, data: { tool: active.session.tool, geometry } });
    }
    active.resolve(geometry);
  }

  /** Önizlemeyi adapter'a, durumu UI'a basar. `step`: tıklama/geri alma (DRAW_UPDATE yayılır). */
  private render(step = false): void {
    const active = this.active;
    if (!active) return;
    const { tool } = active;
    const preview = tool.preview();
    this.options.adapter.setDrawPreview(preview === EMPTY_PREVIEW ? null : preview);
    this.setState({
      tool: tool.kind,
      hint: tool.hint(),
      measurement: tool.measure(),
      canFinish: tool.canFinish,
      canUndo: tool.canUndo,
    });
    if (step) this.options.events.emit({ type: MAP_EVENT.DRAW_UPDATE, data: { tool: tool.kind, preview } });
  }

  private setState(next: DrawState | null): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  private near(a: LngLat, b: LngLat, px: number): boolean {
    const pa = this.options.adapter.project(a);
    const pb = this.options.adapter.project(b);
    if (!pa || !pb) return a[0] === b[0] && a[1] === b[1];
    return Math.hypot(pa.x - pb.x, pa.y - pb.y) <= px;
  }
}
