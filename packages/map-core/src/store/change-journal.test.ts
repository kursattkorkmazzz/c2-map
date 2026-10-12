import { beforeEach, describe, expect, it } from "vitest";
import {
  CHANGE_OP,
  FEATURE_CHANGE,
  FEATURE_CHANGE_ALL,
  LAYER_CHANGE,
  LAYER_CHANGE_ALL,
} from "./change";
import { ChangeJournal, ENTITY_KIND } from "./change-journal";

const { ADD, UPDATE, REMOVE } = CHANGE_OP;
const { FEATURE, LAYER, BASEMAP } = ENTITY_KIND;
const { GEOMETRY, STYLE, META } = FEATURE_CHANGE;

let journal: ChangeJournal;
beforeEach(() => {
  journal = new ChangeJournal();
});

/** Unsurun drain sonrası kaydı. */
const featureChange = (id: string) => journal.drain().features.get(id);

describe("birleştirme tablosu (plan/design/03-store.md)", () => {
  it("(yok) → ADD: tüm bitlerle ADD", () => {
    journal.record(FEATURE, "a", ADD, GEOMETRY);
    expect(featureChange("a")).toEqual({ op: ADD, mask: FEATURE_CHANGE_ALL });
  });

  it("(yok) → UPDATE: verilen maskeyle UPDATE", () => {
    journal.record(FEATURE, "a", UPDATE, GEOMETRY);
    expect(featureChange("a")).toEqual({ op: UPDATE, mask: GEOMETRY });
  });

  it("(yok) → REMOVE: maskesiz REMOVE", () => {
    journal.record(FEATURE, "a", REMOVE, GEOMETRY);
    expect(featureChange("a")).toEqual({ op: REMOVE, mask: 0 });
  });

  it("ADD → UPDATE: ADD kalır (son haliyle eklenir)", () => {
    journal.record(FEATURE, "a", ADD);
    journal.record(FEATURE, "a", UPDATE, GEOMETRY);
    expect(featureChange("a")).toEqual({ op: ADD, mask: FEATURE_CHANGE_ALL });
  });

  it("ADD → REMOVE: kayıt tamamen silinir", () => {
    journal.record(FEATURE, "a", ADD);
    journal.record(FEATURE, "a", REMOVE);
    const changes = journal.drain();
    expect(changes.features.has("a")).toBe(false);
    expect(changes.features.size).toBe(0);
  });

  it("UPDATE → UPDATE: maskeler OR'lanır", () => {
    journal.record(FEATURE, "a", UPDATE, GEOMETRY);
    journal.record(FEATURE, "a", UPDATE, STYLE);
    expect(featureChange("a")).toEqual({ op: UPDATE, mask: GEOMETRY | STYLE });
  });

  it("UPDATE → UPDATE (10 kez): tek kayıt", () => {
    for (let i = 0; i < 10; i++) journal.record(FEATURE, "a", UPDATE, GEOMETRY);
    const changes = journal.drain();
    expect(changes.features.size).toBe(1);
    expect(changes.features.get("a")).toEqual({ op: UPDATE, mask: GEOMETRY });
  });

  it("UPDATE → REMOVE: REMOVE", () => {
    journal.record(FEATURE, "a", UPDATE, GEOMETRY);
    journal.record(FEATURE, "a", REMOVE);
    expect(featureChange("a")).toEqual({ op: REMOVE, mask: 0 });
  });

  it("REMOVE → ADD: tüm bitlerle UPDATE", () => {
    journal.record(FEATURE, "a", REMOVE);
    journal.record(FEATURE, "a", ADD);
    expect(featureChange("a")).toEqual({ op: UPDATE, mask: FEATURE_CHANGE_ALL });
  });

  it("REMOVE → REMOVE: REMOVE", () => {
    journal.record(FEATURE, "a", REMOVE);
    journal.record(FEATURE, "a", REMOVE);
    expect(featureChange("a")).toEqual({ op: REMOVE, mask: 0 });
  });

  it("REMOVE → ADD → UPDATE: tüm bitlerle UPDATE", () => {
    journal.record(FEATURE, "a", REMOVE);
    journal.record(FEATURE, "a", ADD);
    journal.record(FEATURE, "a", UPDATE, GEOMETRY);
    expect(featureChange("a")).toEqual({ op: UPDATE, mask: FEATURE_CHANGE_ALL });
  });

  it("ADD → REMOVE → ADD: ADD", () => {
    journal.record(FEATURE, "a", ADD);
    journal.record(FEATURE, "a", REMOVE);
    journal.record(FEATURE, "a", ADD);
    expect(featureChange("a")).toEqual({ op: ADD, mask: FEATURE_CHANGE_ALL });
  });

  it("maskesi 0 olan UPDATE kayıt oluşturmaz", () => {
    journal.record(FEATURE, "a", UPDATE, 0);
    expect(journal.isEmpty).toBe(true);
  });

  it("yalnız META değişikliği de kaydedilir (filtreyi MapSync yapar)", () => {
    journal.record(FEATURE, "a", UPDATE, META);
    expect(featureChange("a")).toEqual({ op: UPDATE, mask: META });
  });
});

describe("varlık türleri", () => {
  it("türler birbirinden ayrı tutulur (aynı id çakışmaz)", () => {
    journal.record(FEATURE, "x", UPDATE, GEOMETRY);
    journal.record(LAYER, "x", UPDATE, LAYER_CHANGE.VISIBLE);
    journal.record(BASEMAP, "x", REMOVE);
    const changes = journal.drain();
    expect(changes.features.get("x")).toEqual({ op: UPDATE, mask: GEOMETRY });
    expect(changes.layers.get("x")).toEqual({ op: UPDATE, mask: LAYER_CHANGE.VISIBLE });
    expect(changes.basemaps.get("x")).toEqual({ op: REMOVE, mask: 0 });
  });

  it("ADD her türün kendi tüm bitlerini kullanır", () => {
    journal.record(LAYER, "l", ADD);
    expect(journal.drain().layers.get("l")).toEqual({ op: ADD, mask: LAYER_CHANGE_ALL });
  });
});

describe("yapı, seçim, hover", () => {
  it("markStructure", () => {
    journal.markStructure();
    expect(journal.drain().structure).toBe(true);
  });

  it("seçim: tek dönüş listede, çift dönüş (net değişiklik yok) listeden çıkar", () => {
    journal.flipSelection("a");
    journal.flipSelection("b");
    journal.flipSelection("b");
    expect([...journal.drain().selection]).toEqual(["a"]);
  });

  it("hover: ilk prev korunur, son next alınır", () => {
    journal.recordHover(null, "a");
    journal.recordHover("a", "b");
    journal.recordHover("b", "c");
    expect(journal.drain().hover).toEqual({ prev: null, next: "c" });
  });

  it("hover: başa dönerse kayıt silinir", () => {
    journal.recordHover("a", "b");
    journal.recordHover("b", "a");
    expect(journal.drain().hover).toBeNull();
  });

  it("hover: prev === next kayıt oluşturmaz", () => {
    journal.recordHover("a", "a");
    expect(journal.isEmpty).toBe(true);
  });
});

describe("drain", () => {
  it("boş günlük isEmpty", () => {
    expect(journal.isEmpty).toBe(true);
  });

  it("drain günlüğü sıfırlar", () => {
    journal.record(FEATURE, "a", UPDATE, GEOMETRY);
    journal.markStructure();
    journal.flipSelection("a");
    journal.recordHover(null, "a");
    expect(journal.isEmpty).toBe(false);

    journal.drain();
    expect(journal.isEmpty).toBe(true);
    const empty = journal.drain();
    expect(empty.features.size).toBe(0);
    expect(empty.structure).toBe(false);
    expect(empty.selection.size).toBe(0);
    expect(empty.hover).toBeNull();
  });

  it("drain sonrası yazmalar önceki ChangeSet'i etkilemez", () => {
    journal.record(FEATURE, "a", UPDATE, GEOMETRY);
    const first = journal.drain();
    journal.record(FEATURE, "b", UPDATE, STYLE);
    expect(first.features.size).toBe(1);
    expect(first.features.has("b")).toBe(false);
  });

  it("birden fazla yazma dalgası tek drain'de birleşir", () => {
    journal.record(FEATURE, "a", ADD);
    journal.record(FEATURE, "b", UPDATE, GEOMETRY);
    journal.record(FEATURE, "b", UPDATE, STYLE);
    journal.record(FEATURE, "c", UPDATE, GEOMETRY);
    journal.record(FEATURE, "c", REMOVE);
    const changes = journal.drain();
    expect(Object.fromEntries(changes.features)).toEqual({
      a: { op: ADD, mask: FEATURE_CHANGE_ALL },
      b: { op: UPDATE, mask: GEOMETRY | STYLE },
      c: { op: REMOVE, mask: 0 },
    });
  });
});
