import { createReadStream, existsSync, statSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Cesium'un çalışma zamanı dosyaları (Web Worker'lar, yıldız dokuları, …): `cesium/Build/Cesium`. */
const CESIUM_BUILD = resolve(dirname(createRequire(import.meta.url).resolve('cesium/package.json')), 'Build/Cesium');
const CESIUM_DIRS = ['Workers', 'Assets', 'ThirdParty', 'Widgets'];
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.glb': 'model/gltf-binary',
};

/**
 * Cesium bu dosyaları `CESIUM_BASE_URL` altından ister (cesium.html: `/cesium/`).
 * Geliştirmede node_modules'tan sunulur, derlemede `dist/cesium` altına kopyalanır.
 */
function cesiumStatic(): Plugin {
  let outDir = 'dist';
  return {
    name: 'c2-cesium-static',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/cesium', (req, res, next) => {
        const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!));
        const file = join(CESIUM_BUILD, path);
        if (!file.startsWith(CESIUM_BUILD) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    async closeBundle() {
      await Promise.all(CESIUM_DIRS.map((dir) => cp(join(CESIUM_BUILD, dir), join(outDir, 'cesium', dir), { recursive: true })));
    },
  };
}

export default defineConfig({
  plugins: [cesiumStatic()],
  // ingest Worker'ı ES modülü (core.html?ingest=worker)
  worker: { format: 'es' },
  build: {
    target: 'es2022', // sayfalar top-level await kullanıyor
    chunkSizeWarningLimit: 6000, // Cesium tek parça ~4 MB
    rolldownOptions: {
      input: {
        spike: resolve(import.meta.dirname, 'index.html'), // eski 4 modlu spike (referans)
        core: resolve(import.meta.dirname, 'core.html'), // @c2/map-core boru hattı
        react: resolve(import.meta.dirname, 'react.html'), // @c2/map-react
        cesium: resolve(import.meta.dirname, 'cesium.html'), // @c2/map-cesium (3B, arazi)
      },
    },
  },
});
