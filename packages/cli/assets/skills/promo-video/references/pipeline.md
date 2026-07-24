# Promo Video Pipeline — Runbook

Verified end-to-end on a real run (Expo SDK 57 monorepo, Remotion 4.0.496, macOS).

## §1 Prerequisites

- Node 18+; network access (google-fonts packages fetch font files at render time).
- Inputs inventory before scaffolding:
  - App token file (colors, font roles) — e.g. `apps/mobile/lib/theme.ts`.
  - Transparent logo PNG at high resolution (e.g. `docs/logo/mark-transparent-3072.png`).
  - Store screenshots (e.g. `store/screenshots/ios/iphone-6.9/*.png`) — record their pixel size; the device-frame aspect ratio derives from it (e.g. 1320/2868).
  - Store copy + locale (`store/store.config.json` title/subtitle/promoText) — on-screen copy must match the listing's language and claims.

## §2 Project setup

- Scaffold `tools/promo/` from `assets/package.template.json`. CRITICAL: this path must be OUTSIDE the monorepo's npm `workspaces` globs (`apps/*`, `packages/*`) so it keeps its own `node_modules` — Remotion needs react-dom and a hoisted install will fight the app's React (Expo/RN).
- Pin all Remotion packages (`remotion`, `@remotion/cli`, `@remotion/google-fonts`, `@remotion/transitions`) to the SAME exact 4.x version; react/react-dom 19.
- `npm install` inside `tools/promo` (non-interactive).
- Minimal source layout: `src/index.ts` (registerRoot), `src/Root.tsx` (one `<Composition id="Promo">`, 1080×1920@30), `src/theme.ts`, `src/Promo.tsx`. Boilerplate for index/Root:

```tsx
// src/index.ts
import {registerRoot} from 'remotion';
import {Root} from './Root';
registerRoot(Root);

// src/Root.tsx
import {Composition} from 'remotion';
import {Promo, TOTAL_DURATION} from './Promo';
export const Root = () => (
  <Composition id="Promo" component={Promo} durationInFrames={TOTAL_DURATION}
    fps={30} width={1080} height={1920} />
);
```

- Copy logo + selected screenshots into `tools/promo/public/`; reference ONLY via `staticFile()`. Skip visually weak screenshots (login screens rarely earn a scene).
- Add root script `"promo:render": "cd tools/promo && npx remotion render Promo out/promo.mp4"` — the explicit `cd` forces the directory context so the render always resolves `tools/promo`'s own `node_modules` (`npm --prefix` also works, but the `cd` form is unambiguous); gitignore `tools/promo/out/`.

## §3 Brand mapping

- Map the app tokens 1:1 into `src/theme.ts` (see `assets/theme.template.ts`): background, surface, border, accent, three text tiers. Never invent values.
- Fonts via `@remotion/google-fonts/<Family>` `loadFont()` — load only the weights used. Respect the app's typography roles (e.g. condensed display face always uppercase with letter-spacing; body face for sentences).
- Shared backdrop: radial gradient, surface color at center fading to background at ~70% — reads premium, avoids flat black.

## §4 Scene direction system

The default 25s structure (six scenes): intro lockup → 3–4 feature scenes → outro. All animation via `spring()` (damping 14–18); nothing linear except slow drifts. Scene-to-scene via `@remotion/transitions` `TransitionSeries` (fade or slide, ~12 frames).

- **Intro**: logo springs in (scale 0.7→1 + opacity), wordmark rises from below, accent bar wipes (scaleX, origin left), eyebrow line above in secondary text.
- **Feature scene template** (see `assets/promo.template.tsx`):
  - Giant watermark word behind everything: display font ~340px uppercase, `color: transparent` + `WebkitTextStroke 1px rgba(250,250,250,0.05)`, partially off-canvas, drifting a few px across the scene.
  - Device frame built in CSS: rounded ~64px, ~10px bezel border, overflow hidden, `boxShadow 0 40px 80px rgba(0,0,0,0.6)`, perspective 1200px with rotateY tilt that springs from ±6° to ~25% residual (never fully flat — keeps depth), slow ±8px sine float.
  - Phone enters springing from bottom/left/right — alternate direction and tilt sign per scene for variety.
  - Copy block: eyebrow (accent color, letter-spaced uppercase) → headline (display 700 ~72px) → body (body font, secondary color), staggered ~5 frames apart.
  - Accent moment: one scene gets a one-shot radial glow pulse behind the device (accent color at 0.25 alpha, opacity up-then-down).
- **Outro**: lockup again at higher speed, then CTA line ("Disponible en el App Store" / locale equivalent), then one subtitle. Hold ≥1.5s fully settled at the end.

### Audio bed

Use a user-provided `public/audio/bgm.mp3`, or source one ONLY on explicit user request — never silently.

Sourcing protocol (verified):
- Use a library whose license allows commercial use without attribution: Mixkit Stock Music Free License (works well — tag pages at `mixkit.co/free-stock-music/tag/<tag>/` embed JSON-LD with name/genre/duration/direct mp3 URL, scrapeable with curl + a browser UA). Pixabay's license also qualifies but the site 403-blocks non-browser fetching — don't burn time there.
- Derive search tags from the brand vibe, not generic terms: athletic/martial dark brand → `trailer`, `sports`, `percussion`, `epic`; playful consumer app → `upbeat`, `funk`, `pop`. Prefer instrumental "Percussion Trailer" / "Trailer Music" genres for dark athletic brands — no melodic identity to clash with the copy.
- You cannot listen: say so, pick by genre/tags/duration, and note the user judges with one listen (swapping the file re-renders in minutes).
- Record source URL + license in a comment directly above the `<Audio>` element.
- Track longer than the video is fine — playback cuts at composition end; the fade-out handles the exit.

Render it as a SIBLING of the `TransitionSeries` (`<Audio>` is not a wrapper):

```tsx
<>
  <Audio
    src={staticFile('audio/bgm.mp3')}
    volume={(f) =>
      interpolate(f, [TOTAL_DURATION - 30, TOTAL_DURATION], [1, 0], {
        extrapolateLeft: 'clamp',
      })
    }
  />
  <TransitionSeries>…</TransitionSeries>
</>
```

The 30-frame fade-out prevents a hard audio cut; the export is then social-ready with no post-production.

### Non-vertical source screenshots

Tablet (4:3) or horizontal screenshots must NEVER be stretched into the 9:16 canvas. Two accepted routes: (a) constrain the capture inside a fixed mobile mockup frame at its true aspect; (b) blurred-background fill — the same image scaled to cover the canvas with `filter: blur(40px)` + a dark overlay behind the true-aspect foreground copy.

## §5 Timeline math

`TransitionSeries` transitions OVERLAP scenes: total = Σ(scene durations) − Σ(transition frames). Example that lands exactly on 750 frames / 25s @30fps with five 12-frame transitions: 110 + 145 + 145 + 145 + 130 + 135 − 60 = 750. Export `TOTAL_DURATION` computed from the durations object — never hardcode the total.

## §6 Render + verify

- Render from `tools/promo`: `npx remotion render Promo out/promo.mp4` — ALWAYS foreground. A render started with a backgrounded process inside a sub-agent dies when that agent's session ends; whoever owns the render waits for it.
- Verify: Remotion bundles ffprobe (`node_modules/.bin` or via `npx remotion versions`) — check h264, expected WxH, fps, duration. System ffprobe is often absent; don't assume it.
- Spot-check at least two frames visually: `npx remotion still Promo out/frame.png --frame=<n>` (pick a mid-feature frame and the outro) and view them.
- Deliver the MP4 with duration/size and the marketing-vs-App-Preview note.

## §7 Video-clip variant (instead of stills)

- Record the simulator during a Maestro tour flow: `xcrun simctl io booted recordVideo clip.mov` (Ctrl-C to stop), one clip per feature.
- Trim/normalize with ffmpeg if needed; place clips in `public/`; swap `<Img>` for `<OffthreadVideo src={staticFile('clip.mp4')} muted>` inside the same device frame. `OffthreadVideo` is the render-safe choice (frame-accurate, no HTMLVideoElement flakiness).
- Keep clips short (3–4s per scene) and trim dead frames at the start.

## §8 Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Peer/type conflicts on install | Project got hoisted into workspaces — move outside globs; own lockfile |
| Fonts render as system sans | `loadFont()` not called at module scope, or offline — google-fonts needs network at render |
| Render "completes" but no file | Render was backgrounded and its owner session ended — re-run foreground |
| Total duration off by N frames | Forgot transition overlap subtraction — §5 |
| Screenshot distorted in frame | Frame aspect must derive from the real screenshot pixel ratio, `objectFit: cover` |
| Tablet/horizontal screenshots in a 9:16 comp | Never stretch — mockup-frame constrain or blurred-background fill (§4) |
| No audio in exported MP4 | `<Audio>` missing or rendered inside a Sequence that ends early — mount it at composition top level (§4) |
| Studio port busy | `npx remotion studio --port <other>` |
