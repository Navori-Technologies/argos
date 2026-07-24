---
name: not-boring-mobile
description: Trigger: Not Boring app, playful/delightful app, juguete, maximalist UI, tactile/skeuomorphic mobile, make it delightful. Visual+interaction direction for delight-first React Native/Expo apps — springs, haptics, sound, bespoke components.
---

## Activation Contract

Activate when the user wants a React Native/Expo app that feels like a TOY, not a tool — the "Not Boring" (Andy Allen) / Apple-editorial register: maximalist, tactile, animation-led, personality-heavy. This is the VISUAL + INTERACTION layer ONLY; architecture, data, and phase gates come from `app-builder`. Do NOT activate for dense tools, clinical/enterprise, or data-heavy products — those want a restrained register.

## Hard Rules

- Bespoke everything the user touches: NO stock/system components, NO generic shadcn/reusables look. Owned components with custom shape, depth, and motion.
- Every meaningful interaction gets BOTH a spring (Reanimated `withSpring`, native driver) AND a haptic; primary "toy" interactions also get sound.
- Spend boldness on ONE signature interaction the app is remembered by; keep everything else coherent, not noisy.
- Commit to ONE saturated color world (gradients, light, depth) — never tinted neutrals.
- Respect OS Reduce Motion with a tasteful non-animated fallback; hold 60fps (no layout-animating hot paths, no JS per-frame work).
- Complement `app-builder`; never redo its architecture, data layer, or phase gates.

## Decision Gates

| Product | Register |
|---|---|
| Habit/lifestyle/creative/kids/consumer where delight IS the value | this skill (maximalist) |
| Tool, clinical, enterprise, dense data, pro workflow | restrained (`app-builder` default) — do NOT use this |
| Marketing/story surface (editorial, immersive, cinematic) | this skill's editorial mode |

## Execution Steps

1. Confirm the register fits (consumer/delight). If it's a tool, stop and use the restrained register.
2. Read `references/not-boring-playbook.md` (libraries, spring presets, sound/haptic/depth recipes) BEFORE building UI.
3. Pick the ONE signature "toy" interaction that embodies the app; prototype it first, on device.
4. Build bespoke, gesture-reactive components; drive state changes with `withSpring`, not timing curves.
5. Layer depth (gradients, layered shadows, glass, light) + one committed color world + big expressive type.
6. Wire haptics + sound via owned `lib/haptics.ts` / `lib/sound.ts` wrappers on every interaction.
7. Verify on a REAL device (springs/haptics/sound don't read in a simulator); gate on "is it fun to poke?".

## Output Contract

Return: the signature interaction built, the bespoke components created, the color/type/depth system, the haptic+sound wiring, and device-verified evidence it feels like a toy — not just a themed form.

## References

- `references/not-boring-playbook.md` — libraries, spring presets, sound/haptic/depth recipes, and the Not Boring + Apple-editorial principles.
