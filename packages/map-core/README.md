# @c2/map-core

Motor- ve framework-bağımsız harita çekirdeği. Hiçbir harita motorunu (MapLibre, deck.gl, Cesium)
ve React'i import etmez; testleri Node'da koşar. Tasarım: [`plan/`](../../plan/README.md).

```
Backend → MapStore → MapSync → [sunum aşamaları] → MapAdapter (motor)
                                                      │ hit-test
                              EventRouter ◄───────────┘
```

| Parça | Görevi |
|---|---|
| `createMapStore()` | Tek doğruluk kaynağı: katman, altlık, unsur, seçim, hover. Transaction, değişiklik günlüğü, id bazlı abonelik |
| `MapSync` | Store değişikliklerini kare başına tek `RenderBatch`'e çevirir (efektif görünürlük / opaklık / sıra / grup) |
| `EventRouter` | Adapter'ın olaylarını unsur → katman zinciri → global sırasıyla dağıtır |
| `MapAdapter` | Motorların uyguladığı sözleşme (`@c2/map-maplibre` …); test için `MockAdapter` |
| Registry'ler | `FeatureKindRegistry`, `BasemapProviderRegistry`, `SymbologyRegistry` |

## Kullanım

```ts
import {
  BasemapProviderRegistry, EventRouter, FeatureKindRegistry, GEOMETRY_KIND, MAP_EVENT,
  MapSync, MockAdapter, SymbologyRegistry, createMapStore,
} from "@c2/map-core";

const store = createMapStore();
const events = new EventRouter(store);
const adapter = new MockAdapter(); // gerçek uygulamada: await createMaplibreAdapter(...)

await adapter.mount(container, {
  initialView: { center: [32.85, 39.9], zoom: 6 },
  events,
  kinds: new FeatureKindRegistry(),
  symbology: new SymbologyRegistry(),
  basemapProviders: new BasemapProviderRegistry(),
});

const sync = new MapSync({ store, adapter }); // varsayılan: rAF + en fazla 10 Hz
sync.start();

// Canlı akış: her WS paketi tek transaction
store.transaction((tx) => {
  tx.upsertLayers([{ id: "birlikler", name: "Birlikler", parentId: null, visible: true, opacity: 1 }]);
  tx.upsertFeatures([
    { id: "u1", layerId: "birlikler", kind: "milsym", geometry: { kind: GEOMETRY_KIND.POINT, coord: [32.85, 39.9] } },
  ]);
});
store.transaction((tx) => tx.patchFeatures([{ id: "u1", geometry: { kind: GEOMETRY_KIND.POINT, coord: [32.9, 39.9] }, rev: 2 }]));

// Yeniden bağlanma: katmanı snapshot ile eşitle (diğer katmanlara dokunmaz)
store.transaction((tx) => tx.replaceLayerContents("birlikler", snapshot));

// Olaylar: yalnız ilgilenilen unsur / katman
events.on(MAP_EVENT.CLICK, (e) => console.log("birlik tıklandı", e.featureId), { layerId: "birlikler" });

// UI aboneliği: yalnız bu unsur değişince
const off = store.subscribeFeature("u1", () => render(store.getFeature("u1")));
```

## Kurallar

- Store'a verilen nesneler **değişmez** kabul edilir; değişiklik referans karşılaştırmasıyla algılanır.
- Tüm yazmalar `store.transaction(tx => …)` içinden; bildirimler en dıştaki transaction bitince gider.
- `meta` alanı haritaya gitmez; yalnız `meta` değişirse adapter hiçbir şey almaz.

## Komutlar

```
pnpm --filter @c2/map-core test
pnpm --filter @c2/map-core typecheck
```
