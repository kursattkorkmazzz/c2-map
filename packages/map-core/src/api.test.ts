// Genel API koruması: paketin dışa açtığı çalışma zamanı değerleri bilinçli olarak değişmeli.
// Yeni bir şey dışa açılınca veya kapatılınca bu liste de güncellenir.

import { describe, expect, it } from "vitest";
import * as api from "./index";

describe("@c2/map-core genel API", () => {
  it("dışa açılan değerler", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        // model
        "BASEMAP_SOURCE",
        "GEOMETRY_KIND",
        // cluster
        "CLUSTER_KIND",
        "ClusterStage",
        "clusterBadge",
        "clusterBadgeSize",
        "clusterLabel",
        "bindClusterEvents",
        "isClusterSource",
        "ALTITUDE_REF",
        "interpolateUav",
        "uavPropsOf",
        // store
        "BASEMAP_CHANGE",
        "BASEMAP_CHANGE_ALL",
        "CHANGE_OP",
        "FEATURE_CHANGE",
        "FEATURE_CHANGE_ALL",
        "FEATURE_CHANGE_VISUAL",
        "LAYER_CHANGE",
        "LAYER_CHANGE_ALL",
        "SELECT_MODE",
        "createMapStore",
        // events
        "CLUSTER_ID_PREFIX",
        "EventRouter",
        "MAP_EVENT",
        "isSyntheticId",
        // registry
        "BasemapProviderRegistry",
        "FeatureKindRegistry",
        "SymbologyRegistry",
        "geometryBounds",
        "isCustomSource",
        // adapter
        "MOCK_CAPABILITIES",
        "MockAdapter",
        "RENDER_CHANGE",
        "RENDER_CHANGE_ALL",
        "isEmptyBatch",
        // sync
        "MapSync",
        "Z_LAYER_STRIDE",
        "createFrameScheduler",
        "createManualScheduler",
        "runStages",
        // ingest
        "STREAM_FORMAT",
        "createLayerStream",
        "IngestEngine",
        "applyIngestPacket",
        "canMergePatches",
        "connectIngestWorker",
        "featureDelta",
        "mergePatches",
        "runIngestWorker",
        // actions
        "ACTION_RESULT",
        "FeatureActions",
        // edit
        "EditController",
        "HANDLE_KIND",
        "handlesOf",
        "moveHandle",
        "removeHandle",
        // draw
        "DRAW_TOOL",
        "DrawController",
        "EMPTY_PREVIEW",
        "createDrawTool",
        "distanceToPolyline",
        // geo
        "corridorRing",
        "ellipseRing",
        "shapeRings",
        "sensorFootprint",
        "COORD_FORMAT",
        "HEMISPHERES",
        "UTM_BANDS",
        "UTM_MAX_LAT",
        "UTM_MIN_LAT",
        "bearing",
        "destination",
        "distance",
        "formatAngle",
        "formatArea",
        "formatCoordinate",
        "formatDistance",
        "formatUtm",
        "fromUtm",
        "geodesicCircle",
        "isNorthernBand",
        "lineLength",
        "parseCoordinate",
        "parseMgrs",
        "parseUtm",
        "polygonArea",
        "ringPerimeter",
        "toMgrs",
        "toUtm",
        "utmBand",
        "utmZone",
      ].sort(),
    );
  });

  it("iç ayrıntılar dışa açılmaz", () => {
    for (const internal of [
      "ChangeJournal",
      "coalesce",
      "ENTITY_KIND",
      "diffFeature",
      "mergeFeaturePatch",
      "shallowMerge",
      "deepEqual",
      "stabilizeFeature",
      "Registry",
      "LayerResolver",
    ]) {
      expect(api).not.toHaveProperty(internal);
    }
  });

  it("uçtan uca kullanım: store + router + MapSync + MockAdapter yalnız genel API ile kurulabilir", async () => {
    const store = api.createMapStore();
    const router = new api.EventRouter(store);
    const adapter = new api.MockAdapter();
    const scheduler = api.createManualScheduler();
    await adapter.mount({} as HTMLElement, {
      initialView: { center: [32.85, 39.9], zoom: 6 },
      events: router,
      kinds: new api.FeatureKindRegistry(),
      symbology: new api.SymbologyRegistry(),
      basemapProviders: new api.BasemapProviderRegistry(),
    });
    const sync = new api.MapSync({ store, adapter, scheduler });
    sync.start();

    store.transaction((tx) => {
      tx.upsertLayers([{ id: "birlikler", name: "Birlikler", parentId: null, visible: true, opacity: 1 }]);
      tx.upsertFeatures([
        { id: "u1", layerId: "birlikler", kind: "milsym", geometry: { kind: api.GEOMETRY_KIND.POINT, coord: [32.85, 39.9] } },
      ]);
    });
    scheduler.run();
    expect([...adapter.features.keys()]).toEqual(["u1"]);

    const clicked: string[] = [];
    router.on(api.MAP_EVENT.CLICK, (e) => clicked.push(e.featureId ?? ""), { layerId: "birlikler" });
    adapter.emit({ type: api.MAP_EVENT.CLICK, featureId: "u1" });
    expect(clicked).toEqual(["u1"]);
  });
});
