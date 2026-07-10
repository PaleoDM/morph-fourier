import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Dev mode: frontend on 5173, backend on 8000. All /api/* and
      // /photos/* requests are proxied to the backend so we don't have
      // to think about CORS in dev.
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/photos': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
