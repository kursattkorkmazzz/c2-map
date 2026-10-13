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

`encode` birden çok parça döndürür (`${id}#icon`, `${id}#ring`, `${id}#label`), hepsi
`_fid = id` taşır. Hit-test `_fid` üzerinden asıl unsura döner; seçim tüm parçalara uygulanır.

## deck.gl yolu

> Spike'ta MapLibre GeoJSON kaynağı 50k'da hiç yenilenemedi; deck.gl 50k × 1 Hz'i ana thread'de
> ~3 ms/sn ile taşıdı ([spike](../spike/findings.md)). Canlı birlikler için **ana yol** budur.

- `MapboxOverlay` (interleaved) ile MapLibre katman yığınına girer, aynı WebGL bağlamını
  paylaşır. Entegrasyon Faz 1'de deck.gl dokümanındaki MapLibre 6 yöntemine göre yapılır
  ([karar #16](../decisions.md)).
- Render group başına bir `IconLayer` (LOD'da `ScatterplotLayer`).
- Birlik başına düz typed array'ler (id → indeks eşlemesi): konum (Float64), boyut, renk.
- Değişiklik = dizide birkaç sayıyı yazmak + diziyi **yeni bir sarmalayıcı nesneyle**
  (`{ value, size }`) vermek + `updateTriggers` sürümünü artırmak. Aynı referans verilirse
  deck.gl güncellemeyi atlar.
- Seçim/hover: `autoHighlight` + küçük ayrı vurgu katmanı; hit-test `pickObject`.
- Unsur silinince indeks boşluğu: son elemanla yer değiştir (swap-remove) + eşlemeyi güncelle.

### Akıcı hareket

- Her birlik için "nereden → nereye, ne zaman başladı" tutulur; her karede ara konum
  hesaplanıp konum dizisi GPU'ya yüklenir. Görüntü bir mesaj aralığı geriden gelir.
- 50k'da kare başına ~1–2 ms JS; gerekirse ara konum hesabı shader'a taşınır (Faz 4).
- **Mod:** `MOTION_MODE = { OFF, ON, AUTO }` — kullanıcı ayarı, harita bazında.
- `AUTO`: adapter son birkaç saniyenin harita çizim hızını izler. Eşiğin altına düşünce
  (ör. < 25 çizim/sn) kapatır, belirgin biçimde üstüne çıkınca (ör. > 45) tekrar açar.
  Histerezis (iki eşik + minimum bekleme süresi) gidip gelmeyi önler.
- Geçişte zıplama yok: kapanırken son hedef konuma, açılırken mevcut konumdan devam edilir.

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
