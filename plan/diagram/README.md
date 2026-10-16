# Diyagramlar

Kütüphanenin yapısını ve akışlarını gösteren Mermaid (`.mmd`) diyagramları.
VS Code'da bir Mermaid eklentisiyle ya da [mermaid.live](https://mermaid.live) üzerinde açılabilir.
Her dosyanın başındaki `%%` yorumları ne gösterdiğini ve nasıl okunacağını anlatır.

**Önerilen okuma sırası:** önce genel resim (01), sonra paketlerin içi (02–04, 09),
ardından çekirdeğin nerede kullanıldığı (05) ve en son çalışma anındaki akışlar (06–08).

## Yapı (flowchart)

| Dosya | Ne gösterir |
|---|---|
| [01-genel-mimari.mmd](01-genel-mimari.mmd) | Paketler (`map-core`, `map-maplibre`, `map-cesium`, `map-react`, `map-spike`), aralarındaki bağımlılık ve ana veri yolları |
| [02-core-yapisi.mmd](02-core-yapisi.mmd) | `@c2/map-core` klasörleri (model, store, events, sync, adapter, registry, ingest, actions, draw, edit, geo), ana sınıflar ve iç bağımlılıklar |
| [03-maplibre-entegrasyonu.mmd](03-maplibre-entegrasyonu.mmd) | `MaplibreAdapter`'ın içi: `applyBatch` sırası, MapLibre yolu ve deck.gl yolu (ikon / composite İHA), olaylar ve hit-test, altlıklar, katman yığını |
| [04-react-yapisi.mmd](04-react-yapisi.mmd) | `<Map>`'in oluşturdukları, context'ler, bileşenler ve hook'lar |
| [09-cesium-entegrasyonu.mmd](09-cesium-entegrasyonu.mmd) | `CesiumAdapter`'ın içi: ion'suz mount, `applyBatch`, renderer'lar (billboard · vector · İHA), arazi (Terrarium) ve altlıklar, hit-test, kamera eşlemesi, görüntü kalitesi |
| [05-core-kullanim-haritasi.mmd](05-core-kullanim-haritasi.mmd) | Çekirdeğin hangi parçası hangi dosyada, ne için kullanılıyor (`import`'lardan çıkarıldı; testler hariç) |

## Akışlar (sequence)

| Dosya | Ne gösterir |
|---|---|
| [06-akis-canli-veri.mmd](06-akis-canli-veri.mmd) | Backend mesajı → ingest (ana thread veya Worker) → store → MapSync → adapter → MapLibre / deck.gl |
| [07-akis-etkilesim.mmd](07-akis-etkilesim.mmd) | Tıklama / hover / sağ tık → hit-test (önce deck) → EventRouter kabarması → seçim → harita ve React'e yansıma |
| [08-akis-cizim-duzenleme.mmd](08-akis-cizim-duzenleme.mmd) | Çizim, taslakla düzenleme, kaydetme ve silme; `beforeCreate` / `beforeUpdate` / `beforeDelete` kancaları |

## Güncel tutma

Diyagramlar kodun **2026-10-16** hâlini yansıtır (Faz 2, 3.6, 4.1 ve Faz 5 ilk sürümü — Cesium — dahil).
Akış diyagramları (06–08) MapLibre adapter'ı üzerinden çizildi; Cesium'da adım adım aynıdır, yalnız
adapter içi farklıdır (09).
Modül eklendiğinde / taşındığında ilgili diyagram da aynı commit'te güncellenmelidir.
05 numaralı harita `import { … } from '@c2/map-core'` satırlarından üretildi; büyük değişiklikten sonra
aynı yöntemle yeniden çıkarılması önerilir.
