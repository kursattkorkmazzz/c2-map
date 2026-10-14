import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Bileşenler DOM ister (container, portal); harita motoru yok: testler core'un MockAdapter'ını kullanır.
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
