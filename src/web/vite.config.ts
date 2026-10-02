import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Only for `npm run dev` outside Compose: API paths go to the nginx gateway, which owns the routing
// (contracts.md#routing). In Compose the browser talks to the gateway directly.
const api = { target: process.env.API_URL ?? 'http://localhost:8080', changeOrigin: true }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    host: true,
    port: 5173,
    proxy: { '/events': api, '/admin': api, '/orders': api },
  },
})
