import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  server: {
    host: '0.0.0.0',

    // Allow LocalTunnel to access the Vite development server
    allowedHosts: true,

    // Send frontend /api requests to the local FastAPI backend
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,

        // /api/upload -> /upload
        // /api/projects -> /projects
        // /api/dashboard/stats -> /dashboard/stats
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})