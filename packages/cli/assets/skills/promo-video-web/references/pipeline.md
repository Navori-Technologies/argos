# Promo Video (Web Surfaces) — Runbook

Extends the `promo-video` pipeline for landscape web-surface promos. Shared fundamentals (workspace isolation, timeline math, foreground renders, verify protocol) are identical — this file covers only what differs.

## §1 Capture protocol (Playwright)

- Adapt `assets/capture.template.ts`. Run with `npx playwright install chromium` done once, then `npx tsx capture.ts` (or `node` after tsc) from `tools/promo/` — FOREGROUND, and `headless: true` set explicitly on `chromium.launch()`: in a terminal environment a headed browser hangs the agent waiting for a GUI.
- Viewport fixed at 1920×1080, `deviceScaleFactor: 2` → 3840×2160 PNGs; the browser frame downscales them crisp.
- Target: local dev server with seeded demo data (preferred — deterministic) or the deployed URL. 4–6 captures per surface, each a distinct feature screen.
- Multi-tenant products: seeding credentials is not enough — the STATE must be predictable. Seed an isolated demo tenant and pass its ID via env (`PROMO_TENANT`); the script scopes every navigation to it. This guarantees no empty states and no leakage of another tenant's data into the capture.
- Dashboard auth: credentials from env (`PROMO_EMAIL` / `PROMO_PASSWORD`), never hardcoded. Sequence per capture: authenticate → wait for the state to hydrate (`networkidle` AND spinners/skeletons UNMOUNTED — wait `state: 'detached'` on known loading selectors — AND a real-data selector present) → snap. Async dashboards (tables, metrics, payments) render piecemeal; `networkidle` alone still shows skeletons.
- Hide flaky UI before capture: dismiss toasts/cookie banners, `page.addStyleTag` to disable CSS animations (`*{animation:none!important;transition:none!important}`) so captures are stable.
- Motion variant: `browser.newContext({recordVideo: {dir, size}})`, script the flow slowly (deliberate 800ms pauses between actions), close context to flush the webm, convert to mp4 with ffmpeg, embed via `<OffthreadVideo>`.

## §2 Project layout (multi-composition)

If `tools/promo/` exists (mobile promo), extend it — one Remotion project, several compositions:

```
tools/promo/
├── capture/capture.ts          # Playwright capture script
├── public/                     # mobile assets (existing)
├── public/web/                 # web captures
├── src/Root.tsx                # registers Promo + PromoWeb + PromoDashboard
├── src/Promo.tsx               # mobile (existing)
├── src/web/theme.ts            # web-surface token bridge
├── src/web/PromoWeb.tsx
└── src/web/PromoDashboard.tsx
```

Add `playwright` + `tsx` as devDependencies; add scripts `render:web` / `render:dashboard`; root scripts `promo:render:web` / `promo:render:dashboard` (cd form: `cd tools/promo && npm run render:web`). If scaffolding fresh, use `assets/package.template.json`.

### Per-surface theming via input props

To avoid rewriting `src/web/theme.ts` per surface, drive COLOR tokens through Remotion input props — one scene codebase, N surface renders:

```ts
// src/web/theme.ts
import {getInputProps} from 'remotion';
const base = {bg: '#0A0A0B', /* … */ accent: '#DC2626'};
const {colors: overrides} = getInputProps() as {colors?: Partial<typeof base>};
export const colors = {...base, ...overrides};
```

Render with `npx remotion render PromoDashboard out/promo-dashboard.mp4 --props=./dashboard-tokens.json` where the JSON is `{"colors": {"accent": "#1D4ED8", …}}`. LIMIT: fonts cannot come from input props — `loadFont()` executes at module scope; font choices stay code-level per surface.

## §3 Scene system (landscape 1920×1080)

Same animation grammar as `promo-video` (springs damping 14–18, 12-frame transitions, staggered copy, watermark words) with landscape-specific composition:

- **Browser frame** instead of phone bezel (see `assets/browser-promo.template.tsx`): rounded ~16px window, top chrome bar with three traffic-light dots and a URL pill showing the REAL product domain, capture below, big soft shadow. Slight rotateY tilt optional and subtler than mobile (±3°).
- **Split layout**: copy block vertically centered on one side (~38% width), browser frame filling the other (~58%), alternating sides per scene. Watermark word behind, larger canvas → ~420px.
- **Ken Burns on captures**: slow scale 1.0→1.06 across the scene (linear interpolate is fine here — it is a drift, not a gesture), `objectPosition` aimed at the screen's key region. Wide screenshots carry motion this way instead of tilt-float.
- **Intro/outro**: same lockup pattern; outro CTA is the surface URL (e.g. `app.product.com`) instead of a store line.
- Default length 20–25s, 5–6 scenes.

## §4 Register per surface

| Surface | Audience | Copy register | Example headline shape |
|---|---|---|---|
| Web app (`PromoWeb`) | End users | Product marketing, benefit-led — same energy as the mobile promo | "YOUR PROGRESS, ANYWHERE" |
| Dashboard (`PromoDashboard`) | Operators/staff | Calm, outcome-led, zero hype; verbs about control and time saved | "EVERY STUDENT, ONE SCREEN" |

Dashboard scenes favor showing dense real data (tables, filters, detail panels) — density IS the selling point. Do not crop tables down to look "clean"; show the tool doing work.

## §5 Render + verify

Identical to `promo-video` §6, once per composition:
`npx remotion render PromoWeb out/promo-web.mp4` and `npx remotion render PromoDashboard out/promo-dashboard.mp4`, then ffprobe check (1920×1080, 30fps, expected duration) and ≥2 `remotion still` spot-checks per video (one feature scene, the outro).

## §6 Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Captures blurry in frame | Missing `deviceScaleFactor: 2`, or upscaling a 1x capture |
| Dashboard capture shows skeletons/spinners | Waited on `networkidle` only — add explicit selector waits for real data |
| Captures differ between runs | Animations not disabled, toasts present, or non-seeded data — §1 |
| Login flow flaky in capture script | Race on redirect: wait for a post-login selector, not the navigation event |
| Second Remotion project appeared | Wrong — consolidate into `tools/promo/` (one project, many compositions) |
| Playwright browser missing at capture | Run `npx playwright install chromium` once inside `tools/promo/` |
| Login returns `invalid_credentials` despite a correct password hash | Directly-seeded `auth.users` rows are often incomplete for GoTrue: NULL `instance_id`, no matching `auth.identities` row, and NULL string-token columns (GoTrue errors "converting NULL to string is unsupported"). Fix in the local DB before capture: set `instance_id` to the zero UUID, insert an email identity per user, and coalesce token columns to `''`. |
| Capture script hangs in terminal | Headed browser waiting for a GUI — enforce `headless: true` on launch |
| Dashboard capture shows empty states | Tenant not seeded/scoped — seed the demo tenant and pass `PROMO_TENANT` (§1) |
| Colors ignored at render | `--props` file path wrong or `getInputProps()` read after module init in the wrong file — override in `theme.ts` itself (§2) |
