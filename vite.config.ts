import { defineConfig } from 'vite';

export default defineConfig({
  base: '/neurotone/',
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
