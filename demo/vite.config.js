import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import feel from '@feel/vite-plugin';

export default defineConfig({
  plugins: [feel(), react()],
  server: {
    // Forward API calls to the Express server (demo/server).
    proxy: { '/api': 'http://localhost:3001' },
  },
});
