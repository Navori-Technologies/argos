---
name: store-ship
description: Trigger: store deploy, publish app, App Store, Play Store, eas submit, store metadata, store screenshots, subir a tiendas, publicar app. Automate store submission for Expo apps: EAS build/submit, metadata as code, Maestro screenshots.
---

# Store Ship

## Activation Contract

Activate when an Expo/React Native app must be built, prepared, or submitted to the App Store / Play Store: metadata, screenshots, builds, or the whole pipeline. Also the Phase 10 executor of `app-builder`.

## Hard Rules

- All store artifacts live in the repo under `store/` — metadata and screenshots are code, never console-only state.
- Derive ALL copy (title, subtitle, description, keywords) from `docs/product-definition.md`; never invent product claims. Respect limits: iOS subtitle/keywords 30/100 chars, Play title/short/full 30/80/4000 chars.
- Never store credentials in the repo: Apple App Store Connect API key and Play service-account JSON go in env/EAS secrets; `store/` must be committable. Maestro flows must never hardcode credentials either, even local seed ones — inject with `${VAR}` and `maestro test -e KEY=value`, with the run command in the flow header comment. Same rule for the `store.config.json` demo password: inject→push→revert→verify, never committed — `references/pipeline.md` §6.
- Do not claim full automation of one-time console steps (App Privacy questionnaire, content rating, first Play AAB upload) — surface them as a manual checklist instead.
- Screenshots come from real app runs (Maestro on simulator/emulator with seeded demo data), not mockups.

## Decision Gates

| Situation | Route |
|---|---|
| Expo managed app | EAS: `eas build` + `eas submit` + `eas metadata` (iOS) |
| Bare RN / non-Expo | fastlane (`deliver`/`supply`/`snapshot`) — same `store/` layout |
| Play metadata (eas metadata is iOS-only) | fastlane `supply` structure in `store/android/`, uploaded via fastlane or console paste |
| First-ever Play submission | Manual AAB upload in Play Console (Google requirement), then `eas submit` for updates |
| Tablet screenshots | Only if `supportsTablet` (iPad) / tablet layouts exist (Play) |
| EAS submit queue busy / need local, queue-free iOS upload | `xcrun altool --upload-app`, Transporter, or `fastlane pilot upload` with the team's own ASC API key — see "Queue-free local submission" in `references/pipeline.md` §6 |

## Execution Steps

1. Read `references/pipeline.md`; check prereqs incl. EAS env vars (Phase 8).
2. Scaffold `store/` and `eas.json` from `assets/` templates; fill submit profiles.
3. Author metadata from the product definition: `store/store.config.json` (iOS) + `store/android/` supply tree; push once for text fields (no screenshots/password yet).
4. One-time ASC manual fixes for API-created apps: 1.0 version, primary language, copyright, pricing, content rights — pipeline §4.
5. Screenshots: seed demo data, write Maestro flows from `assets/maestro-flow.template.yaml`, run the device matrix, output to `store/screenshots/{platform}/{device}/`.
6. Build + submit: `eas build --profile production`, `eas submit` (queue) or the queue-free local path; verify TestFlight / Play internal track.
7. Final metadata push: real screenshots + demo password inject → push → revert → `rg`-verify — pipeline §6.
8. Print the manual-steps checklist and persist the run outcome (engram or decision log).

## Output Contract

Return: files created under `store/`, commands run with results, screenshot inventory per device, the final metadata push result, and the remaining manual checklist. Never report "submitted" without the `eas submit` output.

## References

- `references/pipeline.md` — full runbook: prereqs, eas.json profiles, metadata fields/limits, device matrix, seeding, troubleshooting.
- `assets/eas.template.json` — build+submit profiles.
- `assets/store.config.template.json` — iOS metadata as code.
- `assets/maestro-flow.template.yaml` — screenshot flow pattern.
- `assets/android-supply.template.md` — Play metadata tree.
