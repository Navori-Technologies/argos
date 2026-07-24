// Token bridge: map the app's design tokens 1:1 — never invent values.
// Replace font families and hex values with the app's own (e.g. lib/theme.ts).
import {loadFont as loadDisplay} from '@remotion/google-fonts/Oswald';
import {loadFont as loadBody} from '@remotion/google-fonts/Inter';

const display = loadDisplay('normal', {weights: ['600', '700']});
const body = loadBody('normal', {weights: ['400', '500', '600']});

export const fonts = {
  display: display.fontFamily,
  body: body.fontFamily,
};

export const colors = {
  bg: '#0A0A0B',
  surface: '#17171A',
  panel: '#212126',
  border: '#26262B',
  borderStrong: '#3F3F46',
  accent: '#DC2626',
  textPrimary: '#FAFAFA',
  textSecondary: '#A1A1AA',
  textMuted: '#71717A',
};

// Shared radial backdrop: surface center fading to near-black edges.
export const radialBackground = `radial-gradient(ellipse at center, ${colors.surface} 0%, ${colors.bg} 70%)`;
