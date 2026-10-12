# 03 — MapStore

← [Plan ana sayfası](../README.md) · Faz: [0.2](../phases/phase-0-core.md#02-mapstore) · Kod: `packages/map-core/src/store/`

`MapStore` çekirdeğin tek doğruluk kaynağıdır: katmanlar, altlıklar, unsurlar, seçim, hover.
Harita (MapSync üzerinden) ve UI (React hook'ları, LayerTree) bu store'un aboneleridir.

## Gereksinimler

1. Framework-bağımsız (React'siz, DOM'suz; testler Node'da koşar).
2. **Id bazlı abonelik:** 50k unsur güncellenirken yalnız ilgili id'ye bakan dinleyici çalışmalı.
3. **Değişiklik günlüğü:** MapSync "son flush'tan beri ne değişti?" sorusunu O(değişen) sürede bilmeli.
4. **Toplu transaction:** 1 WS paketi = 1 bildirim dalgası.
5. Değişen varlık için **yeni referans** (React seçicileri `Object.is` ile çalışsın), ama
   koleksiyonun tamamını kopyalamadan.

## Neden zustand değil

| Seçenek                           | Artı                                                                                                | Eksi                                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zustand (immutable, tek state)    | Bilinen, küçük, devtools, `zustand/vanilla` React'siz çalışır                                       | Her güncellemede `{...features}` kopyası O(n); her `set` tüm dinleyicileri çağırır; değişiklik günlüğü yok → MapSync her flush'ta tüm unsurları karşılaştırmak zorunda |
| zustand + `subscribeWithSelector` | Seçici bazlı abonelik                                                                               | Seçiciler yine her `set`'te çalışır (O(abone)); günlük sorunu aynı                                                                                                     |
| **Amaca özel `MapStore`** ✅      | `Map` yerinde güncellenir, varlıklar yeni referans; id bazlı dinleyici; günlük yerleşik; O(değişen) | Kendi kodumuz (~400–500 satır + test)                                                                                                                                  |
| headless-tree state merkezli      | Ağaç zaten orada                                                                                    | UI-ağaç kütüphanesi; canlı veri ve harita senkronu için tasarlanmamış                                                                                                  |

zustand yalnız **uygulama UI durumu** için kullanılır (aktif araç, panel durumu, filtreler,
koordinat formatı, harita ayarları). headless-tree yalnız ağaç UI durumunu tutar ([06](06-layer-tree.md)).

## İç veri yapıları

| Yapı                | Tip                                        | Amaç                                               |
| ------------------- | ------------------------------------------ | -------------------------------------------------- |
| `features`          | `Map<id, Feature>`                         | O(1) erişim                                        |
| `layers`            | `Map<id, Layer>`                           | O(1) erişim                                        |
| `basemaps`          | `Map<id, Basemap>`                         | O(1) erişim                                        |
| `childLayerIds`     | `Map<parentId \| null, readonly string[]>` | Kardeş katman sırası (kök: `null`)                 |
| `featureIdsByLayer` | `Map<layerId, Set<featureId>>`             | Katmanın unsurları, sayaç, katman silme            |
| `selection`         | `ReadonlySet<featureId>`                   | Seçili unsurlar                                    |
| `hovered`           | `featureId \| null`                        | Fare altındaki unsur                               |
| `updatedAt`         | `Map<featureId, number>`                   | Bayatlık (stale) hesabı için son güncelleme zamanı |
| `journal`           | `ChangeJournal`                            | MapSync için değişiklik günlüğü (aşağıda)          |

### Değişmezlik kuralı

- Store'a verilen ve store'dan okunan varlıklar **değişmez** kabul edilir. Kimse
  `store.getFeature(id).geometry.coord[0] = …` yapmaz.
- Bir varlık değişince store **yeni nesne** üretir (`{ ...eski, ...yama }`); `Map` içindeki
  kayıt yeni nesneyle değiştirilir. Koleksiyon kopyalanmaz.
- Değişiklik maskesi alanların **referans karşılaştırmasıyla** (`Object.is`) bulunur. Yeni
  ama içeriği aynı bir `style` nesnesi de "değişti" sayılır (temkinli; adapter'ın diff'i bunu yakalar).
- `childLayerIds` dizileri ve `selection` kümesi de değişince **yeni referans** olur
  (React `useSyncExternalStore` bunlara güvenir).

## Transaction API

Tüm yazmalar `store.transaction(tx => …)` içinden yapılır. Bir transaction bittiğinde
abonelere **tek bir bildirim dalgası** gider.

```ts
store.transaction((tx) => {
  tx.upsertFeatures(features); // tam nesne: yoksa ekle, varsa değiştir
  tx.patchFeatures([{ id, geometry }]); // kısmi: yalnız gelen alanlar
  tx.removeFeatures(ids);

  tx.upsertLayers(layers);
  tx.patchLayer(id, { visible: false });
  tx.moveLayer(id, newParentId, index);
  tx.removeLayers(ids); // alt ağaçla birlikte (cascade)

  tx.upsertBasemaps(basemaps);
  tx.patchBasemap(id, { opacity: 0.5 });
  tx.removeBasemaps(ids);

  tx.replaceLayerContents(layerId, features); // snapshot: bu katmanı birebir eşitle

  tx.select(ids, "replace" | "add" | "remove" | "toggle");
  tx.clearSelection();
  tx.setHovered(id | null);
});
```

### Transaction kuralları (kod: `store/map-store.ts`)

- `tx` nesnesi yalnız transaction içinde geçerlidir; dışarı kaçırılıp kullanılırsa hata fırlatır.
- `fn` hata fırlatırsa **geri alma yoktur**: o ana kadarki yazmalar kalır, günlüğe yazılmıştır;
  transaction sayacı yine de sıfırlanır (store kullanılabilir kalır).
- Store verilen nesneyi **kopyalamaz**; `getFeature(id)` upsert edilen nesnenin kendisini döner.
- `getFeatureIds(layerId)` kümeyi kopyalamadan döner (50k unsurlu katmanda her eklemede kopya
  O(n²) olurdu). Referans sabit değildir; saklanmaz, değişim abonelikle dinlenip yeniden okunur.
- **`rev` nesneden ayrı tutulur** (`revs` haritası). İçeriği aynı ama `rev`'i yeni bir mesaj
  geldiğinde nesne referansı değişmez (bildirim yok), ama `rev` ilerler; böylece ardından gelen
  eski mesaj yine düşürülür. Bu durumda `getFeature(id).rev` son *görünür* yazmanın `rev`'idir.
- Silinen unsurun `rev`'i unutulur; aynı id yeniden eklenirse `rev` sıfırdan başlar.
- `updatedAt` içerik aynı olsa bile her kabul edilen yazmada güncellenir (mesaj = "unsur hâlâ
  canlı"); `rev` nedeniyle düşürülen yazmada güncellenmez.

### Patch kuralları (kod: `store/diff.ts`)

- Patch'te bir anahtar **varsa** (değeri `undefined` olsa bile) uygulanır: `{ id, hidden: undefined }`
  alanı temizler. Anahtar **yoksa** alana dokunulmaz.
- `style`, `props`, `meta` sığ birleştirilir; birleşimin içeriği eskisiyle aynıysa **eski referans
  korunur** → backend aynı rengi tekrar gönderdiğinde gereksiz `STYLE` biti üretilmez.
- `geometry` ve altlığın `source`'u birleştirilmez, değiştirilir (ayrışık birleşimlerde alan
  karıştırmak geçersiz nesne üretir).
- `id` patch ile değiştirilemez. `kind` değişirse maske tüm bitlerdir (çizici değişir).
  `rev` maskeye katkı yapmaz.

### Unsurlar

- **upsert:** Id yoksa **ekle** (ADD). Varsa alanları eskisiyle karşılaştır, maskeyi hesapla,
  yeni nesneyi yaz (UPDATE). Hiçbir alan değişmediyse günlüğe yazma, bildirim üretme.
- **patch:** Yalnız gelen alanlar değişir. `style`, `props`, `meta` **sığ birleştirilir**
  (`{ ...eski.style, ...yama.style }`) — backend `{ id, style: { color } }` gönderebilsin diye.
  Diğer alanlar (geometry, z, hidden…) doğrudan değiştirilir. Olmayan id'ye patch **yok sayılır**
  (sayaçla raporlanır; patch tam nesne değildir, ekleme yapamaz).
- **remove:** Kaydı, `featureIdsByLayer` girdisini, seçimden ve hover'dan siler (REMOVE).
  Olmayan id sessizce yok sayılır.
- **layerId değişirse:** `featureIdsByLayer` iki katmanda güncellenir, maskeye `LAYER` biti girer.
- **Olmayan katmana ait unsur** (yetim): Kabul edilir ve indekslenir; akışlarda katman bazen
  unsurdan sonra gelir. MapSync yetimi **görünmez** sayar; katman eklenince görünür hale gelir.

### `rev` kuralı (sıra dışı mesajlar)

Gelen kayıtta `rev` varsa ve mevcut kaydın `rev`'i de varsa:
**gelen `rev` ≤ mevcut `rev` → işlem düşürülür** (upsert ve patch için). Düşürülen işlemler
sayaçla raporlanır (`store.stats.droppedStale`). `rev` yoksa her zaman uygulanır.
`replaceLayerContents` snapshot'ı yetkili kabul eder ve `rev` kontrolü yapmaz
(sunucu yeniden başlarsa `rev` sıfırlanabilir).

### Katmanlar

- **upsert:** Yeni katman, ebeveyninin `childLayerIds` listesinin **sonuna** eklenir.
  Var olan katmanda `parentId` değişirse yeni ebeveynin sonuna taşınır.
- **move(id, parentId, index):** Sırayı ve ebeveyni değiştirir. **Döngü kontrolü:** katman
  kendi altına taşınamaz → hata fırlatılır (işlem reddedilir; o transaction'da daha önce yapılan
  yazmalar kalır, bkz. transaction kuralları).
- **remove:** **Cascade**: alt katmanlar ve tüm unsurları da silinir.
- Ağaç şekli değiştiğinde (ekle / sil / taşı) günlükte `structure = true` olur.

Uygulama ayrıntıları (kod: `store/map-store.ts`):

- **Yetim katman** (ebeveyni henüz yok) kabul edilir; `getChildLayerIds(ebeveynId)` altında durur,
  ebeveyn eklenince ağaçta görünür. Yetim unsurlarla aynı mantık.
- **Döngü kontrolü** taşımanın yanı sıra **upsert'te de** yapılır: yetim katmanlar sayesinde yeni
  eklenen bir katman da döngü kurabilir (`b → a` varken `a → b` eklemek). Döngü → hata, işlem
  uygulanmaz (ağaç değişmez).
- **`moveLayer(id, parentId, index)`:** `index` taşımadan *sonraki* konumdur, `[0, kardeş sayısı]`
  aralığına sıkıştırılır, verilmezse sona. Aynı yere taşımak hiçbir şey yapmaz. Olmayan katman → hata
  (UI işlemi; sessizce yutulmamalı). `patchLayer` ise olmayan id'yi yok sayar (akış verisi gibi davranır).
- Kardeşler arası sıra değişiminde günlüğe yalnız **taşınan** katman `PARENT` bitiyle yazılır;
  kardeşlerin sırası `structure = true` olduğu için MapSync tarafından zaten yeniden hesaplanır.
- **Cascade silme** önce çocukları, sonra katmanın unsurlarını, en son katmanı siler. Unsurun
  `layerId`'si başka (yetim) olan unsurlar etkilenmez.

### Altlıklar

`upsert / patch / remove` unsurlarla aynı mantık. Sıra `order` alanındadır.
`exclusiveGroup` kuralı (aynı gruptan biri açılınca diğerlerini kapat) store'da uygulanır:
`visible: true` yapılan altlık, aynı gruptaki diğerlerini aynı transaction içinde kapatır.

Uygulama ayrıntıları:

- Kural, altlık **görünür hale geldiğinde** (eklenirken görünür, kapalıdan açığa geçti) veya
  **görünürken başka bir gruba geçtiğinde** çalışır. Kapanan altlıklar günlüğe `VISIBLE` biti ile yazılır.
- Aynı pakette aynı gruptan iki görünür altlık gelirse **sonuncu kazanır**.
- Kapatmak başkasını açmaz; grupta hiç açık altlık kalmayabilir.
- Altlık değişiklikleri `structure` bayrağını etkilemez (katman ağacından ayrıdır).
- `getBasemaps()` `order`'a göre artan sıralıdır (eşitlikte ekleme sırası) ve **önbelleklidir**:
  değişiklik olmadıkça aynı dizi döner.

### Yeniden bağlanma ve snapshot

```ts
tx.replaceLayerContents("birlikler", snapshot);
```

- Katmanın (yalnız **doğrudan** unsurları) snapshot ile birebir eşitlenir:
  snapshot'ta olmayan → REMOVE, olan → upsert (maske hesabıyla), `rev` kontrolü yok.
- Diğer katmanlara **dokunulmaz**. Her backend akışı hangi katmanları beslediğini bilir.
- Snapshot'taki bir unsurun `layerId`'si farklıysa (yanlış kapsam) atlanır ve
  `stats.rejectedSnapshotItems` artar. (Çekirdekte "geliştirme modu" kavramı yok; diğer
  sözleşme ihlalleri gibi sayaçla raporlanır.)
- Snapshot yetkilidir: `rev` kontrolü yapılmaz ve unsurların `rev` durumu snapshot'tan
  **yeniden kurulur** (rev'siz gelen unsurun eski `rev`'i unutulur). Böylece sunucu yeniden
  başlayıp `rev`'i sıfırladıysa sonraki deltalar yanlışlıkla düşürülmez.
- Başka bir katmanda duran aynı id'li unsur snapshot ile bu katmana taşınır.
- Aynı içerikli snapshot günlüğe hiçbir şey yazmaz; referanslar korunur (yeniden bağlanma
  sonrası gereksiz yeniden çizim olmaz).

### Seçim ve hover

- `selection` değişmez bir `Set`; her değişiklikte yeni küme.
- Silinen unsur seçimden ve hover'dan otomatik düşer.
- `selectable === false` olan unsur (veya katmanı) seçilemez; select çağrısı onu atlar.
- Günlükte seçimi **değişen** id'ler tutulur (MapSync yalnız onlar için `feature-state` üretir).
- Seçilebilirlik: unsur store'da olmalı, `selectable !== false` olmalı ve katman zincirinde
  (ataları dahil) `selectable: false` katman olmamalı. Yetim unsur (katman bilgisi yok) seçilebilir.
  Seçimden **çıkarma** her zaman serbesttir. Seçiliyken seçilemez hale gelen unsur seçimden
  otomatik düşmez (bilinçli tercih: bir sonraki seçim işleminde temizlenir).
- `setHovered` store'da olmayan id'yi (ör. sentetik küme id'si) yok sayar; küme hover'ı
  adapter/sunum aşaması tarafında yönetilir.

## Değişiklik günlüğü (ChangeJournal)

### Maskeler

Her varlık türü için bit maskesi (const nesne, `enum` değil):

| Unsur (`FEATURE_CHANGE`)   | Katman (`LAYER_CHANGE`)                | Altlık (`BASEMAP_CHANGE`)            |
| -------------------------- | -------------------------------------- | ------------------------------------ |
| `GEOMETRY`                 | `NAME`                                 | `SOURCE`                             |
| `STYLE`                    | `VISIBLE`                              | `VISIBLE`                            |
| `PROPS`                    | `OPACITY`                              | `OPACITY`                            |
| `Z`                        | `ZOOM` (min/max)                       | `ORDER`                              |
| `HIDDEN`                   | `INTERACTION` (selectable/interactive) | `INFO` (ad, sağlayıcı, attribution…) |
| `LAYER` (layerId)          | `RENDER_GROUP`                         |                                      |
| `INTERACTION` (selectable) | `PARENT` (taşındı / sıra)              |                                      |
| `META`                     | `META`                                 |                                      |

Bit tablolarının yanında türetilmiş sabitler (tabloları saf tutmak için ayrı tanımlanır):

- `FEATURE_CHANGE_ALL`, `LAYER_CHANGE_ALL`, `BASEMAP_CHANGE_ALL` — tüm bitler (REMOVE → ADD birleşmesinde).
- `FEATURE_CHANGE_VISUAL` = `META` hariç hepsi. MapSync yalnız bu bitlere bakar;
  **yalnız `META` değiştiyse unsur haritaya hiç gitmez**.

Altlıkta `META` yok, çünkü `Basemap` tipinde `meta` alanı yok.

### İşlemler ve birleştirme

Günlük her id için tek kayıt tutar: `{ op: ADD | UPDATE | REMOVE, mask }`.
Bir flush'a kadar aynı id için gelen işlemler şu tabloya göre birleşir:

| Önceki → Yeni   | Sonuç                   | Neden                                                       |
| --------------- | ----------------------- | ----------------------------------------------------------- |
| (yok) → X       | X                       |                                                             |
| ADD → UPDATE    | ADD (maske OR)          | Harita onu hiç görmedi; son haliyle eklenir                 |
| ADD → REMOVE    | **kayıt silinir**       | Harita onu hiç görmedi, söylenecek bir şey yok              |
| UPDATE → UPDATE | UPDATE (maske OR)       | 10 konum güncellemesi → tek kayıt                           |
| UPDATE → REMOVE | REMOVE                  |                                                             |
| REMOVE → ADD    | UPDATE (**tüm bitler**) | Harita eskisini biliyor; yeni nesne tamamen farklı olabilir |
| REMOVE → REMOVE | REMOVE                  | (olmamalı, ama zararsız)                                    |

Ek kurallar (kod: `store/change-journal.ts`):

- **Normalleştirme:** ADD kaydı her zaman türün tüm bitlerini taşır (yeni varlığın her alanı
  "yeni"); REMOVE kaydı hiç bit taşımaz. Maskesi 0 olan UPDATE kayıt oluşturmaz.
- Tabloda "olmamalı" denen geçişler (UPDATE → ADD, REMOVE → UPDATE) hata fırlatmaz; varlık
  mevcut sayılır ve tüm bitlerle UPDATE yazılır (harita tarafı için en güvenli sonuç).
- **Seçim:** store, bir unsurun seçim durumu **gerçekten tersine döndüğünde** `flipSelection(id)`
  çağırır. Aynı flush içinde iki kez dönen unsurun net değişikliği yoktur, listeden çıkar.
- **Hover:** ilk `prev` korunur, son `next` alınır; başa dönerse (`prev === next`) kayıt silinir.
- `drain()` dönen yapıları çağırana bırakır ve kendisi yeni boş yapılarla devam eder;
  sonraki yazmalar önceki `ChangeSet`'i etkilemez.

### ChangeSet

```ts
type EntityChange = { op: ChangeOp; mask: number };

type ChangeSet = {
  features: ReadonlyMap<string, EntityChange>;
  layers: ReadonlyMap<string, EntityChange>;
  basemaps: ReadonlyMap<string, EntityChange>;
  structure: boolean; // katman ağacının şekli değişti
  selection: ReadonlySet<string>; // seçim durumu değişen unsur id'leri
  hover: { prev: string | null; next: string | null } | null;
};
```

`store.drainChanges()` biriken `ChangeSet`'i döner ve günlüğü sıfırlar. MapSync bunu
flush başına bir kez çağırır. Günlük, birden fazla transaction boyunca birikir.

## Abonelik

| Abonelik                              | Ne zaman çağrılır                                               |
| ------------------------------------- | --------------------------------------------------------------- |
| `subscribeFeature(id, cb)`            | Bu unsur eklendi / değişti / silindi                            |
| `subscribeLayer(id, cb)`              | Bu katman değişti / silindi                                     |
| `subscribeBasemap(id, cb)`            | Bu altlık değişti / silindi                                     |
| `subscribeStructure(cb)`              | Katman ağacının şekli değişti                                   |
| `subscribeLayerContents(layerId, cb)` | Katmana unsur eklendi/çıktı (sayaç, ağaçta unsur listesi)       |
| `subscribeSelection(cb)`              | Seçim değişti                                                   |
| `subscribeHover(cb)`                  | Hover değişti                                                   |
| `subscribeChanges(cb)`                | Herhangi bir şey günlüğe yazıldı (MapSync flush planlamak için) |

Kurallar:

- Hepsi abonelikten çıkma fonksiyonu döner.
- Bildirimler **transaction bittiğinde** gider; transaction içinde hiçbir dinleyici çalışmaz.
- Bir transaction'da aynı id 100 kez değişse de o id'nin dinleyicisi **bir kez** çağrılır.
- **İç içe transaction** dıştakine katılır; bildirim yalnız en dıştaki bitince gider.
- Bir dinleyicinin hatası diğerlerini durdurmaz (yakalanır, sonra raporlanır).
- Dinleyici içinde yeni transaction açılabilir (ör. türetilmiş durum); bu ayrı bir dalga olarak işlenir.

Uygulama ayrıntıları:

- Ek abonelik: `subscribeBasemaps(cb)` — altlık listesi değişti (`getBasemaps()` yeni referans;
  LayerTree'nin "Altlıklar" bölümü için).
- Dinleyici hatası `onListenerError(error)` seçeneğine gider; verilmezse transaction'ı bozmadan
  asenkron raporlanır (`reportError` varsa o, yoksa mikro görevde yeniden fırlatma).
- `fn` hata fırlatsa bile o ana kadarki yazmalar bildirilir (geri alma yok; aboneler store ile tutarlı kalır).
- Bildirim sırası: unsur → katman → altlık → katman içeriği → yapı → altlık listesi → seçim → hover → genel değişiklik.
- Yalnız `updatedAt` / `rev` ilerleten (içeriği aynı) yazmalar bildirim üretmez.

## Okuma API'si (taslak)

```ts
interface MapStore {
  // okuma
  getFeature(id: string): Feature | undefined;
  getLayer(id: string): Layer | undefined;
  getBasemap(id: string): Basemap | undefined;
  getChildLayerIds(parentId: string | null): readonly string[];
  getFeatureIds(layerId: string): ReadonlySet<string>;
  getBasemaps(): readonly Basemap[]; // order'a göre sıralı, değişince yeni referans
  getSelection(): ReadonlySet<string>;
  getHovered(): string | null;
  getUpdatedAt(featureId: string): number | undefined;
  readonly stats: { droppedStale: number; ignoredPatches: number; rejectedSnapshotItems: number };

  // yazma
  transaction(fn: (tx: MapTx) => void): void;

  // abonelik (yukarıdaki tablo)
  subscribeFeature(id: string, cb: () => void): () => void;
  // …

  // MapSync için
  drainChanges(): ChangeSet;
}

function createMapStore(opts?: { now?: () => number }): MapStore; // saat test için enjekte edilir
```

React binding'i: `useSyncExternalStore(cb => store.subscribeFeature(id, cb), () => store.getFeature(id))`
\+ seçici (`useFeature(id, f => f.meta?.fuel)`) → yalnız o değer değişince yeniden çizim ([07](07-react-api.md)).

## Değişiklik yayılımı (kim neyi duyar)

| Değişen                      | Harita (MapSync)      | React id aboneleri | LayerTree                                                     |
| ---------------------------- | --------------------- | ------------------ | ------------------------------------------------------------- |
| `geometry`                   | ✔ yeni geometri       | ✔                  | ✘                                                             |
| `style` / `props`            | ✔ özellik diff'i      | ✔                  | ✘ (ikon gösteriliyorsa ✔ satır)                               |
| `meta`                       | ✘                     | ✔                  | ✘                                                             |
| katman `visible` / `opacity` | ✔ alt ağaç için batch | ✔                  | ✔ yalnız o satır (+ efektif görünürlüğü değişen alt satırlar) |
| katman ekle / sil / taşı     | ✔                     | ✔                  | ✔ ağacı yeniden kur (throttle'lı)                             |
| seçim                        | ✔ feature-state       | ✔                  | ✔ seçili satırlar                                             |

## Canlı veri girişi (ingest)

- Backend yalnız değişen alanı gönderebilir (kısmi patch); store alan bazlı birleştirir.
- **Geri basınç (backpressure):** Mesajlar flush'a kadar store'da birikir; aynı id'nin ara
  durumları günlükte birleşir, bellek O(unsur sayısı) kalır.
- **Worker (Faz 3):** WS bağlantısı + JSON parse + normalize + birleştirme bir Web Worker'da;
  ana thread'e kare başına tek paket gelir. Ingest API batch odaklı olduğu için sözleşme değişmez.
