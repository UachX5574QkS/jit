import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Use relative paths for APEX static file deployment
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/ords': {
        target: 'https://ldldfcndl8jbd1z-jitdemodatabase.adb.uk-london-1.oraclecloudapps.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
