# Faz 0.5 — Performans spike'ı (`apps/map-spike`)

← [Plan ana sayfası](../README.md) · Durum: ✅ (LOD spike'ı kaldı)

**Amaç:** Mimari varsayımları gerçek ölçümle doğrulamak. Sonuçlar: [spike/findings.md](../spike/findings.md).

- [x] Sahte backend (yük üreteci): N birlik, birlik başına ayarlanabilir Hz
- [x] Sade store + "ne değişti" listesi
- [x] Mod 1: her mesajda çiz
- [x] Mod 2: biriktir + `setData`
- [x] Mod 3: biriktir + `updateData` (yalnız değişen)
- [x] Mod 4: deck.gl (typed array)
- [x] Akıcı hareket (deck.gl)
- [x] APP-6(D) sembolleri (`milsymbol`), MapLibre resolver + deck.gl atlas
- [x] Ölçüm paneli: harita çizimi/sn, işlenen mesaj/sn, besleme işi, en uzun kare, long task
- [x] Gerçek GPU ile otomatik ölçüm (Playwright + Edge)
- [ ] **LOD spike'ı:** uzak zoom'da nokta (`ScatterplotLayer`), yakın zoom'da sembol; eşik değerleri; 50k'da çizim/sn
- [ ] (İsteğe bağlı) Kümeleme maliyeti ölçümü (supercluster)
- [ ] (İsteğe bağlı) String `promoteId` + `updateData` doğrulaması
- [ ] Hedef donanımda yeniden ölçüm
