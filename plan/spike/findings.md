# Spike bulguları (`apps/map-spike`)

← [Plan ana sayfası](../README.md) · Faz: [0.5](../phases/phase-0.5-spike.md)

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

## Doğrulananlar / kalanlar

- ✅ `updateData` maliyeti: 10k'ya kadar kabul edilebilir, 50k'da harita donuyor.
- ✅ deck.gl ikili dizilerle 50k × 1 Hz: ana thread ~3 ms/sn, her flush ekrana yansıyor.
- ✅ APP-6 sembol önbelleği: 50k birlik → 240 görüntü.
- ⏳ String `promoteId` ile `updateData` davranışı (spike sayısal `feature.id` kullandı).
- ⏳ Sembol çakışma (collision) hesabının maliyeti — spike'ta açılıp kapatılabiliyor, sistematik ölçülmedi.
- ⏳ LOD: eşik değerleri, nokta modunda 50k'da çizim/sn, kümeleme maliyeti.
- ⏳ Hedef donanımda yeniden ölçüm.
