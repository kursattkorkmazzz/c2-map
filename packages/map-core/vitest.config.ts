import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', // çekirdek DOM'a bağımlı olmamalı
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
