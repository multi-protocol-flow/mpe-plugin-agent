import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2018',
    minify: false,
    cssCodeSplit: false,
    assetsInlineLimit: 1000000000,
    chunkSizeWarningLimit: 2000,
    outDir: 'dist-viewer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        viewer: resolve(__dirname, 'viewer.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
