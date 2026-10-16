import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Cesium'un matematik / Entity / koleksiyon sınıfları Node'da çalışır (WebGL gerekmez): renderer'lar
    // gerçek Cesium nesneleriyle sınanır. Sahne / GPU gerektiren yerler sahte bağlamla. Gerçek tarayıcı
    // doğrulaması spike'ta (cesium.html).
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
