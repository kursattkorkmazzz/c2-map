// @c2/map-core — motor- ve framework-bağımsız harita çekirdeği.
// Genel API buradan dışa aktarılır; her alt klasörün index.ts'i neyin açık olduğunu belirler.
// (Genel API'nin kapsamı `api.test.ts` ile korunur.)

export * from "./model/index";
export * from "./store/index";
export * from "./events/index";
export * from "./registry/index";
export * from "./adapter/index";
export * from "./sync/index";
export * from "./ingest/index";
