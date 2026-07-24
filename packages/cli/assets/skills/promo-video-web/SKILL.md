---
name: promo-video-web
description: Trigger: webapp promo, dashboard promo, web promo video, promo del dashboard, promo de la web, landing video, product demo video. Generate branded promotional MP4s for web surfaces (web app, admin dashboard) with Remotion + Playwright captures.
---

# Promo Video — Web Surfaces

## Activation Contract

Activate when a web surface — the product web app (`apps/web`) or the admin dashboard (`apps/dashboard`) — needs a promotional/marketing video. Each surface gets its OWN composition and MP4 (different audience, different register). Mobile app promos belong to `promo-video`.

## Hard Rules

- Same isolation rule as `promo-video`: the Remotion project lives at `tools/promo/` OUTSIDE npm workspaces. If `tools/promo/` already exists (mobile promo), ADD compositions to it — never create a second Remotion project.
- Captures come from the REAL running app via Playwright against seeded demo data — never mockups. Fixed viewport 1920×1080, `deviceScaleFactor: 2` (crisp 2x assets). Dashboard captures log in with demo credentials injected via env vars — never hardcoded in the capture script.
- Capture stability is a gate: `headless: true` strictly enforced (the agent must never hang waiting for a GUI in terminal environments), and every capture waits for `networkidle` PLUS explicit unmount of spinners/skeletons PLUS a real-data selector — a capture showing a loading state is a quality failure.
- Brand fidelity: colors/fonts from the surface's own token source (web CSS vars / tailwind theme); copy from the product definition — never invent claims.
- Register per surface: web app = product marketing (benefit-led copy); dashboard = operator tool (calm, outcome-led copy: "manage X in seconds", no hype). A dashboard promo that reads like a consumer ad is a quality failure.
- Landscape 1080p (1920×1080@30) default for web surfaces; vertical only on explicit request.
- On-screen copy in the product's locale; code and comments in English.
- Foreground renders only; TransitionSeries timeline math (total = Σ durations − Σ overlaps) — same as `promo-video`.

## Decision Gates

| Situation | Route |
|---|---|
| Which surface | One composition per surface: `PromoWeb`, `PromoDashboard` — separate MP4s, separate copy registers |
| `tools/promo/` exists | Add `src/web/` sources + compositions + `render:web` / `render:dashboard` scripts; add `playwright` devDep |
| Motion instead of stills | Playwright `recordVideo` context while scripting the flow; embed via `<OffthreadVideo>` |
| App not deployed / no local stack | Capture against the local dev server with seeded data; block only if neither runs |
| Multiple surfaces share scene code | Drive COLOR tokens via `getInputProps()` + `--props=./<surface>-tokens.json` at render time instead of rewriting `theme.ts` per run; fonts stay code-level (`loadFont()` runs at module scope and cannot come from JSON) |

## Execution Steps

1. Read `references/pipeline.md`. Inventory: surface URL (local or deployed), demo credentials (env), token source, product copy, locale.
2. Seed a PREDICTABLE, isolated demo state first — on multi-tenant products, pass an explicit test-tenant ID via env (`PROMO_TENANT`) so captures never show empty states or another tenant's data.
3. Capture: adapt `assets/capture.template.ts`; run it (foreground, headless) to produce `public/web/*.png` (or clips) — authenticate, wait for the state to hydrate (spinners/skeletons unmounted, real-data selector present), then snap. Login flow for the dashboard, key screens per surface, 4–6 captures.
4. Scaffold or extend `tools/promo/` per the Decision Gates; map web tokens into a surface theme file (or per-surface `--props` token JSON — Decision Gates).
5. Build scenes on `assets/browser-promo.template.tsx`: intro lockup → 3–4 feature scenes (browser-chrome-framed capture with slow Ken Burns zoom, split copy layout) → CTA outro with the surface URL.
6. Render each composition foreground (`npx remotion render PromoWeb out/promo-web.mp4`, same for dashboard); add root scripts (cd form, per `promo-video`); verify duration/fps + `remotion still` spot-checks; deliver MP4s.

## Output Contract

Return: MP4 path(s) with duration/fps/size, capture inventory, files created, root scripts added, and which register was applied per surface.

## References

- `references/pipeline.md` — capture protocol, browser-frame scene system, per-surface registers, multi-composition layout, troubleshooting.
- `assets/capture.template.ts` — Playwright capture script (viewport, auth via env, screenshot set).
- `assets/browser-promo.template.tsx` — landscape scene architecture: browser chrome frame, Ken Burns, split copy layout, CTA outro.
- `assets/package.template.json` — deps when scaffolding fresh (Remotion pinned + playwright).
