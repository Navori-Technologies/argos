# Store Ship — Pipeline Runbook

Full reference for executing a store submission. The SKILL.md contract governs; this file holds the operational detail. Real order: prereqs → scaffold → metadata as code → one-time ASC manual fixes → screenshots (Maestro) → build + submit → final metadata push → manual checklist.

## 1. Prerequisites (verify before anything)

| Item | How to verify | Blocking? |
|---|---|---|
| Apple Developer Program membership + App Store Connect app record | ascAppId exists | Yes (iOS) |
| Play Console developer account + app record | package name registered | Yes (Android) |
| EAS project linked | `eas init` done, `extra.eas.projectId` in app config | Yes |
| Privacy policy + support URLs live | Phase 8 output, HTTP 200 | Yes — App Store Connect rejects without them |
| App Store Connect API key (p8) | stored as EAS secret / local path outside repo | Yes for `eas submit -p ios` |
| Play service-account JSON with release permission | stored outside repo | Yes for `eas submit -p android` (after first manual upload) |
| Demo account for App Review | seeded credentials that WORK in production backend | Yes — auth-gated apps are rejected without one |
| Maestro CLI + Java | `maestro --version` succeeds | Yes (screenshots) |
| EAS env vars set for every `EXPO_PUBLIC_*` the app consumes | push once with `eas env:push <environment> --path .env.local` (from the app dir); verify with `eas env:list <environment>` cross-checked against `rg -o 'EXPO_PUBLIC_[A-Z_]+' apps/<app>` output | Yes — gitignored `.env` files are NOT uploaded to EAS builds |

Maestro install: `brew install maestro` installs a different, unrelated product — do NOT use it. Install with `curl -Ls "https://get.maestro.mobile.dev" | bash`; it requires Java (`brew install openjdk`). Verify with `maestro --version`.

## 2. eas.json

Start from `assets/eas.template.json`. Key decisions:

- `appVersionSource: "remote"` + `autoIncrement: true` on production — EAS owns build numbers; never hand-bump.
- Submit profiles reference credentials by path/env, never inline.
- Android `track: "internal"` first; promote in console or with a later `eas submit --track production`.
- Pin `"environment": "production" | "preview" | "development"` on each build profile so the matching EAS env set loads at build time. EAS cloud builds do NOT upload gitignored `.env` files — without EAS env vars, every `EXPO_PUBLIC_*` var is undefined and inlined as missing into the bundle (unfixable post-build; requires a rebuild). See §1 for the push/verify commands.
- First-ever iOS submission: `eas submit` format-validates `submit.<profile>.ios` fields (`ascAppId`, `appleTeamId`, `ascApiKeyId`, `ascApiKeyIssuerId`) before any interactive prompt — `TODO_*` placeholders hard-fail the command before you ever see a login screen. Leave `ios` as an empty object `{}` for the first submission instead: `eas submit` then prompts an Apple ID login and auto-creates the ASC app record. Fill in the real ids afterward for unattended/CI use. JSON has no comments, so this convention lives here, not in the file: an empty `"ios": {}` under `submit.<profile>` means "first submission, not yet wired for CI."

## 3. Metadata as code

### iOS — `eas metadata` (`store/store.config.json`)

Template: `assets/store.config.template.json`. Field limits (hard, validated by `eas metadata:validate`):

| Field | Limit |
|---|---|
| title | 30 chars |
| subtitle | 30 chars |
| keywords | 100 chars total, comma-separated |
| description | 4000 chars |
| promoText | 170 chars (editable without new build) |

The schema field is `promoText`, NOT `promotionalText` — the wrong name fails `eas metadata:push` validation. Allowed `info.<locale>` properties: `title`, `subtitle`, `description`, `keywords`, `releaseNotes`, `promoText`, `marketingUrl`, `supportUrl`, `privacyPolicyText`, `privacyPolicyUrl`, `privacyChoicesUrl`, `screenshots`, `previews`. Notably absent: `copyright`, pricing, content rights — those are never push-able (§4).

Derivation from `docs/product-definition.md`: title = product name; subtitle = the one-line value promise; description = core promise + feature list (§ features) rewritten as user benefits; keywords = domain nouns the target user searches, no competitor names, no duplicates of title words (wasted chars). Locale: use the app's UI language as primary (`es-MX` for Spanish-market apps); add `en-US` only if the app actually ships English.

es-MX copy rule: display fields the user reads (`description`, `promoText`, `subtitle`, Android `short_description`/`full_description`) MUST carry proper Spanish accents. `keywords` are the one field to write deliberately accentless — App Store search normalizes diacritics and users type without accents.

Push: `eas metadata:push` (validates first). Pull existing console state before first push: `eas metadata:pull`.

`metadataPath` wiring: when `store.config.json` lives at repo-root `store/` (this skill's layout), the submit profile in `eas.json` MUST set `"metadataPath": "../../store/store.config.json"` — `eas metadata` otherwise looks for the config next to `eas.json` and reports it missing.

Fresh ASC app: `eas metadata:push` against a just-created App Store Connect app fails with API errors ("must provide versionString", "appInfo relationship missing") until Apple initializes the 1.0 version — which happens once the FIRST binary finishes processing. This is not a config error; retry after TestFlight shows the build processed. If it still fails once the build has processed, see the one-time manual fixes in §4.

Screenshot schema: `apple.info.<locale>.screenshots` maps Apple's `screenshotDisplayType` enum keys — `APP_IPHONE_67`, `APP_IPHONE_65`, `APP_IPHONE_61`, `APP_IPAD_PRO_3GEN_129`, `APP_IPAD_PRO_3GEN_11` are the common ones — to arrays of image paths. EAS local validation does NOT catch a wrong key; only ASC rejects it at push time, and that API error helpfully lists the full enum. Paths resolve relative to the PROJECT DIRECTORY (the app dir where `eas.json` lives), NOT relative to `store.config.json` — with the repo-root `store/` layout:

```json
"screenshots": {
  "APP_IPHONE_67": ["../../store/screenshots/ios/iphone-6.9/01-signature.png"]
}
```

This is the config shape only — the files don't exist yet until §5 captures them, and the real push (with real paths and the real demo password) is the final push in §6.

### Android — supply tree (`store/android/`)

`eas metadata` does NOT support Play. Keep the fastlane `supply` layout (see `assets/android-supply.template.md`) so it works with fastlane or manual paste:

```
store/android/metadata/{locale}/
  title.txt            # 30 chars
  short_description.txt # 80 chars
  full_description.txt  # 4000 chars
  images/phoneScreenshots/ …
```

Upload: `fastlane supply --metadata_path store/android/metadata` if fastlane is available; otherwise paste once — the repo copy remains the source of truth.

## 4. One-time ASC manual fixes (API-created apps)

Apps auto-created by `eas submit` (the empty `"ios": {}` first-submission convention, §2) often need manual fixes in App Store Connect before metadata syncs cleanly. Two are conditional on the API-creation path; three are ALWAYS manual for every app, API-created or not, because the `eas metadata` schema (§3) has no field for them.

| Fix | Trigger | Symptom if skipped |
|---|---|---|
| "1.0 Prepare for Submission" version exists (create if not) | Conditional — check once the first build has processed | "versionString missing", `appInfoLocalizations` relationship errors |
| App Information → Primary Language = app's locale (e.g. Spanish (Mexico)) | Conditional — same trigger | "Skipping screenshots - locale not found" |
| Copyright | ALWAYS manual — `apple.copyright` in `store.config.json` triggers a broken version-info PATCH on API-created apps that persists even after the 1.0 version exists | "must provide versionString" keeps failing after the 1.0 version exists |
| Pricing and availability | ALWAYS manual — not in the `eas metadata` schema | n/a |
| Content Rights declaration | ALWAYS manual — not in the `eas metadata` schema | n/a |

Fix once in App Store Connect, then re-push metadata (§3). Omit `copyright` from `store.config.json` — the template omits it deliberately (JSON has no comments, so this note lives here).

## 5. Screenshots (Maestro)

### Device matrix

| Store slot | Device | Size | Required |
|---|---|---|---|
| iPhone 6.9" | iPhone 16 Pro Max sim | 1320×2868 | Yes (covers smaller sizes since 2024) |
| iPad 13" | iPad Pro 13" sim | 2064×2752 | Only if `supportsTablet: true` |
| Play phone | Pixel emulator | ≥1080 wide, 16:9–9:16 | Yes (2–8 shots) |
| Play 7"/10" tablet | tablet emulator | ≥1080 wide | Only if tablet UI exists |

Device matrix drift: newer Xcode may ship simulator runtimes for only the latest iPhones (e.g. 17-series), so the required 6.9" device (iPhone 16 Pro Max, 1320×2868) may not exist yet — create it: `xcrun simctl create "iPhone 16 Pro Max" <devicetype-id>`. Never substitute a device with a different resolution and never resize images to fit; a wrong-resolution screenshot must be retaken on the correct device.

### Local-backend screenshot env (recommended, self-contained)

Running screenshots against a local Supabase backend avoids polluting shared/staging data and needs no network:

1. `supabase start` — under colima, the `vector` log-shipping container can fail to start; if it does, use `supabase start --exclude vector` instead of debugging it.
2. After `supabase db push` to the local instance, PostgREST may return `42501 permission denied` on app tables even though the schema is correct — local `db push` does not carry over table GRANTs for the `authenticated` role. Apply `GRANT SELECT` (and any other roles the app needs) on the app tables manually. Re-apply after every `supabase db reset`, since reset wipes GRANTs too.
3. Pass backend overrides (Supabase URL, anon key) INLINE as env vars to the build command, not via a temp `.env` file — nothing to clean up afterward and no risk of clobbering `.env.local`.

### Procedure

1. Seed demo data first — screenshots of empty states don't sell. Use the project's seed script with a dedicated demo user; pick data that shows the app at its best (populated lists, active membership, real-looking names).
2. Build a dev/simulator build (`eas build --profile development` or `npx expo run:ios --configuration Release` locally, with backend env vars passed inline). Expo Go screenshots are not acceptable (dev menu chrome, wrong icon). Note: `npx expo run:ios` on a managed app generates `ios/` (verify it's gitignored), rewrites the `package.json` `ios`/`android` scripts to `expo run:*`, and may add `expo-updates` — this is expected native-project scaffolding, not damage; don't "fix" it back on a later run.
3. Write one Maestro flow per screenshot set from `assets/maestro-flow.template.yaml`: `launchApp` → `waitForAnimationToEnd` → login as demo user → navigate → `takeScreenshot` per key screen. Always wait for animations to end before the FIRST screenshot too — the first frame after launch (and after any navigation) can still show launch-transition chrome, and a shot taken mid-transition needs retaking. 4–6 screens: the signature screen first (it is the store card image), then core loop, then differentiators.
4. Watch for Keychain/SecureStore state surviving `clearState`: anything the app persists via SecureStore (e.g. a one-shot celebration/onboarding acknowledgement) is NOT reset by Maestro's `clearState` and will not re-trigger on a normal re-run — it needs a fresh simulator or `xcrun simctl erase <device>` to fire again. Write flows so they pass either way (don't assert on a one-shot state that may already be dismissed). One-shot moments make great store screenshots — plan a device reset into the run when you need one.
5. Run per device: boot the simulator/emulator at the matrix size, `maestro test store/flows/screenshots.yaml -e DEMO_PASSWORD=...` (env values via `-e`, never hardcoded — see SKILL.md hard rules), move output to `store/screenshots/{platform}/{device}/NN-name.png`. Keep the screenshot output directory under `store/` next to `store.config.json` — the config's `screenshots` paths resolve relative to the PROJECT DIRECTORY, not this directory (§3).
6. Verify: correct resolution, no status-bar clutter (simulator status bar is fine; `xcrun simctl status_bar override` to clean it), no personal data.

Framing (device bezels + captions) is optional; if requested use fastlane `frameit` or skip — plain screenshots are store-compliant.

## 6. Build + submit

```
eas build --platform all --profile production   # wait for both artifacts
eas submit -p ios --latest                      # → TestFlight
eas submit -p android --latest                  # → internal track (fails before first manual AAB upload — expected)
```

Verify: TestFlight shows the build processing; Play internal track lists the release. Report actual command output, not intent.

`eas submit` ALWAYS runs the submission job on EAS servers — even with `--path <local-ipa>` it uploads your ipa and an EAS worker delivers it to Apple, so the build/submit queue applies either way.

### Queue-free local submission (iOS)

Fully local paths that skip the EAS queue, all present on a standard Mac setup:

- `xcrun altool --upload-app -f <ipa> -t ios` (still shipping in Xcode 26) — auth with an app-specific password (`-u`/`-p`) or an ASC API key (`--apiKey`/`--apiIssuer`, `.p8` at `~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8`).
- Transporter.app GUI, or its CLI: `/Applications/Transporter.app/Contents/itms/bin/iTMSTransporter`.
- `fastlane pilot upload`.

Recommended durable path: create the team's OWN ASC API key (App Manager role, `.p8` in gitignored `secrets/`) — one key powers altool, pilot, and non-interactive automation. Note: the EAS-generated ASC key lives on EAS servers and cannot be downloaded, so it cannot back these local paths.

### `eas build --local`

- Requires fastlane (fails with `spawn fastlane ENOENT`) and CocoaPods installed locally.
- Credentials, EAS env vars, and remote `autoIncrement` all still sync from EAS servers — a local build is not an offline build.
- The artifact lands as `build-<timestamp>.ipa` in the app dir.
- SECURITY: the local build job payload echoed to the terminal embeds the provisioning profile AND the distribution certificate with its password (base64). Build logs are sensitive — never paste them publicly; rotate via `eas credentials` if exposed.

### Wrap the working chain in npm scripts

Once the chain works end to end, freeze it as root `package.json` scripts so future runs are one command: `deploy:<web-surface>` (build + deploy + alias + HTTP-200 verification), `deploy:ios` (preflight fastlane/pods → local build → pick newest `build-*.ipa` → submit), `env:push:mobile`, and `metadata:push`. Deliberately add NO `deploy:android` until a Play presence exists — it would be a dead script.

### Final metadata push (after build + submit)

Screenshots (§5) and the demo password only belong in the config once they're real, and the password should spend the least possible time on disk — so this push is last, not part of the initial metadata authoring in §3:

1. Add the real screenshot paths to `apple.info.<locale>.screenshots` (key/path format in §3).
2. Inject the real demo account password into `apple.review.demoPassword`.
3. `eas metadata:push`.
4. Immediately revert the password field to its placeholder.
5. Verify with `rg` that no real credential remains in `store/` before committing — this is what keeps the "no credentials in repo" hard rule true.

## 7. Manual checklist (cannot be automated — always deliver)

- App Store Connect: App Privacy questionnaire (data collection declarations — derive answers from what the app actually collects and hands to Supabase/analytics).
- App Store Connect: age rating questionnaire.
- App Review notes: demo account credentials + any reviewer instructions (e.g. "accounts are admin-created; use the demo login").
- Play Console: content rating questionnaire, data safety form, first AAB upload by hand.
- Both: confirm pricing/availability, territories, and (iOS) the Content Rights declaration — always manual, see §4.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `eas metadata:push` auth error | ASC API key missing/expired — recreate in App Store Connect → Users and Access → Keys |
| Submit rejected: missing privacy URL | Phase 8 not deployed — hard prerequisite |
| Play submit 403 | service account lacks release permission, or first AAB never uploaded manually |
| Screenshot wrong size | simulator device ≠ matrix device; do not resize with sips — retake |
| Metadata rejected for claims | copy promised features the build doesn't have — re-derive from product definition, not marketing wishes |
| `eas submit` fails instantly, no login prompt | `TODO_*` placeholder ids in `submit.<profile>.ios` — use `"ios": {}` for the first submission (§2) |
| `maestro --version` not found / wrong tool | installed via `brew install maestro` (wrong product) — reinstall per §1 |
| PostgREST `42501 permission denied` on local Supabase | table GRANTs missing after local `db push`/`db reset` (§5 local-backend env) |
| `supabase start` hangs/fails under colima | `vector` container failing (§5 local-backend env) |
| Screenshot shows launch chrome / blank frame | missing `waitForAnimationToEnd` after `launchApp` or a nav tap (§5 procedure) |
| One-shot UI (celebration/onboarding) never appears for its screenshot | SecureStore/Keychain survives Maestro `clearState` (§5 procedure step 4) |
| Build/TestFlight can't reach backend, dev works locally | `EXPO_PUBLIC_*` vars missing at EAS build time — push env vars (§1) and REBUILD |
| `eas metadata:push` fails: "must provide versionString" / "appInfo relationship missing" | before first build processes: ASC hasn't initialized the 1.0 version yet, retry later; persists after: either the §4 manual fixes are still needed, or `apple.copyright` is set in the config |
| "Skipping screenshots - locale not found" / `appInfoLocalizations` errors | wrong primary language or no 1.0 version — see §4 |
| Screenshot key rejected at push time only | wrong `screenshotDisplayType` enum key (e.g. `iphone67`) — must be `APP_IPHONE_67` etc.; EAS local validation doesn't catch it (§3) |
| `eas metadata:push` validation rejects a field name | field not in the schema (e.g. `promotionalText` — real name is `promoText`, §3) |
| `eas build --local` fails: `spawn fastlane ENOENT` | fastlane (and CocoaPods) missing locally — install both (§6) |
