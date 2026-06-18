import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import cesium from 'vite-plugin-cesium';

// Dev: Python (port 80) redirects SPA traffic here; Vite proxies API + WS back
// to Python. Browser lands on http://localhost first, then stays on Vite's port
// for HMR.
//
// pnpm hoists cesium to .pnpm/cesium@<version>/, not local node_modules.
// Resolve the real install location so the plugin finds Build/Cesium.
//
// rebuildCesium: true bundles cesium through Vite instead of an external
// <script> tag, so lazy(() => import('./MapView')) actually code-splits the
// ~3MB into MapView's chunk rather than loading it on every page.
const require = createRequire(import.meta.url);
const cesiumRoot = dirname(require.resolve('cesium/package.json'));
const cesiumBuildRootPath = join(cesiumRoot, 'Build');
const cesiumBuildPath = join(cesiumRoot, 'Build', 'Cesium');

export default defineConfig({
  plugins: [
    preact(),
    cesium({
      rebuildCesium: true,
      cesiumBuildRootPath,
      cesiumBuildPath,
    }),
  ],
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      // /_* are platform API endpoints served by the Python host
      // (/_plugins, /_meta, /_stats, ...). Regex prefix catches new ones.
      '^/_.*': 'http://localhost:80',
      '/api': 'http://localhost:80',
      '/ws/bus': {
        target: 'ws://localhost:80',
        ws: true,
      },
    },
  },
});
