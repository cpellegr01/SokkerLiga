import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    /* One above SAM's dev ports (5173/5174), so both can run side by side. */
    port: 5175,
    /* By address, not by name: the API binds 127.0.0.1. */
    proxy: { '/api': 'http://127.0.0.1:5176' },
  },
});
