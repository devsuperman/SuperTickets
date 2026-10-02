import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Keep in sync with contracts.md#routing (availability route first).
const catalog = process.env.CATALOG_URL ?? 'http://localhost:5101'
const inventory = process.env.INVENTORY_URL ?? 'http://localhost:5102'
const order = process.env.ORDER_URL ?? 'http://localhost:5103'

const proxy = (target: string) => ({ target, changeOrigin: true })

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '^/events/[^/]+/availability$': proxy(inventory),
      '/events': proxy(catalog),
      '/admin': proxy(catalog),
      '/orders': proxy(order),
    },
  },
})
