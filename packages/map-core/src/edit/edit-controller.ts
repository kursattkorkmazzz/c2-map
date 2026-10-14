// ── EditController: taslakla düzenleme ──────────────────────────
// Tasarım: plan/design/09-interaction-and-editing.md#düzenleme-faz-252
//
//   start(id) → store'da taslak (asıl kaydın kopyası) → tutamaçlar
//   tutamaca tıkla → (imleç: canlı önizleme) → tıkla bırak → taslak güncellenir (geri alınabilir)
//   save()    → FeatureActions.update (bayrak + beforeUpdate) → onayda taslak kalkar
//   cancel()  → taslak atılır
//
// Düzenleme sürerken akıştan gelen güncelleme ASIL kaydı değiştirir, taslak yerinde kalır;
// `conflict: true` olur ("başkası değiştirdi"). Kaydetmede `beforeUpdate(next, prev)`:
// `next.rev` düzenlemeye başlanan sürüm, `prev` store'daki güncel hâl — karar backend'in.
// Etkileşim tıklama tabanlı (sürükleme yok), çizim araçlarıyla aynı.

import { ACTION_RESULT, type ActionResult, type FeatureActions } from "../actions/feature-actions";
import type { MapAdapter } from "../adapter/types";
import { MAP_EVENT, type MapEventInput, type MapEventListener, type MapEventType } from "../events/event-router";
import type { Feature } from "../model/feature";
import type { Geometry, LngLat } from "../model/geometry";
import type { MapStore } from "../store/map-store";
import { HANDLE_KIND, handlesOf, moveHandle, removeHandle, type Handle } from "./handles";

/** Tutamaç seçme yarıçapı (px). */
const PICK_PX = 10;

export type EditControllerOptions = {
  store: MapStore;
  actions: FeatureActions;
  events: {
    on(type: MapEventType, listener: MapEventListener): () => void;
    emit(event: MapEventInput): void;
  };
  adapter: Pick<MapAdapter, "setDrawMode" | "setDrawPreview" | "project">;
};

export type EditError = "rejected" | "denied" | "failed";

export type EditState = {
  readonly featureId: string;
  readonly hint: string;
  /** Bir tutamaç tutuluyor. */
  readonly picked: boolean;
  readonly canUndo: boolean;
  /** Taslak asıl kayıttan farklı (kaydedilecek bir şey var). */
  readonly dirty: boolean;
  /** Düzenleme sürerken asıl kayıt değişti ("başkası değiştirdi"). */
  readonly conflict: boolean;
  /** Unsur düzenleme sürerken silindi: kaydedilemez. */
  readonly deleted: boolean;
  readonly saving: boolean;
  /** Son kaydetme denemesinin hatası. */
  readonly error: EditError | null;
};

type Session = {
  id: string;
  /** Geri alma yığını (taslak geometrileri); son eleman taslağın şu anki hâli. */
  history: Geometry[];
  picked: Handle | null;
  /** Tutulan tutamaç imleçle taşınırken canlı geometri (henüz taslakta değil). */
  live: Geometry | null;
  saving: boolean;
  error: EditError | null;
  offs: (() => void)[];
};

export class EditController {
  private session: Session | null = null;
  private state: EditState | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: EditControllerOptions) {}

  get isEditing(): boolean {
    return this.session !== null;
  }

  /** Düzenlemeyi başlatır. İzin yoksa, unsur yoksa / bekliyorsa veya geometrisi düzenlenemiyorsa `false`. */
  start(id: string): boolean {
    const { store, actions, events, adapter } = this.options;
    const feature = store.getFeature(id);
    if (!feature || !actions.canEdit(id) || actions.isPending(id)) return false;
    if (handlesOf(feature.geometry).length === 0) return false;
    this.cancel();

    const session: Session = { id, history: [feature.geometry], picked: null, live: null, saving: false, error: null, offs: [] };
    this.session = session;
    store.transaction((tx) => tx.setDraft(feature));
    session.offs.push(
      events.on(MAP_EVENT.CLICK, (e) => e.coord && this.click(e.coord)),
      events.on(MAP_EVENT.POINTER_MOVE, (e) => e.coord && this.move(e.coord)),
      store.subscribeFeature(id, () => this.render()), // akış güncellemesi / silme → çakışma durumu
    );
    adapter.setDrawMode(true);
    this.render();
    return true;
  }

  async save(): Promise<ActionResult | null> {
    const session = this.session;
    if (!session || session.saving) return null;
    const { store, actions } = this.options;
    const draft = store.getDraft(session.id);
    if (!draft) {
      this.render();
      return ACTION_RESULT.MISSING;
    }
    session.picked = null;
    session.live = null;
    session.saving = true;
    session.error = null;
    this.render();
    try {
      // `next.rev` = düzenlemeye başlanan sürüm (backend çakışmayı buna göre anlar).
      const next: Feature = { ...draft.feature, rev: draft.base.rev };
      const result = await actions.update(next);
      if (this.session !== session) return result; // bu arada iptal / yeni düzenleme
      session.saving = false;
      if (result === ACTION_RESULT.DONE) this.end();
      else {
        session.error = result === ACTION_RESULT.DENIED ? "denied" : result === ACTION_RESULT.REJECTED ? "rejected" : null;
        this.render();
      }
      return result;
    } catch (error) {
      if (this.session === session) {
        session.saving = false;
        session.error = "failed";
        this.render();
      }
      throw error;
    }
  }

  cancel(): void {
    this.end();
  }

  /** Son adımı geri alır (tutulan tutamaç varsa önce onu bırakır). */
  undo(): void {
    const session = this.session;
    if (!session || session.saving) return;
    if (session.picked) {
      session.picked = null;
      session.live = null;
    } else if (session.history.length > 1) {
      session.history.pop();
      this.writeDraft(session.history[session.history.length - 1]!);
    }
    this.render();
  }

  /** Esc: tutmayı bırak, yoksa iptal. Enter: kaydet. Backspace / Delete: tutulan köşeyi sil, yoksa geri al. */
  key(key: string): boolean {
    const session = this.session;
    if (!session) return false;
    if (key === "Escape") {
      if (session.picked) {
        session.picked = null;
        session.live = null;
        this.render();
      } else this.cancel();
    } else if (key === "Enter") {
      void this.save().catch(() => {}); // hata durumda (state.error); kaydı çağıran isterse save()'i kendisi bekler
    } else if (key === "Backspace" || key === "Delete") {
      if (session.picked?.kind === HANDLE_KIND.VERTEX) this.removePicked();
      else this.undo();
    } else return false;
    return true;
  }

  getState(): EditState | null {
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

  // ── Etkileşim ──────────────────────────────────────────────────

  private click(coord: LngLat): void {
    const session = this.session;
    if (!session || session.saving || !this.current()) return;
    if (session.picked) {
      const moved = moveHandle(this.current()!, session.picked.id, coord);
      session.picked = null;
      session.live = null;
      if (moved) this.commit(moved);
      else this.render();
      return;
    }
    const handle = this.pick(coord);
    if (!handle) return;
    session.picked = handle;
    session.live = null;
    this.render();
  }

  private move(coord: LngLat): void {
    const session = this.session;
    if (!session?.picked || session.saving) return;
    const current = this.current();
    session.live = current ? (moveHandle(current, session.picked.id, coord) ?? session.live) : null;
    this.render();
  }

  private removePicked(): void {
    const session = this.session!;
    const current = this.current();
    const next = current && session.picked ? removeHandle(current, session.picked.id) : null;
    session.picked = null;
    session.live = null;
    if (next) this.commit(next);
    else this.render();
  }

  /** En yakın tutamaç (ekranda PICK_PX içinde); köşeler ara noktalardan önceliklidir. */
  private pick(coord: LngLat): Handle | null {
    const at = this.options.adapter.project(coord);
    if (!at) return null;
    let best: { handle: Handle; d: number } | null = null;
    for (const handle of handlesOf(this.current()!)) {
      const p = this.options.adapter.project(handle.coord);
      if (!p) continue;
      const d = Math.hypot(p.x - at.x, p.y - at.y) + (handle.kind === HANDLE_KIND.MIDPOINT ? 0.5 : 0);
      if (d <= PICK_PX && (!best || d < best.d)) best = { handle, d };
    }
    return best?.handle ?? null;
  }

  // ── Taslak ─────────────────────────────────────────────────────

  /** Taslağın şu anki geometrisi. */
  private current(): Geometry | null {
    const session = this.session;
    return session ? (session.history[session.history.length - 1] ?? null) : null;
  }

  private commit(geometry: Geometry): void {
    this.session!.history.push(geometry);
    this.writeDraft(geometry);
    this.render();
  }

  private writeDraft(geometry: Geometry): void {
    const { store } = this.options;
    const draft = store.getDraft(this.session!.id);
    if (!draft) return; // unsur silinmiş
    store.transaction((tx) => tx.setDraft({ ...draft.feature, geometry }));
  }

  private end(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    for (const off of session.offs) off();
    this.options.store.transaction((tx) => tx.clearDraft(session.id));
    this.options.adapter.setDrawPreview(null);
    this.options.adapter.setDrawMode(false);
    this.setState(null);
  }

  // ── Görünüm ────────────────────────────────────────────────────

  private render(): void {
    const session = this.session;
    if (!session) return;
    const { store, adapter } = this.options;
    const stored = store.getFeature(session.id);
    const draft = store.getDraft(session.id);
    const deleted = !stored;
    const shown = session.live ?? this.current();

    if (deleted || !shown) adapter.setDrawPreview(null);
    else {
      const handles = handlesOf(shown);
      adapter.setDrawPreview({
        // Taslak haritada asıl unsurun yerine çizilir; önizleme yalnız taşınmakta olan hâli gösterir.
        shape: session.live,
        vertices: handles.filter((h) => h.kind !== HANDLE_KIND.MIDPOINT).map((h) => h.coord),
        midpoints: session.picked ? [] : handles.filter((h) => h.kind === HANDLE_KIND.MIDPOINT).map((h) => h.coord),
        guides: [],
        active: session.picked ? (session.live ? handles.find((h) => h.id === session.picked!.id)?.coord ?? null : session.picked.coord) : null,
      });
    }

    this.setState({
      featureId: session.id,
      hint: deleted
        ? "Unsur silindi; düzenleme kaydedilemez."
        : session.saving
          ? "Kaydediliyor…"
          : session.picked
            ? "Yeni konuma tıklayın (Esc: bırak, Backspace: köşeyi sil)."
            : "Taşımak için bir tutamaca tıklayın; ara noktalar yeni köşe ekler.",
      picked: session.picked !== null,
      canUndo: session.picked !== null || session.history.length > 1,
      dirty: session.history.length > 1,
      conflict: !deleted && draft !== undefined && stored !== draft.base,
      deleted,
      saving: session.saving,
      error: session.error,
    });
  }

  private setState(next: EditState | null): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
