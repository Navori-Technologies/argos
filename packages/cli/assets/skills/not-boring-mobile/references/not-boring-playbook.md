# Not Boring Mobile — Playbook

The direction layer for delight-first Expo/RN apps. Read before building UI. Pairs with app-builder (which owns architecture, data, phases).

## The philosophy (Not Boring, Andy Allen)

- **Toy, not tool.** The interface should be fun to poke even with no task. Reward curiosity.
- **Modern skeuomorphism.** Real depth, material, light — not flat, not literal 2010 skeuo. Surfaces feel touchable.
- **Motion is the protagonist**, not decoration. Everything reacts to touch; nothing snaps instantly. State changes are physical, not timed.
- **Personality.** A voice, playful copy, optional character/mascot, surprise & delight, easter eggs. The app has an attitude.
- **Committed color world.** One saturated palette/gradient system owns the app. No timid neutrals.
- **Sound design.** Short, tactile sounds paired with haptics make interactions feel physical. Always user-mutable.
- **Restraint inside maximalism.** One signature "hero toy"; everything else is coherent and disciplined so the hero lands.

## Apple-editorial mode (Today stories)

Full-bleed cinematic imagery, oversized display type, narrative scroll with parallax, generous negative space, one accent. Use for onboarding, marketing, story surfaces. Same craft, calmer motion.

## Libraries (Expo-compatible)

- `react-native-reanimated` (v3/4) — springs, worklets, shared values. Worklets babel plugin is required (v4: `react-native-worklets/plugin`, LAST).
- `react-native-gesture-handler` — pan/tap/pinch driving animations directly.
- `expo-haptics` — impact + notification feedback.
- `expo-audio` (or `expo-av`) — short interaction sounds; preload, keep <300ms.
- `expo-linear-gradient`, `expo-blur` — gradients + glass.
- `@shopify/react-native-skia` — advanced visuals: shaders, mesh gradients, custom shapes, glow. Reach for it when gradients/shadows aren't enough.
- `moti` (optional) — declarative wrapper over Reanimated for quick spring transitions.

## Spring presets (Reanimated `withSpring`)

```ts
export const springs = {
  gentle: { damping: 18, stiffness: 140, mass: 1 },   // calm settle
  bouncy: { damping: 10, stiffness: 180, mass: 0.9 },  // playful overshoot
  stiff:  { damping: 26, stiffness: 320, mass: 1 },    // snappy, immediate
};
```

Drive press/toggle/drag with these, not `withTiming`. Overshoot is the personality.

## Haptics + sound wiring

- `lib/haptics.ts`: map interaction weight → impact (light for taps, medium for commits, heavy/notification for milestones). Wrap in `.catch(()=>{})`.
- `lib/sound.ts`: owned wrapper; preload sounds once, expose `play(name)`, honor a user mute setting. Never block the interaction on audio.
- Rule: press = light haptic; success/complete = notification success + a reward sound; drag threshold crossed = tick.

## Depth recipe

Layer, don't flatten: base gradient → surface with layered shadows (a soft wide + a tight dark) → inner light highlight (top edge lighter) → optional blur/glass for overlays. Skia for glow/mesh gradients.

## Performance (non-negotiable)

- Native driver only; keep animation math in worklets.
- No layout animations on list hot paths; use transform/opacity.
- Memoize heavy components; virtualize long lists.
- Skia work off the JS thread; avoid per-frame `setState`.
- Test on a real device — a simulator hides haptics, sound, and true frame timing.

## Anti-patterns

- Animating everything → fatigue. Choose the moments.
- System `Alert`/stock inputs in a delight moment → breaks the toy illusion; build bespoke.
- Shipping without a device haptic/sound pass → the feel is unverified.
- Tinted-neutral palette → that's the restrained register; this one commits to color.
- Reusing shadcn/reusables primitives verbatim → they read generic; here every touched surface is bespoke.
