# Faz 1.5 — Performans doğrulaması (gerçek paketlerle)

← [Plan ana sayfası](../README.md) · Durum: ⬜ · Önkoşul: Faz 1 (adapter + demo + yük üreteci)

**Amaç:** Mimari varsayımları **gerçek paketlerle** ölçmek: `@c2/map-core` (store + MapSync) +
`@c2/map-maplibre` (MapLibre + deck.gl renderer'ı) + `@c2/map-react` demo uygulaması.

> **Önceki spike ile ilişkisi:** `apps/map-spike` bir prototipti (kendi sade store'u, doğrudan
> MapLibre/deck.gl çağrıları). Oradaki sayılar **referans değer** olarak
> [spike/findings.md](../spike/findings.md)'de duruyor; bu fazda aynı senaryolar gerçek boru hattıyla
> tekrarlanıp karşılaştırılır. Spike'ta "yapıldı" sayılan hiçbir şey bu fazda yapılmış sayılmaz.

**Bitti sayılması için:**

- [ ] Spike senaryolarının tamamı gerçek boru hattıyla ölçüldü ve karşılaştırma tablosu `spike/findings.md`'ye eklendi
- [ ] [Hedef bütçeler](../design/04-sync-and-rendering.md#hedef-bütçeler) tutuyor (tutmayan varsa nedeni ve çözüm planı yazıldı)
- [ ] Otomatik perf testi tekrar çalıştırılabilir durumda (tek komut)

## 1.5.1 Ölçüm altyapısı

- [ ] Yük üreteci gerçek store'a yazar (WS paketi → tek `transaction`); birlik sayısı ve Hz ayarlanabilir
- [ ] Ölçüm paneli demo uygulamasında: harita çizimi/sn, işlenen mesaj/sn, ana thread besleme işi, en uzun kare, long task
- [ ] Gerçek GPU ile otomatik perf testi (Playwright + sistem tarayıcısı, `--enable-gpu --use-angle=d3d11`); sonuçları tablo olarak yazar

## 1.5.2 Spike senaryolarının tekrarı

Her senaryo için spike değeri ile gerçek boru hattı yan yana yazılır.

- [ ] 10k birlik × 1 Hz — deck.gl renderer'ı, akıcı hareket kapalı / açık
- [ ] 50k birlik × 1 Hz — deck.gl renderer'ı, akıcı hareket kapalı / açık; genel görünüm (z 6.5) ve yakın (z 9)
- [ ] ~10k unsur MapLibre statik yolu (GeoJSON `updateData`) — seyrek değişen veri için tavanın doğrulanması
- [ ] Batch etkisi: "her mesajda uygula" ile karşılaştırma (yalnız ölçüm amaçlı bir ayar ile)

## 1.5.3 Çekirdek maliyeti

Tarayıcı gerektirmeyen kısım Faz 1'den önce Node'da ölçüldü (`pnpm --filter @c2/map-core bench`,
sonuçlar: [spike/findings.md](../spike/findings.md#çekirdek-ölçümü--node-motorsuz-2026-10-13)).

- [x] Store: 50.000 mesaj/sn yazma maliyeti (transaction + günlük + abonelik bildirimi) — ~50 ms/sn (%5) ✓
- [x] MapSync: 50k unsurda %10 değişimle flush süresi — medyan ~2,1 ms ✓, p95 3,6–4,6 ms ⚠ (bütçe 4 ms)
- [x] Katman aç/kapa (10k) ~4,5 ms ve katman taşıma (50k tam değerlendirme) ~23 ms ✓
- [x] Id bazlı abonelerin store yazma maliyetine etkisi (200 abone) — ihmal edilebilir ✓
- [ ] İyileştirme: yalnız-META UPDATE'leri katman değişikliği yokken MapSync'te doğrudan atla (şu an ~1,5–2 ms boşa)
- [ ] İyileştirme: flush p95'ini düşür (değerlendirme döngüsünde nesne üretimini azalt); sonra yeniden ölç
- [ ] Aynı ölçümün tarayıcıda (V8 + gerçek adapter ile) tekrarı — Faz 1 sonrası
- [ ] React: 200 id bazlı abone varken (kart, tablo satırı) yeniden çizim sayısı — `@c2/map-react` gerekli

## 1.5.4 MapLibre ve deck.gl ayrıntıları

- [ ] String `promoteId` + `updateData` davranışı (spike sayısal `feature.id` kullanmıştı)
- [ ] Sembol çakışma (collision) hesabının maliyeti
- [ ] deck.gl ↔ MapLibre 6 entegrasyonu (dokümandaki yöntem) altında 50k performansı ([karar #16](../decisions.md))
- [ ] `MOTION_MODE.AUTO` eşiklerinin (ör. 25 / 45 çizim/sn) gerçek ölçümle ayarlanması

## 1.5.5 Hedef donanım

- [ ] Operatör iş istasyonu sınıfında yeniden ölçüm ([karar #19](../decisions.md))

## Başka fazlara taşınan ölçümler

- LOD eşikleri ve nokta modunda 50k çizim/sn → [Faz 3.5](phase-3-symbology.md#35-lod) (LOD orada yazılıyor)
- Kümeleme maliyeti (supercluster) → [Faz 4.2](phase-4-composite-scale.md#42-kümeleme)
