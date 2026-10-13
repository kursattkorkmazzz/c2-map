# Spike bulguları (`apps/map-spike`)

← [Plan ana sayfası](../README.md) · Doğrulama fazı: [1.5](../phases/phase-1.5-perf.md)

> **Durum:** Bu sayılar bir **prototipten** (`apps/map-spike`: kendi sade store'u, doğrudan
> MapLibre/deck.gl çağrıları) gelir ve mimari kararlara yön vermek için kullanıldı. Gerçek paketlerle
> (`@c2/map-core` + `@c2/map-maplibre`) yapılmış bir ölçüm değildir; aynı senaryolar
> [Faz 1.5](../phases/phase-1.5-perf.md)'te tekrarlanıp buraya karşılaştırma olarak eklenecek.

Teoriyi ölçümle doğrulamak için ayrı bir deneme uygulaması yazıldı: sahte backend (her birlik
saniyede 1 mesaj), sade bir store, dört çizim modu ve canlı ölçüm paneli.
Sürümler: MapLibre GL JS 6.14, deck.gl 9.4, milsymbol 3.0.4 (APP-6 D).

Çalıştırma: `pnpm spike` — URL parametreleri: `?n=50000&mode=deck&smooth=0&z=9`.

> **Ölçüm ortamı:** Headless Edge, gerçek GPU (Intel UHD, entegre), 1400×900. Sayılar göreli
> karşılaştırma içindir; hedef donanımda yeniden ölçülmeli.
> **Önemli:** "Sayfa FPS"i haritanın yenilendiğini göstermez. Asıl ölçüt **harita çizimi / sn**
> (MapLibre `render` olayı) ve **işlenen mesaj / sn**'dir.

## Çizim modları

| Mod | Ne yapar |
|---|---|
| 1. Her mesajda çiz | Mesaj başına bir `updateData` çağrısı (kötü yol, karşılaştırma için) |
| 2. Biriktir + hepsini gönder | Saniyede 10 kez `setData` ile tüm veri |
| 3. Biriktir + yalnız değişeni | Saniyede 10 kez `updateData` ile yalnız değişenler |
| 4. deck.gl | Saniyede 10 kez değişenleri GPU'ya giden düz sayı dizilerine yaz |

## Sonuçlar (APP-6 sembolleriyle, 240 benzersiz sembol)

| Senaryo | Harita çizimi / sn | İşlenen mesaj / sn | Ana thread besleme işi | Yorum |
|---|---|---|---|---|
| Mod 1, 10k (ok ikonlarıyla) | — | ~1.900 / 10.000 | ~650 ms/sn | Tarayıcı mesajlara yetişemiyor |
| Mod 3, 10k | 14 | ~8.400 / 10.000 | 6 ms/sn | Kullanılabilir |
| Mod 4, 10k | 10 | 10.000 / 10.000 | 2 ms/sn | Rahat |
| Mod 4 + akıcı, 10k | 46 | 10.000 / 10.000 | 19 ms/sn | Akıcı |
| **Mod 3, 50k** | **0** | 49.600 / 50.000 | 160 ms/sn | **Harita donuyor**: MapLibre işçisi yetişemiyor |
| Mod 4, 50k | 10 | 50.000 / 50.000 | 3 ms/sn | Rahat |
| Mod 4 + akıcı, 50k, genel görünüm (z 6.5) | 16 | 50.000 / 50.000 | 14 ms/sn | GPU sınırında (üst üste binen semboller) |
| Mod 4 + akıcı, 50k, z 9 | 48 | 50.000 / 50.000 | 44 ms/sn | Akıcı |

## Çıkarımlar

1. **Batch (biriktir, kare başına tek gönderim) en büyük kazanç:** mod 1 → 2'de ana thread
   yükü ~100 kat düşüyor.
2. **Yalnız değişeni göndermek, hepsini göndermekten her zaman iyi** (mod 3 > mod 2), çünkü
   1 Hz'de her gönderimde birliklerin yalnız ~%10'u değişiyor.
3. **MapLibre GeoJSON kaynağının tavanı ~10k–20k.** `updateData` yalnız değişeni alsa da işçi
   indeksi ve sembol yerleşimini kaynağın tamamı için yeniden kuruyor; 50k'da harita hiç
   yenilenmiyor → canlı birlikler için deck.gl ana yol oldu.
4. **deck.gl'de 50k'daki sınır veri değil, ekranda aynı anda boyanan sembol sayısı.**
   Yakınlaştırınca sorun kayboluyor → LOD zorunlu.
5. **Store / birleştirme / "ne değişti" listesi iki motorda da aynen kullanıldı.**
   Çekirdek–adapter ayrımı pratikte doğrulandı.

## Uyumluluk notları

- **MapLibre 6 + Vite:** MapLibre worker dosyasını kendi yanında arar; paketlenince yol kırılır.
  `import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'; setWorkerUrl(workerUrl)` şart.
- **MapLibre 6 ikon yükleme:** `styleimagemissing` olayı artık ikonu o istek için sağlayamıyor;
  `map.setMissingStyleImageResolver(id => map.addImage(...))` kullanılmalı.
- **deck.gl 9.4 ↔ MapLibre 6:** `@deck.gl/mapbox` 9.4.0 + `MapboxOverlay` (interleaved),
  MapLibre'nin iç `map.transform` alanını okuyor; MapLibre 6.14'te bu alan `map._camera.transform`'a
  taşındı ve deck.gl her karede çöktü. Spike'ta `map.transform` getter'ı ile yamalandı.
  deck.gl dokümanında MapLibre 6 uyumluluğu belirtiliyor → Faz 1'de dokümandaki yöntem
  uygulanacak, bu senaryo test edilecek ([karar #16](../decisions.md)).
- **deck.gl ikili (binary) veri:** Aynı typed array referansı tekrar verilirse deck.gl güncellemeyi
  atlıyor. Her güncellemede diziyi **yeni bir sarmalayıcı nesneyle** (`{ value, size }`) verip
  `updateTriggers` sürüm sayacını artırmak gerekiyor; değişmeyen öznitelikler yeniden hesaplanmıyor.
- **milsymbol çapası:** Sembolün çapa noktası (çerçeve merkezi) görüntünün ortasında değil
  (kademe işareti üstte). Sembol, çapa ortaya gelecek şekilde boşluklu bir tuvale çiziliyor.

## Prototipte gözlenenler / gerçek paketlerle doğrulanacaklar

Prototipte gözlenen (gerçek paketlerle tekrarı [Faz 1.5](../phases/phase-1.5-perf.md)'te):

- `updateData` maliyeti: 10k'ya kadar kabul edilebilir, 50k'da harita donuyor.
- deck.gl ikili dizilerle 50k × 1 Hz: ana thread ~3 ms/sn, her flush ekrana yansıyor.
- APP-6 sembol önbelleği: 50k birlik → 240 görüntü.

Prototipte hiç ölçülmeyen:

- String `promoteId` ile `updateData` davranışı (spike sayısal `feature.id` kullandı) → Faz 1.5
- Sembol çakışma (collision) hesabının maliyeti → Faz 1.5
- LOD eşikleri, nokta modunda 50k'da çizim/sn → Faz 3.5
- Kümeleme maliyeti → Faz 4.2
- Hedef donanımda ölçüm → Faz 1.5 (ve Faz 4.4'te tekrar)

## Gerçek paketlerle karşılaştırma

_Faz 1.5'te (gerçek `@c2/map-maplibre` ile) doldurulacak: her senaryo için spike değeri ↔ gerçek boru hattı değeri._

### Ön ölçüm: gerçek çekirdek + spike adapter'ları (2026-10-13)

`apps/map-spike/core.html`: yük üreteci → `@c2/map-core` (store + MapSync + EventRouter) → spike'ta
yazılmış ince adapter'lar (`src/core/maplibre-adapter.ts`, `src/core/deck-adapter.ts`). Adapter'lar
Faz 1'in taslağıdır, nihai değildir. Aynı oturumda eski spike sayfası da yeniden ölçüldü.
Ortam: headless Edge, gerçek GPU (Intel UHD), 1400×900.

| Senaryo | Harita çizimi / sn (spike → çekirdek) | En uzun kare (ms) | İşlenen mesaj / sn | Ana thread işi (ms / sn) |
|---|---|---|---|---|
| MapLibre, 10k | 25 → 32 | 42 → 34 | 9.500 → 9.917 | 3 → 24 |
| MapLibre, 50k | 4 → 1 | 183 → 192 | 30.000 → 42.540 | 32 → 141 |
| deck.gl, 50k | 10 → 9 | 25 → 17 | 52.073 → 50.000 | 4 → 113 |
| deck.gl + akıcı, 50k, z 6.5 | 21 → 22 | 75 → 50 | 50.808 → 49.184 | 17 → 111 |
| deck.gl + akıcı, 50k, z 9 | 74 → 73 | 17 → 17 | 49.188 → 49.184 | 40 → 130 |

> "Ana thread işi" iki sayfada aynı şeyi ölçmüyor: spike yalnız haritayı besleme anını sayıyordu
> (kendi store'una yazma ölçülmüyordu); çekirdek sayfası **mesajdan patch üretimi + store transaction +
> MapSync flush + adapter**'ın toplamını sayıyor.

Çıkarımlar:

1. **Çekirdek, çizim performansını değiştirmedi:** harita çizim hızı ve en uzun kare her senaryoda spike ile
   aynı aralıkta. deck.gl 50k'da her flush ekrana yansıyor, takılma yok (long task 0).
2. **MapLibre GeoJSON yolu 50k'da yine donuyor** (1–4 çizim/sn) — sorun çekirdekte değil, MapLibre işçisinde.
   Canlı birlikler için deck.gl kararı (#15) doğrulandı.
3. **Çekirdeğin bedeli 50k × 1 Hz'de ~110–140 ms/sn (ana thread'in ~%11–14'ü).** Node ölçümünde ~70 ms/sn idi;
   fark tarayıcıdaki ek işler (patch nesnesi üretimi, adapter dizileri). Bütçeyi aşmıyor ama en büyük
   iyileştirme alanı burası; MapSync'in en uzun flush'ı 5–6 ms (bütçe 4). Hangi parçanın ne kadar tuttuğu
   (store / flush / adapter) ayrı ölçülmeli → Faz 1.5.3 iyileştirmeleri.
4. **String `promoteId` + `updateData` çalışıyor:** birlik id'leri string (`u123`), kaynak `promoteId: 'id'`;
   güncelleme, silme ve feature-state (seçim/hover halkası) sorunsuz.
5. **Uçtan uca etkileşim çalışıyor:** tıklama → adapter hit-test → EventRouter → `store.select` → MapSync →
   adapter state → seçim halkası; seçili birlik kartı `subscribeFeature` ile canlı güncelleniyor.
6. Yan bulgu: hover/seçim halkası katmanında yarıçap 0 olsa da çerçeve çiziliyordu (her birlikte nokta);
   `circle-stroke-opacity` ile düzeltildi (eski spike sayfasında da).

## Tam nesne ↔ kısmi patch (2026-10-13)

Karar #10: backend her mesajda birliğin tamamını gönderebilir (en kötü durum). Store, referansı
değişmiş ama içeriği aynı alanların eski referansını korur (`store/stabilize.ts`); böylece yalnız
konumu değişen birlik için adapter'a yalnız `GEOMETRY` biti gider.

**Node, yalnız store** (mesaj nesneleri ölçüm dışında üretildi; 50k mesaj/sn, 20 paket):

| | Medyan (ms/sn) | p95 |
|---|---|---|
| Kısmi patch | 46–48 | 72–100 |
| Tam nesne | 87–98 | 123–129 |
| MapSync flush %10, kısmi patch / tam nesne | 2,2–2,4 / 2,5–2,8 ms | GC'ye bağlı sıçramalar |

İçerik karşılaştırmasının etkisi (A/B, stabilize kapalı ↔ açık):

- **Kapalıyken** tam nesne akışında adapter'a fazladan bitler gidiyor (`props`/`style` "değişti") →
  deck.gl her flush'ta 50k ikonu yeniden hesaplardı. Doğrulama bunu yakalıyor.
- İlk sürüm kısmi patch'e de ~%20 bedel ekledi (53 → 64 ms/sn). Geometriye özel karşılaştırma
  (koordinatlar doğrudan sayı olarak, nesne üretmeden) ve anahtar dizisi üretmeden sayım ile bu
  bedel sıfırlandı (→ ~47–52); tam nesne 128 → ~90–110.

**Tarayıcı, deck.gl 50k** (`core.html?format=full|patch`, akış yardımcısı üzerinden):

| | Harita çizimi / sn | En uzun kare | Çekirdek + besleme işi |
|---|---|---|---|
| Kısmi patch | 10 | 25 ms | 105 ms/sn |
| Tam nesne | 10 | 17 ms | 139 ms/sn |

Sonuç: en kötü durum çalışıyor, harita tarafı etkilenmiyor; bedeli ana thread'de ~+%3–4.
Kalıcı çözüm: Faz 3.6 ingest Worker'ı tam nesneyi ana thread'e göndermeden önce patch'e çevirebilir
(son durumu Worker tutar) → ana thread her zaman ucuz yolda kalır.

## Çekirdek ölçümü — Node, motorsuz (2026-10-13)

Faz 1.5.3'ün tarayıcı gerektirmeyen kısmı. `@c2/map-core` (store + MapSync), hiçbir şey çizmeyen
sahte adapter ile; 50.000 birlik, 5 alt katman × 10k. Çalıştırma: `pnpm --filter @c2/map-core bench`.
Ortam: Node 24.20, Windows x64 (geliştirici makinesi). İki çalıştırmanın aralığı verilmiştir.

| Senaryo | Medyan (ms) | p95 (ms) | Bütçe (ms) | Sonuç |
|---|---|---|---|---|
| Store: 1 sn'lik akış (50k konum, 20 paket) | 51–54 | 60–71 | 100 / sn | ✓ ana thread'in ~%5'i |
| Aynı akış + 200 unsur abonesi | 47–58 | 66–81 | 100 / sn | ✓ abonelerin maliyeti ihmal edilebilir |
| MapSync flush: 5.000 değişen (%10, 10 Hz'de bir flush) | 2,1–2,2 | 3,6–**4,6** | 4 | ⚠ medyan rahat, p95 sınırda (GC) |
| MapSync flush: 500 değişen (%1) | 0,2 | 0,2–0,4 | 4 | ✓ |
| MapSync flush: 5.000 yalnız-META | 1,5–1,9 | 2,2–2,5 | 4 | ✓ ama boşa iş (aşağıda) |
| 10k unsurlu katmanı kapat/aç | 4,3–4,7 | 9,0 | 16 | ✓ |
| Katman taşı (50k tam değerlendirme) | 22–24 | 33–46 | 50 | ✓ nadir işlem |
| 100 unsurluk seçim değişimi | 0,04 | 0,1 | 4 | ✓ |
| MapSync ilk senkron (50k) | 25 | 40–44 | — | açılışta bir kez |
| Store: 50k ilk yükleme | 83 | 109–117 | — | açılışta bir kez |
| 10k snapshot, içerik aynı / %10 değişmiş | 4,2–4,4 / 5,1–5,4 | 8,6–12,5 / 6,4–10,3 | — | yeniden bağlanma |

Çıkarımlar:

1. **50k × 1 Hz'in çekirdekteki toplam maliyeti ≈ %7 ana thread:** store ~50 ms/sn + 10 flush × ~2 ms.
   Spike'ın deck.gl modundaki ~3 ms/sn yalnız motoru besliyordu (gerçek store yoktu); fark çekirdeğin
   (birleştirme, maske, `rev`, abonelik) maliyetidir. Kabul edilebilir; ölçümdeki store yükünün bir
   kısmı patch nesnelerinin üretimidir (gerçekte JSON parse da üretir → Faz 3.6 Worker bunu ana thread'den alır).
2. **Flush p95'i 4 ms sınırında.** Medyan yarısı kadar; kuyruk GC kaynaklı görünüyor. İyileştirme adayları:
   `rendered` girdilerini yeniden kullanmak (nesne üretimini azaltmak), değerlendirme döngüsünde nesne yaratmamak.
3. **Yalnız-META değişimi boşa ~1,5–2 ms harcıyor:** sonuç doğru (adapter'a hiçbir şey gitmiyor) ama MapSync
   her unsur için katman çözümü ve karşılaştırma yapıyor. Katman değişikliği yoksa `VISUAL` biti olmayan
   UPDATE'ler doğrudan atlanabilir (küçük ve güvenli bir değişiklik).
4. Kullanıcı işlemleri (katman aç/kapa, taşıma, seçim) bir karenin içinde veya çok yakınında.
