// Playwright capture script for web-surface promos.
// Run from tools/promo/:  PROMO_EMAIL=... PROMO_PASSWORD=... npx tsx capture/capture.ts
// Requires: npx playwright install chromium (once).
import {chromium} from 'playwright';

const BASE_URL = process.env.PROMO_URL ?? 'http://localhost:5173';
const EMAIL = process.env.PROMO_EMAIL;
const PASSWORD = process.env.PROMO_PASSWORD;
// Multi-tenant products: seed an isolated demo tenant and scope every
// navigation to it — credentials alone do not make the state predictable.
const TENANT = process.env.PROMO_TENANT;

// Loading UI that must be GONE before any capture (adapt to the app).
const LOADING_SELECTORS = ['[data-loading]', '.skeleton', '[role="progressbar"]'];

// One entry per feature scene. `readySelector` must match REAL data,
// not a skeleton — captures with spinners are a quality failure.
const SHOTS: Array<{path: string; readySelector: string; out: string}> = [
  {path: '/', readySelector: 'main', out: '01-home.png'},
  // {path: '/students', readySelector: 'table tbody tr', out: '02-students.png'},
];

async function main() {
  // headless is mandatory: a headed browser hangs the run in terminal envs.
  const browser = await chromium.launch({headless: true});
  const context = await browser.newContext({
    viewport: {width: 1920, height: 1080},
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Stabilize captures: kill CSS animations and transitions.
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = '*{animation:none!important;transition:none!important}';
    document.addEventListener('DOMContentLoaded', () =>
      document.head.appendChild(style)
    );
  });

  // Login (dashboard surfaces). Wait for a post-login element, never the redirect.
  if (EMAIL && PASSWORD) {
    await page.goto(`${BASE_URL}/login`);
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-authenticated], main', {timeout: 15000});
  }

  for (const shot of SHOTS) {
    const prefix = TENANT ? `/t/${TENANT}` : ''; // adapt to the app's tenant routing
    await page.goto(`${BASE_URL}${prefix}${shot.path}`);
    await page.waitForLoadState('networkidle');
    // networkidle is not enough on async dashboards: also require every
    // loading indicator to unmount, then a real-data selector.
    for (const sel of LOADING_SELECTORS) {
      await page.waitForSelector(sel, {state: 'detached', timeout: 15000}).catch(() => {});
    }
    await page.waitForSelector(shot.readySelector, {timeout: 15000});
    await page.screenshot({path: `public/web/${shot.out}`});
    console.log(`captured ${shot.out}`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
