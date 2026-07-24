---
name: astro
description: Trigger: Astro site, landing page, marketing site, static site, app web. Astro 5 patterns: zero-JS defaults, islands, content collections, Tailwind 4 via Vite.
---

# Astro 5

## Activation Contract

Activate when building or editing an Astro site — landing pages, marketing sites, docs, or any static-first web.

## Hard Rules

- Static output by default. Add an adapter/SSR only when a route genuinely needs per-request rendering.
- Zero client JS by default: build with `.astro` components. Hydrate only real interactivity, with the narrowest `client:*` directive that works.
- Repeating content (features, FAQs, testimonials, posts) lives in content collections (`src/content.config.ts`, `defineCollection` + zod schema, `glob`/`file` loaders) — never hardcoded arrays inside pages.
- Tailwind 4 via the `@tailwindcss/vite` plugin. Do NOT use the deprecated `@astrojs/tailwind` integration.
- Local images through `astro:assets` `<Image>`, not raw `<img>`.
- Every page renders `<title>` and meta description through a shared layout; install `@astrojs/sitemap`.

## Decision Gates

| Situation | Action |
|-----------|--------|
| Component needs interactivity | Try CSS/native HTML first; else a framework island with `client:visible` (or `client:idle`); `client:load` only for above-the-fold critical UI |
| Content will repeat or grow | Content collection with zod schema |
| One route needs fresh per-request data | Server island (`server:defer`) before converting the site to SSR |
| Dynamic routes from content | `getStaticPaths()` + `getCollection()` |

## Execution Steps

1. Scaffold: `npm create astro@latest` (template: minimal), add Tailwind 4 via `@tailwindcss/vite`.
2. Create `src/layouts/Base.astro` with head, meta, fonts, and design tokens.
3. Build pages under `src/pages/`; extract repeating content to collections.
4. Verify: `astro build` passes and `astro preview` renders correctly; confirm no unintended client JS shipped.

## Output Contract

A site that builds statically (`astro build` clean), ships zero JS unless justified, and lists every island added with its directive and reason.
