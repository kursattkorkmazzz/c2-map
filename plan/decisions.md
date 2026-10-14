# Kararlar

← [Plan ana sayfası](README.md)

## Karar kaydı

Yeni karar en üste eklenir. Bir karar değişirse eskisi silinmez, "yerine geçti" diye işaretlenir.

| Tarih | Karar | Gerekçe | Ayrıntı |
|---|---|---|---|
| 2026-10-14 | **#8 Çizim mimarisi: B** — `DrawSession` sözleşmesi ve çizim araçları çekirdekte (TS durum makineleri); çizilen şekil store'da taslak; adapter yalnız işaretçi olayları + "kaydırma kilidi" sağlar. Motor kütüphanesi (ör. terra-draw) gerekirse aynı sözleşmeyi uygulayan alternatif olarak adapter içine takılır. Çizim arayüzü (araç çubuğu) 2.4'te netleşecek | Her motor (MapLibre, Cesium) çizimi bedavaya alır; askeri kontrol tedbiri araçları tek yerde | [09](design/09-interaction-and-editing.md#çizim-mimarisi-öneri) |
| 2026-10-14 | Jeodezik hesaplar `geographiclib-geodesic` ile (çekirdeğin ilk çalışma zamanı bağımlılığı); UTM / MGRS / DMS elle yazıldı, `mgrs` yalnız test referansı | Elipsoid üzerinde alan / mesafe kesin olmalı; UTM API'si ve Türkçe biçimler hiçbir hazır pakette yok | [08](design/08-extensibility-symbology.md#koordinat-sistemleri) |
| 2026-10-14 | UTM metni bant harfiyle ("36S …"), yarımküre harfiyle değil | Askeri alışkanlık ve MGRS grid zone ile aynı; Türkiye S bandında — "S = güney" ile karışmasın diye yarımküre biçimi okunmaz | [08](design/08-extensibility-symbology.md#koordinat-sistemleri) |
| 2026-10-14 | **#20 Taslak (draft) store'da `drafts` haritasında** | Motor bağımsız; backend güncellemesi asıl kaydı değiştirir, taslak kaymaz; React taslağı okuyabilir | [09](design/09-interaction-and-editing.md#düzenleme-ve-eşzamanlılık) |
| 2026-10-14 | LayerTree (Faz 1.6) sonraya; Faz 2'ye geçildi | Kullanıcı önceliği | [phase-2](phases/phase-2-interaction.md) |
| 2026-10-14 | Varsayılan seçim kuralı: tıkla = tek, Ctrl/⌘ = toggle, Shift = ekle; olaylarda motordan bağımsız `modifiers` | Masaüstü alışkanlığı; uygulama motor olayına bakmasın | [09](design/09-interaction-and-editing.md#etkileşim) |
| 2026-10-13 | React bildirimsel bileşenleri prop değişiminde **yalnız değişen alanı** yazar (katman, altlık); yazmalar mikro görevde tek transaction | Bileşen prop'u, kullanıcının LayerTree'de verdiği kararı (görünürlük) başka bir prop değişti diye ezmemeli; çok sayıda bildirimsel unsur tek MapSync bildirimiyle | [07](design/07-react-api.md#deklaratif-bileşenler) |
| 2026-10-13 | `<Map>` varsayılan etkileşimleri açık: tıklama → seçim, üzerine gelme → hover (`defaultInteractions={false}` ile kapatılır) | Her uygulama aynı bağlamayı yazmasın; hedefli dinleyici `stopPropagation` ile engelleyebilir | [07](design/07-react-api.md#kabuk) |
| 2026-10-13 | `<MapOverlay>` Faz 2'den Faz 1.4'e alındı; konum rAF + `project` ile DOM'a doğrudan | Demo'daki seçili birlik kartı için gerekli; `viewchange` hareket bitince geldiğinden kart geride kalırdı | [07](design/07-react-api.md#deklaratif-bileşenler) |
| 2026-10-13 | **#16 deck.gl entegrasyonu:** `@deck.gl/maplibre` `MapLibreOverlay` (interleaved), `MaplibreAdapter` içinde ikinci çizici (`deckRenderers`); ayrı deck adapter'ı yok | Doküman bu paketi öneriyor; `@deck.gl/mapbox`'taki `map.transform` hatası burada yok (tarayıcıda doğrulandı). Tek adapter = altlık, sıra, olay ortak | [04](design/04-sync-and-rendering.md#deckgl-yolu), [findings](spike/findings.md#deckgl-renderer-faz-13-2026-10-13) |
| 2026-10-13 | Akıcı hareket `AUTO` **sayfa** kare hızına bakar (harita çizim hızına değil); bekleme her geçişte ×2; varsayılan mod `off` | Hareket kapalıyken harita ~10 Hz çizilir, çizim hızına bakan karar hareketi hiç geri açmazdı | [04](design/04-sync-and-rendering.md#akıcı-hareket) |
| 2026-10-13 | MapLibre'de ikon boyutu (`icon-size`) **katman sabiti**; unsur başına veri güdümlü değil | Tarayıcı ölçümü: veri güdümlü `icon-size` 10k'da FPS'i ~120'den 1–2'ye düşürdü | [04](design/04-sync-and-rendering.md#hover--seçim--bayatlık--feature-state), [findings](spike/findings.md#gerçek-maplibre-adapterı-faz-11-2026-10-13) |
| 2026-10-13 | **#10 Mesaj formatı:** kısmi patch ve tam nesne **ikisi de** desteklenir; **en kötü durum (her mesajda tam nesne) esas alınır**, değişikliği çekirdek bulur | Backend formatı belli değil; en kötü durumda da çalışmalı | [03](design/03-store.md#en-kötü-durum-her-mesajda-tam-nesne), [Faz 1.0](phases/phase-1-2d-mvp.md#10-akış-girişi-tam-nesne-en-kötü-durum-ve-kısmi-patch) |
| 2026-10-13 | **#11 Frekans:** birlik başına ≤ 1 Hz, haritaya uygulama tavanı 10 Hz | Ölçümler bu senaryoda rahat | [spike](spike/findings.md) |
| 2026-10-13 | **LayerTree ayrı faz (1.6)**; #14 (unsurlar ağaçta mı) orada detaylandırılacak | Kapsamı ayrıca konuşulacak | [phase-1.6](phases/phase-1.6-layer-tree.md) |
| 2026-10-13 | Faz 0.5 (spike) "tamamlandı" sayılmaz; **Faz 1.5 — Performans doğrulaması** olarak Faz 1'in arkasına taşındı. LOD ölçümü Faz 3.5'e, kümeleme ölçümü Faz 4.2'ye | Spike bir prototipti (kendi store'u, doğrudan motor çağrıları); gerçek paketlerle test ancak adapter ve demo hazır olunca mümkün. Spike sayıları referans değer olarak kalır | [phase-1.5](phases/phase-1.5-perf.md), [spike](spike/findings.md) |
| 2026-10-12 | Plan birden fazla dosyaya bölündü (rev. 4): `design/`, `phases/`, `spike/`, `decisions.md` | Faz faz takip edilebilsin | [README](README.md) |
| 2026-10-12 | **`Feature.origin` / `FeatureOrigin` kaldırıldı** | Unsurun kaynağı ömrü boyunca değişir (çizim → backend → refresh → düzenleme) | [02](design/02-core-model.md#neden-featureorigin-yok) |
| 2026-10-12 | Yeniden bağlanmada silme kapsamı katman bazında: `tx.replaceLayerContents(layerId, snapshot)` (`replaceRemote` yerine geçti) | Her akış hangi katmanları beslediğini bilir; diğer katmanlara dokunulmaz | [03](design/03-store.md#yeniden-bağlanma-ve-snapshot) |
| 2026-10-12 | Düzenleme çakışması: taslak (draft) + `rev` (Faz 2) | Kullanıcı düzenlerken backend güncellemesi taslağı bozmamalı | [09](design/09-interaction-and-editing.md#düzenleme-ve-eşzamanlılık) |
| 2026-10-12 | Akıcı hareket modu: `off` / `on` / `auto` | Kullanıcıya bırakılabilir veya çizim hızına göre otomatik | [04](design/04-sync-and-rendering.md#akıcı-hareket) |
| 2026-10-12 | Kümeleme ilk sürümde yok; boş "sunum aşaması" genişleme noktası bugünden | Sonradan eklemek kolay olmalı | [04](design/04-sync-and-rendering.md#sunum-aşaması-kümeleme-için-genişleme-noktası) |
| 2026-10-12 | deck.gl ↔ MapLibre 6: Faz 1'de deck.gl dokümanındaki yöntemle entegre (2026-10-13'te uygulandı, yukarıda) | Doküman uyumluluk belirtiyor; spike'taki hata senaryosu test edilecek | [spike](spike/findings.md#uyumluluk-notları) |
| 2026-10-12 | Canlı birlikler deck.gl ile (karma model); tasarım hedefi 50k | MapLibre GeoJSON 50k'da donuyor | [spike](spike/findings.md) |
| 2026-10-12 | LOD zorunlu | 50k'da sınır ekrandaki sembol sayısı | [04](design/04-sync-and-rendering.md#zooma-göre-gösterim-lod) |
| rev. 2 | Store: amaca özel `MapStore`; zustand yalnız UI durumu | Id bazlı abonelik + değişiklik günlüğü | [03](design/03-store.md) |
| rev. 2 | Reconciler yok; store güdümlü senkron | Canlı veri React'ten geçmemeli | [07](design/07-react-api.md#neden-reconciler-yok) |
| rev. 2 | v1 motoru MapLibre; Cesium Faz 5; ayrı paketler; `[lon, lat, alt?]`; APP-6(D) ilk semboloji | | [01](design/01-overview.md) |

## Açık kararlar

| # | Konu | Durum | Ne zaman gerekli |
|---|---|---|---|
| 8 | Çizim mimarisi | ✅ B: araçlar çekirdekte, adapter girdi + kilit ([09](design/09-interaction-and-editing.md#çizim-mimarisi-öneri)); ⏳ çizim arayüzü 2.4'te | Faz 2.4 |
| 10 | Backend mesaj formatı | ✅ İkisi de; en kötü durum (tam nesne) esas. ⏳ Hâlâ açık: `rev`/`ts` var mı, snapshot endpoint'i nasıl? | Faz 1 (ingest) |
| 11 | Güncelleme frekansı | ✅ ≤ 1 Hz / tavan 10 Hz | — |
| 13 | Vektör stil altlıkları | ⏳ Birden fazla vektör stilini aynı anda açma (glyph/sprite çakışması) | Faz 4 |
| 14 | Unsurlar LayerTree'de mi? | ⏳ LayerTree fazında detaylandırılacak | Faz 1.6 |
| 16 | deck.gl ↔ MapLibre 6 | ✅ `@deck.gl/maplibre` `MapLibreOverlay` (interleaved); `map.transform` hatası yok, yama gerekmedi | Faz 1.3 ✅ |
| 17 | LOD eşikleri | ⏳ Hangi zoom'da nokta → sembol (Faz 3.5'teki ölçümle) | Faz 3 |
| 18 | Etiketler | ⏸ Hangi zoom'dan itibaren; MapLibre mi deck.gl `TextLayer` mı | Faz 3 |
| 19 | Hedef donanım | ⏸ Değişken; tasarım düşük donanımda da çalışacak şekilde (LOD, `auto` hareket) | Faz 1 ölçümleri |
| 20 | Taslak (draft) nerede yaşar | ✅ Store'da `drafts` haritası | Faz 2.5 |
