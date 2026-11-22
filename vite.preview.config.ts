import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
export default defineConfig({
  root: resolve('./src/renderer'),
  base: './',
  resolve: { alias: {
    '@shared': resolve('./src/shared'),
    '@': resolve('./src/renderer')
  }},
  plugins: [react()],
  build: {
    outDir: '/tmp/mh-preview',
    emptyOutDir: true,
    rollupOptions: { input: resolve('./src/renderer/index.html') }
  }
})
