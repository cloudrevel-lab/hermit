import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'

// In dev the API runs as a separate process on an auto-assigned port; the
// start script passes it through as API_URL. In production the same Express
// process serves this build, so no proxy is involved.
const apiUrl = process.env.API_URL || 'http://127.0.0.1:3001'

export default defineConfig({
  root: 'web',
  plugins: [vue(), vuetify({ autoImport: true })],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 0,          // let the OS pick a free port
    strictPort: false,
    proxy: { '/api': { target: apiUrl, changeOrigin: true } },
    // Transform the entry and pages up front so Vite finishes pre-bundling
    // before the first request, instead of 504-ing mid-navigation.
    warmup: { clientFiles: ['./src/main.js', './src/App.vue', './src/pages/*.vue'] }
  },
  optimizeDeps: { include: ['vue', 'vue-router', 'vuetify'] }
})
