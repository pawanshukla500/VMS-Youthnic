import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Manual chunks pull the heaviest deps out of the main bundle so the very
// first paint of the Login page only loads the React + router shell. Routes
// that need recharts (Dashboard) and the upload worker (PackingStation) get
// their own chunks; firebase lands in its own so it is fetched once and
// shared across every page.
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('firebase')) return 'firebase';
          if (id.includes('recharts')) return 'recharts';
          if (id.includes('react-router')) return 'react-router';
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('scheduler/')
          ) {
            return 'react-vendor';
          }
          if (
            id.includes('/lucide-react/') ||
            id.includes('/idb/') ||
            id.includes('/swr/') ||
            id.includes('/react-hot-toast/')
          ) {
            return 'client-vendor';
          }
          return undefined;
        }
      }
    }
  }
});