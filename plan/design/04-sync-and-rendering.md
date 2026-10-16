# 04 — MapSync ve çizim stratejisi

← [Plan ana sayfası](../README.md) · Faz: [0.3](../phases/phase-0-core.md#03-mapsync-ve-sunum-aşaması), [1](../phases/phase-1-2d-mvp.md), [3](../phases/phase-3-symbology.md), [4](../phases/phase-4-composite-scale.md)

## Hedef bütçeler

| Metrik | Hedef |
|---|---|
| Unsur sayısı | 3.000 tipik, tasarım hedefi **50.000** |
| Gelen güncelleme | ~3.000 mesaj/sn tipik, **50.000 mesaj/sn** tasarım tepesi (50k × 1 Hz) |
| Haritaya uygulama | Kare başına ≤ 1 flush, varsayılan en fazla **10 Hz** (ayarlanabilir) |
| Ana thread flush maliyeti | **< 4 ms** |
| Hover / seçim | 0 veri güncellemesi (yalnız feature-state / highlight) |
| React yeniden çizimi | Yalnız değişen id'ye abone bileşenler |
| Harita çizimi | Akıcı hareket kapalı: her flush ekrana yansımalı (≈ uygulama Hz'i). Açık: ≥ 30/sn |
| İşlenen mesaj | Gelen mesajın tamamı (birikme yok) |

> "Sayfa FPS"i tek başına yanıltıcıdır: spike'ta MapLibre 50k'da sayfa akıcıyken harita hiç
> yenilenmiyordu. Bütçeler **harita çizimi / sn** ile izlenir ([spike](../spike/findings.md)).

## Boru hattı

```
1 Ingest    : WS mesajları → normalize → store.transaction(...)        (Faz 3: Worker'da parse)
2 Store     : varlık güncelle, maskeyi günlüğe yaz, id dinleyicilerini çağır
3 Zamanlama : store.subscribeChanges → rAF (en fazla maxApplyHz) ile tek flush planla
4 MapSync   : drainChanges() → efektif görünürlük/opaklık/z → RenderBatch
5 Sunum     : [sunum aşamaları] → RenderBatch (varsayılan: aynen geçer)
6 Adapter   : applyBatch → statik kind: encode + diff → updateData
                           canlı kind : typed array'e yaz → deck.gl
7 GPU       : çizim
```

Birleştirme kuralları store'un günlüğündedir ([03](03-store.md#işlemler-ve-birleştirme)).
10 ardışık konum güncellemesi haritaya tek girdi olarak gider.

## MapSync'in görevleri

`MapSync` store ile adapter arasındaki köprüdür; motor bilmez.

1. **Zamanlama:** `subscribeChanges` ile "değişiklik var" haberini alır; bir sonraki kareye
   (ve `maxApplyHz` sınırına) tek flush planlar. Zamanlayıcı enjekte edilir (test: elle tetiklenir).
2. **Efektif görünürlük:** `!feature.hidden && katman ve tüm ataları visible && zoom ∈ [minZoom, maxZoom]`.
   Katman başına önbelleklenir; bir katman değişince yalnız alt ağacı geçersiz olur.
   - Görünmeyen unsur adapter'a **hiç gönderilmez** (veya REMOVE gönderilir).
   - Katman kapatılınca alt ağaçtaki tüm unsurlar için tek batch'te REMOVE; açılınca ADD.
   - Zoom aralığı yalnız bir eşik **geçildiğinde** yeniden değerlendirilir (`viewchange`).
   - Yetim unsur (katmanı yok) görünmez sayılır.
3. **Efektif opaklık:** katman ve ataların çarpımı.
4. **Render group:** her unsurun hangi gruba düştüğü — en yakın `renderGroup: true` ata
   (yoksa kökün doğrudan çocuğu).
5. **Sıra (zIndex):** katmanların ağaçtaki derinlik-öncelikli sırası + `feature.z`.
   Bir katman taşınınca alt ağacın tüm unsurlarının zIndex'i değişir (büyük batch; nadir olay).
6. **Durum yamaları:** seçim/hover/bayatlık değişimleri → `FeatureStatePatch` (veriye dokunmaz).
   Bayatlık: ~1 sn'de bir `updatedAt` eşiğini aşanlar için `stale: true`.
7. **META filtresi:** yalnız `META` biti değişen unsur batch'e girmez.
8. **Sunum aşamaları:** üretilen batch'i sırayla aşamalardan geçirip adapter'a verir.

### Uygulama ayrıntıları (kod: `src/sync/`)

- **Ekranda ne var:** MapSync, adapter'ın gösterdiği her unsurun efektif değerlerini (`groupId`,
  `opacity`, `zIndex`) `rendered` haritasında tutar. Değerlendirme sonucu buna göre:
  görünmez oldu → REMOVE; yeni görünür oldu → `RENDER_CHANGE_ALL`; görünürken değişti → kendi
  `VISUAL` bitleri | değişen efektif değer bitleri (`OPACITY` / `Z_INDEX` / `GROUP`); hiçbiri → gönderilmez.
- **Ne zaman ne değerlendirilir:**
  - yalnız unsur değişikliği → yalnız o unsurlar;
  - render'ı etkileyen katman değişikliği (`VISIBLE` / `OPACITY` / `ZOOM` / `RENDER_GROUP` / `PARENT`) →
    katman önbelleği temizlenir, **yalnız o katmanın alt ağacındaki** unsurlar;
  - `structure` (katman ekle/sil/taşı), zoom eşiği geçişi, ilk senkron, `setStages` → **tümü**
    (nadir olaylar).
- **`LayerResolver`:** katman başına önbellekli efektif bilgi; kökten ulaşılamayan katman (yetim zincir)
  çözülemez → altındaki unsurlar görünmez. Zoom kuralı MapLibre ile aynı: `minZoom` dahil, `maxZoom` hariç;
  zoom bilinmiyorsa (henüz `setView` yok) sınır uygulanmaz.
- **`setView(view)`:** yalnız bir katmanın eşiği **geçildiyse** tam değerlendirme planlar; sunum
  aşamalarının `onViewChange` batch'i zamanlayıcıyı beklemeden hemen uygulanır.
- **`setStages(stages)`:** görünen her unsur tüm bitlerle yeniden gönderilir (`rendered` temizlenmez;
  temizlenseydi artık görünmeyenler için REMOVE üretilemezdi).
- **Zamanlayıcı:** `createFrameScheduler({ maxApplyHz })` son çalışmadan beri `1000 / maxApplyHz` ms bekler,
  sonra rAF'a hizalar (rAF yoksa yalnız zamanlayıcı). Test ve sunucu için `createManualScheduler()`.
- Bayatlık (`stale`) zamanlayıcısı henüz yok (Faz 0'da "sonra" olarak bırakıldı).

## MapLibre render group

> Statik ve seyrek değişen kind'ler (kontrol tedbirleri, poligonlar, çizimler; en fazla ~10k
> unsur) için. Canlı birlikler [deck.gl yolu](#deckgl-yolu) ile çizilir.

Unsur başına motor nesnesi yerine **az sayıda GeoJSON source + veri güdümlü stil**:

- `renderGroup` başına **bir GeoJSON source**. Kaynak sayısı ~5–20 ile sınırlı kalır.
- Her grup için, içinde **kullanılan** her kind'in style layer'ları bir kez eklenir
  (ör. `vector` → fill + line + circle).
- Kaynak ayarları: `promoteId: '_id'` (feature-state ve diff için), `updateData()` ile diff.
- Sık değişen ile seyrek değişen veri **ayrı gruplarda** olmalı.
- Bir grubun tamamı gizlenirse daha ucuz yol: style layer'larına `visibility: none`.
- **Opaklık:** `_op` özelliği; paint: `['*', baseOpacity, ['get', '_op']]`.
- **Sıra:** `_z` özelliği → `symbol-sort-key` / `line-sort-key` / `fill-sort-key`.
  Kısıt: farklı style layer tipleri arasında (fill < line < symbol) sıra karışmaz; kabul edilir.

### Encode ve diff

1. Adapter her id için **son encode edilmiş özellikleri** saklar.
2. Yeni encode ile karşılaştırır → `updateData` diff'i: geometri değiştiyse `newGeometry`,
   yalnız değişen anahtarlar `addOrUpdateProperties`, kaybolanlar `removeProperties`.
3. Konum-only güncelleme = yalnız `newGeometry` (en küçük yük).
4. Kaynağa yalnız stilin okuduğu düz alanlar gider (`_id`, `_fid`, `_icon`, `_op`, `_z`,
   `_label`, renkler). Domain verisi asla.

### Hover / seçim / bayatlık → `feature-state`

`map.setFeatureState({ source, id }, { selected: true })` veriye dokunmaz, yeniden tile'lamaz.
Paint: `['case', ['boolean', ['feature-state', 'selected'], false], seçiliRenk, normalRenk]`.

- String id'ler için kaynak `promoteId: 'id'` ile kurulur; `updateData` ve feature-state promote
  edilen id ile çalışır (spike'ta doğrulandı).
- Halka katmanında yarıçap 0 olsa da `circle-stroke` çizilir → seçili/hover dışındakilerde
  `circle-stroke-opacity: 0` verilmeli (aksi halde her birlikte nokta ve gereksiz çizim).
- **`icon-size` veri güdümlü olmamalı** (katman sabiti): unsur başına `['get', …]` sık güncellenen
  kaynakta kare hızını birkaç saniyede 1–2 FPS'e düşürüyor
  ([ölçüm](../spike/findings.md#gerçek-maplibre-adapterı-faz-11-2026-10-13)). Farklı ikon boyutları
  gerekiyorsa ayrı kind / renderer kullanılır.

### Uygulama ayrıntıları (kod: `packages/map-maplibre/`)

- Her render group → bir GeoJSON kaynağı (`c2-src-<grup>`, `promoteId: '_id'`). Kaynağı birden fazla
  kind paylaşır; her kind'ın katmanları `_kind` ile süzer. Bir kind'ın katmanları, o kind grupta ilk
  kez görününce eklenir: grubun mevcut katmanlarının hemen üstüne (sonraki grubun ilk katmanının altına).
- Grup sırası değişince grupların katmanları `order`'a göre baştan dizilir (grup sayısı azdır).
- Unsurun grubu veya çizen kind'ı değişirse eski parçalar eski kaynaktan silinip yenisine eklenir.
- Adapter, MapLibre'ye doğrudan değil `MapLike` arayüzüne bağlıdır; `maplibre-gl` yalnız `mount`'ta
  dinamik import edilir. Testler `FakeMap` ile Node'da koşar; gerçek tarayıcı doğrulaması spike'ta.
- Worker URL'si seçenektir (`workerUrl`); kütüphane paketleyiciye özel import yapmaz.

### Composite

İki yol:

- **MapLibre:** `encode` birden çok parça döndürür (`${id}#icon`, `${id}#ring`, `${id}#label`), hepsi
  `_fid = id` taşır. Hit-test `_fid` üzerinden asıl unsura döner; seçim tüm parçalara uygulanır.
- **deck.gl katman renderer'ı** (3B model, koni gibi zengin parçalar): renderer unsurlarından kendi
  katmanlarını üretir; ilk örnek İHA — [08](08-extensibility-symbology.md#composite-unsur-iha).

## deck.gl yolu

> Spike'ta MapLibre GeoJSON kaynağı 50k'da hiç yenilenemedi; deck.gl 50k × 1 Hz'i ana thread'de
> ~3 ms/sn ile taşıdı ([spike](../spike/findings.md)). Canlı birlikler için **ana yol** budur.

- **Tek adapter, iki çizici.** `MaplibreAdapter({ deckRenderers: { milsym: … } })`: bu kind'ler
  deck.gl'e, diğerleri MapLibre katmanlarına gider. Altlıklar, gruplar, olaylar ortak. Fallback
  zinciri iki motorun kind'larını da görür; aynı kind ikisinde varsa deck.gl önceliklidir.
- `@deck.gl/maplibre` `MapLibreOverlay` (**interleaved**) — MapLibre katman yığınına girer, aynı
  WebGL2 bağlamını paylaşır ([karar #16](../decisions.md)). Spike'taki `map.transform` hatası
  `@deck.gl/mapbox`'a özgüydü; bu paket MapLibre'nin açık API'sini kullanır, yama gerekmez.
- **Sıra:** deck katmanının `beforeId`'si = üst sıradaki ilk grubun ilk MapLibre katmanı. deck.gl
  9.4 aynı `beforeId`'li deck katmanlarını MapLibre'de tek bir taşıyıcı özel katmanda toplar
  (`deck-maplibre-layer-group-before:<id>` / `…-last`); sonradan eklenen MapLibre katmanları
  üst grubun yalnız-deck olduğu durumda bu taşıyıcının altına girer. Kind katmanı eklendiğinde,
  grup sırası değiştiğinde veya grup silindiğinde deck sırası yeniden hesaplanır.
- Render group başına bir `IconLayer` (LOD'da `ScatterplotLayer`).
- Birlik başına düz typed array'ler (id → indeks eşlemesi): konum (Float64), boyut (Float32),
  renk (Uint8 RGBA; A = efektif opaklık).
- Değişiklik = dizide birkaç sayıyı yazmak + diziyi **yeni bir sarmalayıcı nesneyle**
  (`{ value, size }`) vermek + `updateTriggers` sürümünü artırmak. Aynı referans verilirse
  deck.gl güncellemeyi atlar. Uzunluk değişmediyse `data` nesnesi aynı kalır → `getIcon`
  (birlik başına JS çağrısı) yalnız ikon/boyut/opaklık değişince yeniden çalışır.
- Bir `applyBatch` = en fazla bir `overlay.setProps`.
- Seçim/hover: ayrı `ScatterplotLayer` halkası (yalnız durumu olan birlikler); hit-test
  `pickObject` → katman id'si + indeks → birlik id'si. Önce deck, sonra MapLibre katmanları.
- Unsur silinince indeks boşluğu: son elemanla yer değiştir (swap-remove) + eşlemeyi güncelle.
- İkonu üretilemeyen unsur çizilmez, `stats.skippedNoIcon` sayar.

### Akıcı hareket

- Her birlik için "nereden → nereye, ne zaman başladı" tutulur; her karede ara konum
  hesaplanıp konum dizisi GPU'ya yüklenir. Görüntü bir mesaj aralığı geriden gelir.
- 50k'da kare başına ~1–2 ms JS; gerekirse ara konum hesabı shader'a taşınır (Faz 4).
- **Mod:** `MOTION_MODE = { OFF, ON, AUTO }` — adapter seçeneği `motion` (varsayılan `off`),
  çalışırken `adapter.setMotionMode(mode)`; durum `adapter.motion → { mode, active }`.
  Kayma süresi `motionDurationMs` ≈ mesaj aralığı.
- `AUTO`: **sayfa** kare hızını ölçer (saniyede bir). Harita çizim hızına bakmaz: hareket
  kapalıyken harita zaten ~uygulama Hz'inde çizilir, o ölçüye bakan karar hareketi bir daha
  açmazdı. Varsayılan eşikler: < 25 fps 3 sn sürerse kapat, > 50 fps sürerse aç. Her yön
  değiştirmede bekleme ikiye katlanır (üst sınır 60 sn) → gidip gelme döngüsü sönümlenir.
- Geçişte zıplama yok: kapanırken herkes son hedef konumuna atlar, kayarken gelen yeni
  hedef ekrandaki konumdan başlar. Yeni eklenen birlik kaymaz, yerinde belirir.
- Kare döngüsü yalnız hareket eden birlik varken döner; hareket bitince durur.

## Cesium yolu

> 2026-10-16 — Faz 5'in ilk sürümü. Kod: `packages/map-cesium/`; demo `apps/map-spike/cesium.html`.
> Çekirdek (store, MapSync, EventRouter, çizim / düzenleme denetleyicileri) ve `@c2/map-react`
> **değişmeden** çalışır: aynı `<Map>`, `<MapLayer>`, `<Polygon>`, `<DrawToolbar>`, hook'lar.

MapLibre'de renderer veri **kodlar** (katman + GeoJSON özelliği), motor çizer. Cesium imperatif bir
sahne grafiğidir: renderer unsur başına motor nesnesi **kurar** ve günceller. Çekirdeğin
`AdapterRenderer` notunda öngörülen şekil budur:

```ts
interface CesiumKindRenderer<THandle> {
  init?(ctx); destroy?(ctx);                                  // mount / unmount'ta bir kez
  create(rf, ctx, state): THandle | null;                     // null → çizilemez (sayılır)
  update(handle, rf, ctx, state): THandle | null | void;      // rf.changed hangi bit değişti
  remove(handle, ctx);
  setState?(handle, state, ctx);                              // seçim / hover
}
```

| Kind | Renderer | Cesium nesnesi |
|---|---|---|
| `milsym` (birlikler) | `billboardRenderer({ image })` | Tek `BillboardCollection`; görüntü **anahtarla** paylaşılır (`setImage(sidc, canvas)`), araziye oturur (`CLAMP_TO_GROUND`), tepe arkasında kaybolmaz (`disableDepthTestDistance`). Seçim: aynı konumda halka billboard'u |
| `vector` (kontrol tedbirleri, çizimler) | `vectorRenderer` | Entity: araziye giydirilmiş poligon (GroundPrimitive) + ayrı zemin çizgisi (giydirilmiş poligon çerçeve çizemez), `zIndex` = MapSync sırası. Şekiller çekirdeğin `shapeRings`'iyle |
| `uav` (composite) | `cesiumUavRenderer({ modelUrl })` | Entity model (glTF) + etiket + çizgiler; koni yüzleri ve iz **tek ortak primitive** (aşağıda) |

- **`applyBatch`:** altlıklar → `ImageryLayer`; unsurlar → renderer; entity olayları batch boyunca
  askıda (`suspendEvents` / `resumeEvents`: görselleştiriciler tek seferde çalışır); durum →
  `setState`. 3B'de render group ayrı kaynak açmaz (sıra yalnız zemin geometrilerinde `zIndex`).
- **Hit-test:** `scene.pick` → en üstteki motor nesnesi → `own(nesne, featureId)` ile kaydedilmiş
  sahibi. Renderer seçilebilir her nesneyi kaydeder (İHA'da tüm parçalar). Billboard'un `id`'si
  doğrudan unsur id'si.
- **Olaylar:** tuval DOM olayları (değiştirici tuşlar için). Cesium sürükleyerek döndürür /
  yakınlaştırır: basıp 5 px'ten fazla sürüklenen tuş tıklama sayılmaz. Hover kare başına bir
  `scene.pick` (sürüklerken hiç). `VIEW_CHANGE` = `camera.moveEnd`.
- **Kamera:** çekirdeğin `CameraView`'ı MapLibre'ninkidir; Cesium'da kamera bir noktaya mesafe
  ve açılarla bakar. zoom → mesafe: zoom'daki metre/piksel (512 px karo) × ekran yüksekliği, dikey
  görüş açısına sığdırılır; bearing = heading; pitch = Cesium pitch + 90°. Aynı `initialView` iki
  motorda yaklaşık aynı alanı gösterir. `center[2]` verilirse oraya (ör. İHA irtifasına), yoksa
  zemine bakılır.
- **Entity id'si benzersiz** (`unsur#parça@sayaç`): aynı id ile silinip aynı batch'te (olaylar
  askıdayken) yeniden eklenen entity'yi Cesium "değişmedi" sayar ve ekranda **eskisi kalır**
  (düzenlemede bulundu: kaydedilen şekil haritaya yansımıyordu).
- **Çizim önizlemesi:** entity'ler bir kez kurulur, değer yalnız değişince yazılır.
  `CallbackProperty` kullanılmaz: araziye giydirilmiş dinamik şekil her karede baştan üçgenlenir
  (ölçüldü: çizerken 26 → 6 FPS). Sabit değerde Cesium yeniden üretimi Worker'da yapar ve yenisi
  hazır olana kadar eskisini gösterir.
- **İHA yüzeyleri:** her İHA'nın 4 koni yüzü + izi entity poligonu olarak her karede yeniden
  üretiliyordu (İHA başına 5 primitive, alt bölme, normaller): 6 İHA'da 58 → 28 FPS. Şimdi tüm
  İHA'ların yüzeyleri her karede **tek** `Primitive`'de ham üçgen (İHA başına 6), eşzamanlı.
  Model, etiket ve çizgiler entity (`CallbackProperty`) — ucuz.
- **Kare önbelleği:** İHA parçalarının ~12 özelliği aynı karede tek hesaptan okunur (anahtar:
  sahnenin kare sayacı; `performance.now()` her çağrıda farklı olduğu için önbellek tutmuyordu).
- **Zemin yüksekliği** (`GroundHeightCache`): `Globe.getHeight` karonun üçgenlerinde ışın testi
  yapar; her karede onlarca çağrı 6 İHA'da 3 sn'nin 2,8 sn'sini yiyordu. ~110 m hücre başına,
  2 sn ömürlü önbellek (arazi kademeli inceldiği için kısa ömür; arazi yoksa önbelleğe alınmaz).
- **Görüntü kalitesi** (`quality` / `setQuality`): entegre GPU'da MSAA, atmosfer ve sis pahalı.
  `high` = Cesium varsayılanı; `balanced` (varsayılan) = MSAA yok + FXAA, zemin atmosferi ve sis
  yok; `fast` = gökyüzü / yıldız / güneş de yok. Ölçüm: [findings](../spike/findings.md#cesium-adapterı-faz-5-2026-10-16).
- **Statik dosyalar:** Cesium Worker / Asset dosyalarını `CESIUM_BASE_URL` altından ister. Spike'ta
  küçük bir Vite eklentisi geliştirmede `node_modules/cesium/Build/Cesium`'u `/cesium/` altından
  sunar, derlemede `dist/cesium`'a kopyalar (`apps/map-spike/vite.config.ts`).

## Askeri semboller ve ikonlar

- Görüntü **benzersiz anahtar başına bir kez** üretilir:
  `key = ${standard}:${hash(code, paylaşılan değiştiriciler, size)}`.
  Spike: 50k birlik → 240 görüntü; tümünün üretimi tek seferlik ~0,2–1 sn.
- **Anahtara birliğe özel değiştirici girmez** (benzersiz tanıtıcı, ad, sayısal değerler).
  Girerse her birlik ayrı görüntü olur ve önbellek çöker. Bu metinler ayrı etiket katmanındadır.
- **MapLibre 6:** `map.setMissingStyleImageResolver(key => …)` → üret → `map.addImage`.
  Ekranda hiç görünmeyen sembol üretilmez. (`styleimagemissing` olayı artık yeterli değil.)
- **deck.gl:** `IconLayer` otomatik atlası (`getIcon` → `{ id: key, url, width, height }`);
  sembol boyları farklı olduğu için boyut birlik başına dizi olarak verilir.
- **Çapa:** sembol, çapa noktası (çerçeve merkezi) tam ortaya gelecek şekilde boşluklu tuvale çizilir.
- Ref-count + LRU: kullanılmayan görüntüler atılır.
- Askeri semboller döndürülmez; hareket yönü gerekirse ayrı bir ok katmanıyla gösterilir.

## Zoom'a göre gösterim (LOD)

Spike'ta 50k'da sınırı veri akışı değil, ekranda aynı anda boyanan sembol sayısı belirledi
(akıcı hareketle z 6.5'te 16, z 9'da 48 çizim/sn). Genel görünümde 50k tam sembol zaten okunmaz.

- **Uzak zoom:** kimlik renginde küçük nokta veya küme.
- **Yakın zoom:** tam sembol (+ etiket).
- Eşikler kind/katman bazında ayarlanabilir; geçiş kamera olayıyla yapılır, veri yeniden
  gönderilmez (aynı diziler, farklı deck katmanı).

## Sunum aşaması (kümeleme için genişleme noktası)

Kümeleme gerekecek, ama ilk sürümler **yokmuş gibi** yazılır. Sonradan eklemek tek bir parça
takmak kadar kolay olsun diye MapSync ile adapter arasına, varsayılan olarak boş geçen bir
**sunum aşaması** konur:

```
MapStore → MapSync → RenderBatch → [sunum aşamaları] → adapter.applyBatch()
                                     varsayılan: yok (batch aynen geçer)
                                     sonra: ClusterStage, LodStage …
```

```ts
export interface PresentationStage {
  id: string;
  /** Batch'i dönüştürür: unsurları gizleyebilir, yerlerine sentetik unsur (küme) koyabilir. */
  process(batch: RenderBatch, ctx: PresentationContext): RenderBatch;
  /** Kamera değişince yeniden hesap gerekiyor mu (ör. zoom eşiği geçildi)? */
  onViewChange?(view: CameraView, ctx: PresentationContext): RenderBatch | null;
}
```

Bugünden uyulacak kurallar:

- Sentetik unsurlar (küme) normal `RenderFeature` olarak akar; id'leri ayrı önekle
  (`cluster:…`) üretilir ve store'a **yazılmaz**.
- Hit-test ve olaylar sentetik id'yi tanır; `EventRouter` küme tıklamasını ayrı olay türüyle
  iletir (ör. `cluster:click`, içerdiği unsur id'leriyle).
- Seçim ve feature-state gerçek id'ler üzerinden kalır; kümelenen seçili unsur kümeyi vurgular.
- Aşama kind'den bağımsızdır (konum + kimlik yeter); sembol-farkında kümeleme sonra
  `kind`'e özel bir `clusterKey(f)` ile eklenir.
