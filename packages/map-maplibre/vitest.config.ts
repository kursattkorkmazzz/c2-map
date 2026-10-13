import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Testler gerçek MapLibre'yi (WebGL) yüklemez: adapter `MapLike` arayüzü üzerinden sahte
    // bir haritayla sınanır. Gerçek tarayıcı doğrulaması spike/demo uygulamasında yapılır.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
