---
name: promo-video
description: Trigger: promo video, promotional video, video promocional, marketing video, app trailer, Remotion, social video. Generate a branded promotional MP4 for an app with Remotion from its real store screenshots and design tokens.
---

# Promo Video

## Activation Contract

Activate when an app needs a promotional/marketing video (social, web, messaging) generated programmatically with Remotion from its real screenshots and brand system. Also the optional Phase 11 executor of `app-builder`.

## Hard Rules

- The video project lives at `tools/promo/` OUTSIDE npm workspaces, with its own `node_modules` — Remotion's `react-dom` must never hoist next to the app's React (Expo/RN conflict). Never add it to root `workspaces`.
- The root script must force the directory context: `"promo:render": "cd tools/promo && npx remotion render Promo out/promo.mp4"` — this guarantees the render resolves `tools/promo`'s own dependencies and never the app bundler's React.
- Brand fidelity is non-negotiable: colors and fonts derive from the app's token file (e.g. `lib/theme.ts`); copy derives from store metadata (`store.config.json`) / product definition — never invent a palette or product claims.
- Screenshots come from the store screenshot set (`store/screenshots/`) — real app runs, not mockups.
- On-screen copy in the store listing's locale; code, identifiers, and comments in English.
- The output is a MARKETING asset. It is NOT an App Store "App Preview" — Apple requires real screen recordings there and `eas metadata` cannot upload video. Always state this distinction when delivering.
- Renders run in the FOREGROUND of the session that owns them — a background render dies when its (sub)agent session ends.
- Timeline math: with `TransitionSeries`, total frames = sum(scene durations) − sum(transition overlaps). Tune scene durations to land exactly on the target length.

## Decision Gates

| Situation | Route |
|---|---|
| Store screenshots + logo exist | Screenshot-showcase format (default, `assets/promo.template.tsx`) |
| Motion clips wanted instead of stills | Record simulator via `xcrun simctl io booted recordVideo` during a Maestro flow; embed with `<OffthreadVideo>` — pipeline §7 |
| Aspect ratio | 1080×1920 vertical (default, social); other ratios only on explicit request |
| Web app or dashboard promo | Use `promo-video-web` (landscape, browser frame, Playwright captures) — extends the same `tools/promo/` project |
| Screenshots are horizontal or 4:3 (tablet set) | Never stretch to 9:16 — constrain inside a fixed mobile mockup frame or use a blurred-background fill (same capture scaled up + blur behind) |
| App Store App Preview requested | Different pipeline (Maestro + simctl + ffmpeg to Apple spec) — out of scope, say so |

## Execution Steps

1. Read `references/pipeline.md`. Inventory inputs: token file, transparent logo PNG, store screenshots (note their pixel aspect), store copy + locale.
2. Scaffold `tools/promo/` from `assets/` templates; `npm install` inside it; copy logo + screenshots into `public/` (referenced via `staticFile()`).
3. Map app tokens into `src/theme.ts`; load fonts via `@remotion/google-fonts`. Build scenes on the template: intro lockup → 3–4 feature scenes (device-framed screenshot, watermark word, staggered copy) → store outro. Skip visually boring screenshots (e.g. login).
4. Audio bed: check for a user-provided `public/audio/bgm.mp3`; if the user explicitly asks you to source one, follow the sourcing protocol in `references/pipeline.md` §4 (license-safe library, brand-vibe search terms, source+license recorded next to the `<Audio>`; never source silently, and state you cannot listen — the pick is by genre/tags). When present, render Remotion's `<Audio src={staticFile('audio/bgm.mp3')}/>` as a SIBLING of the `TransitionSeries` with a volume fade-out over the last second, so the MP4 is social-ready without post-production.
5. Render in the foreground: `npx remotion render Promo out/promo.mp4`. Add the root `promo:render` script (cd form — Hard Rules); gitignore `tools/promo/out/`.
6. Verify duration/fps/size (Remotion's bundled ffprobe), spot-check 2+ frames with `npx remotion still`, deliver the MP4.

## Output Contract

Return: MP4 absolute path with duration/fps/size, files created, root script added, frame spot-check result, and the explicit marketing-vs-App-Preview note.

## References

- `references/pipeline.md` — full runbook: setup, brand mapping, scene direction system, timeline math, render/verify, video-clip variant, troubleshooting.
- `assets/package.template.json` — pinned Remotion deps + `studio`/`render` scripts.
- `assets/theme.template.ts` — token bridge shape (colors, google-fonts, radial backdrop).
- `assets/promo.template.tsx` — full scene architecture: TransitionSeries, device frame, watermark, springs, lockup, glow pulse.
