// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Sitio 100% estático (default en Astro 5): sin adapter, sin SSR.
// https://astro.build/config
export default defineConfig({
  site: 'https://argos.navori.tech',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
