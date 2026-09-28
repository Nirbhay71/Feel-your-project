import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import feel from '@feel-dev/vite-plugin';

export default defineConfig(({ mode }) => {
  // Same demo/.env the API server uses.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    // `database` lets the Feel panel read table structure and changes.
    plugins: [feel({ database: env.DATABASE_URL }), react()],
    resolve: {
      // import x from '@/api.js'  →  src/api.js
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      // Forward API calls to the Express server (demo/server).
      proxy: { '/api': 'http://localhost:3001' },
    },
  };
});
