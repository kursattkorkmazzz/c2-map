import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // ingest Worker'ı ES modülü (core.html?ingest=worker)
  worker: { format: 'es' },
  build: {
    target: 'es2022', // sayfalar top-level await kullanıyor
    rolldownOptions: {
      input: {
        spike: resolve(import.meta.dirname, 'index.html'), // eski 4 modlu spike (referans)
        core: resolve(import.meta.dirname, 'core.html'), // @c2/map-core boru hattı
        react: resolve(import.meta.dirname, 'react.html'), // @c2/map-react
      },
    },
  },
});
