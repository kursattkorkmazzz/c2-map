import { beforeEach, describe, expect, it } from "vitest";
import { BASEMAP_SOURCE, type Basemap } from "../model/basemap";
import { BASEMAP_CHANGE, BASEMAP_CHANGE_ALL, CHANGE_OP } from "./change";
import { createMapStore, type MapStore, type MapTx } from "./map-store";

const { ADD, UPDATE, REMOVE } = CHANGE_OP;

const basemap = (id: string, over: Partial<Basemap> = {}): Basemap => ({
  id,
  name: id,
  source: { type: BASEMAP_SOURCE.XYZ, urlTemplate: `https://${id}/{z}/{x}/{y}.png` },
  visible: false,
  opacity: 1,
  order: 0,
  ...over,
});

let store: MapStore;
const write = (fn: (tx: MapTx) => void) => store.transaction(fn);
const ids = () => store.getBasemaps().map((b) => b.id);
const visible = () => store.getBasemaps().filter((b) => b.visible).map((b) => b.id);

beforeEach(() => {
  store = createMapStore({ now: () => 0 });
});

describe("upsertBasemaps / patchBasemap / removeBasemaps", () => {
  it("ekleme → ADD (tüm bitler); katman ağacını etkilemez", () => {
    write((tx) => tx.upsertBasemaps([basemap("osm")]));
    const changes = store.drainChanges();
    expect(changes.basemaps.get("osm")).toEqual({ op: ADD, mask: BASEMAP_CHANGE_ALL });
    expect(changes.structure).toBe(false);
    expect(store.getBasemap("osm")?.name).toBe("osm");
  });

  it("güncelleme → yalnız değişen bitler; değişiklik yoksa referans aynı", () => {
    const osm = basemap("osm");
    write((tx) => tx.upsertBasemaps([osm]));
    store.drainChanges();

    write((tx) => tx.upsertBasemaps([{ ...osm }]));
    expect(store.getBasemap("osm")).toBe(osm);
    expect(store.drainChanges().basemaps.size).toBe(0);

    write((tx) => tx.patchBasemap("osm", { opacity: 0.4 }));
    expect(store.drainChanges().basemaps.get("osm")).toEqual({ op: UPDATE, mask: BASEMAP_CHANGE.OPACITY });
  });

  it("olmayan id'ye patch → yok sayılır, sayaç artar", () => {
    write((tx) => tx.patchBasemap("yok", { visible: true }));
    expect(store.stats.ignoredPatches).toBe(1);
    expect(store.drainChanges().basemaps.size).toBe(0);
  });

  it("silme → REMOVE; olmayan id sessizce yok sayılır", () => {
    write((tx) => tx.upsertBasemaps([basemap("osm")]));
    store.drainChanges();
    write((tx) => tx.removeBasemaps(["osm", "yok"]));
    expect(store.getBasemap("osm")).toBeUndefined();
    expect(Object.fromEntries(store.drainChanges().basemaps)).toEqual({ osm: { op: REMOVE, mask: 0 } });
  });
});

describe("getBasemaps sırası ve önbellek", () => {
  it("order'a göre artan; eşitlikte ekleme sırası", () => {
    write((tx) =>
      tx.upsertBasemaps([
        basemap("ust", { order: 2 }),
        basemap("alt", { order: 0 }),
        basemap("orta-1", { order: 1 }),
        basemap("orta-2", { order: 1 }),
      ]),
    );
    expect(ids()).toEqual(["alt", "orta-1", "orta-2", "ust"]);
  });

  it("order değişince yeniden sıralanır", () => {
    write((tx) => tx.upsertBasemaps([basemap("a", { order: 0 }), basemap("b", { order: 1 })]));
    write((tx) => tx.patchBasemap("a", { order: 5 }));
    expect(ids()).toEqual(["b", "a"]);
  });

  it("değişiklik yokken aynı dizi referansı; değişince yeni dizi", () => {
    write((tx) => tx.upsertBasemaps([basemap("a")]));
    const first = store.getBasemaps();
    expect(store.getBasemaps()).toBe(first);

    write((tx) => tx.patchBasemap("a", { opacity: 1 })); // değişiklik yok
    expect(store.getBasemaps()).toBe(first);

    write((tx) => tx.patchBasemap("a", { opacity: 0.5 }));
    expect(store.getBasemaps()).not.toBe(first);
  });

  it("boşken boş dizi", () => {
    expect(store.getBasemaps()).toEqual([]);
  });
});

describe("exclusiveGroup (radyo davranışı)", () => {
  beforeEach(() => {
    write((tx) =>
      tx.upsertBasemaps([
        basemap("uydu-a", { exclusiveGroup: "uydu", visible: true }),
        basemap("uydu-b", { exclusiveGroup: "uydu" }),
        basemap("sokak", { exclusiveGroup: "vektor", visible: true }),
        basemap("ortofoto", { visible: true }), // grupsuz
      ]),
    );
    store.drainChanges();
  });

  it("gruptan biri açılınca diğeri kapanır; başka gruplar ve grupsuzlar etkilenmez", () => {
    write((tx) => tx.patchBasemap("uydu-b", { visible: true }));
    expect(visible().sort()).toEqual(["ortofoto", "sokak", "uydu-b"]);

    const changes = store.drainChanges();
    expect(changes.basemaps.get("uydu-a")).toEqual({ op: UPDATE, mask: BASEMAP_CHANGE.VISIBLE });
    expect(changes.basemaps.get("uydu-b")).toEqual({ op: UPDATE, mask: BASEMAP_CHANGE.VISIBLE });
    expect(changes.basemaps.has("sokak")).toBe(false);
  });

  it("kapatmak diğerlerini açmaz", () => {
    write((tx) => tx.patchBasemap("uydu-a", { visible: false }));
    expect(visible().sort()).toEqual(["ortofoto", "sokak"]);
  });

  it("görünür olarak eklenen yeni altlık grubundakini kapatır", () => {
    write((tx) => tx.upsertBasemaps([basemap("uydu-c", { exclusiveGroup: "uydu", visible: true })]));
    expect(store.getBasemap("uydu-a")?.visible).toBe(false);
    expect(store.getBasemap("uydu-c")?.visible).toBe(true);
  });

  it("aynı pakette iki görünür → sonuncu kazanır", () => {
    write((tx) =>
      tx.upsertBasemaps([
        basemap("uydu-b", { exclusiveGroup: "uydu", visible: true }),
        basemap("uydu-c", { exclusiveGroup: "uydu", visible: true }),
      ]),
    );
    expect(visible().filter((id) => id.startsWith("uydu"))).toEqual(["uydu-c"]);
  });

  it("görünürken başka gruba geçen altlık yeni grubundakini kapatır", () => {
    write((tx) => tx.patchBasemap("ortofoto", { exclusiveGroup: "vektor" }));
    expect(store.getBasemap("sokak")?.visible).toBe(false);
    expect(store.getBasemap("ortofoto")?.visible).toBe(true);
  });

  it("görünürlüğü değişmeyen güncelleme grubu etkilemez", () => {
    write((tx) => tx.patchBasemap("uydu-a", { opacity: 0.5 }));
    expect(store.getBasemap("sokak")?.visible).toBe(true);
    expect(store.drainChanges().basemaps.size).toBe(1);
  });

  it("kapatılan altlığın eski nesnesi değişmez", () => {
    const before = store.getBasemap("uydu-a")!;
    write((tx) => tx.patchBasemap("uydu-b", { visible: true }));
    expect(before.visible).toBe(true);
    expect(store.getBasemap("uydu-a")).not.toBe(before);
  });
});
