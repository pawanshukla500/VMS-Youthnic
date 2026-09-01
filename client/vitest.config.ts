import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    environment: 'node',
    globals: true
  }
});