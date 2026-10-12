# 10 — Test ve ölçüm

← [Plan ana sayfası](../README.md)

## Birim testleri (Vitest, Node ortamı)

- **`MapStore`:** transaction, birleştirme tablosunun her satırı, `rev` düşürme,
  `replaceLayerContents`, katman cascade/taşıma/döngü, seçim/hover, id bazlı abonelik
  (kaç kez çağrıldığı dahil), iç içe transaction, değişmezlik (referanslar).
- **`MapSync`:** efektif görünürlük/opaklık/zIndex, katman aç/kapa → doğru batch, META filtresi,
  zoom eşiği, yetim unsur, sunum aşaması zinciri — `MockAdapter` ve elle tetiklenen zamanlayıcı ile.
- **`EventRouter`:** hedefli/global dağıtım, kabarma sırası, `stopPropagation`, abonelikten çıkma.
- Çekirdek testleri DOM'suz koşar (`environment: 'node'`); çekirdeğin DOM'a bağımlı olmadığını da doğrular.

## Performans ölçümü

- **Yük üreteci:** sentetik 3k / 10k / 50k unsur, 1 Hz konum + rastgele stil değişimi
  (spike'taki üreteç temel alınır).
- **Demo paneli göstergeleri:** harita çizimi/sn, işlenen mesaj/sn, ana thread besleme işi,
  en uzun kare, long task.
- **Otomatik perf testi:** Playwright + sistem tarayıcısı, **gerçek GPU ile**
  (`--enable-gpu --use-angle=d3d11`). GPU'suz (SwiftShader) ölçümler FPS için yanıltıcıdır.
- Hedef donanımda yeniden ölçüm ([karar #19](../decisions.md)).

## Görsel / entegrasyon

Playwright (isteğe bağlı): sembol yerleşimi, katman sırası, seçim halkası ekran görüntüleri.
