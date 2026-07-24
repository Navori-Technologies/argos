// Landscape (1920x1080) web-surface scene architecture.
// Replace PRODUCT_DOMAIN, copy placeholders, and capture filenames.
// Register: PromoWeb = benefit-led marketing; PromoDashboard = calm, outcome-led.
import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {slide} from '@remotion/transitions/slide';
import {colors, fonts, radialBackground} from './theme';

const PRODUCT_DOMAIN = 'app.product.com';

export const DURATIONS = {
  intro: 100,
  feature1: 140,
  feature2: 140,
  feature3: 140,
  outro: 120,
};
const TRANSITION_FRAMES = 12;
export const TOTAL_DURATION =
  Object.values(DURATIONS).reduce((a, b) => a + b, 0) - 4 * TRANSITION_FRAMES;

const springIn = (frame: number, fps: number, delay = 0) =>
  spring({frame: frame - delay, fps, config: {damping: 16}});

const Backdrop: React.FC<{children: React.ReactNode}> = ({children}) => (
  <AbsoluteFill style={{background: radialBackground}}>{children}</AbsoluteFill>
);

const Watermark: React.FC<{word: string}> = ({word}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const drift = interpolate(frame, [0, durationInFrames], [0, -24]);
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 40,
        left: -140,
        fontFamily: fonts.display,
        fontWeight: 700,
        fontSize: 420,
        textTransform: 'uppercase',
        letterSpacing: 8,
        whiteSpace: 'nowrap',
        color: 'transparent',
        WebkitTextStroke: '1px rgba(250,250,250,0.05)',
        transform: `translateX(${drift}px)`,
      }}
    >
      {word}
    </div>
  );
};

// Browser chrome window: traffic lights + URL pill + capture with Ken Burns.
const BrowserFrame: React.FC<{
  src: string;
  enterFrom: 'left' | 'right';
  focusX?: string; // objectPosition x-target of the Ken Burns drift
}> = ({src, enterFrom, focusX = 'center'}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const enter = springIn(frame, fps, 4);

  const offset = interpolate(enter, [0, 1], [1, 0]);
  const translateX = (enterFrom === 'left' ? -1200 : 1200) * offset;
  const tilt = interpolate(enter, [0, 1], [enterFrom === 'left' ? 3 : -3, 0.8]);
  const kenBurns = interpolate(frame, [0, durationInFrames], [1.0, 1.06]);

  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        [enterFrom === 'left' ? 'left' : 'right']: 60,
        width: '58%',
        perspective: 1600,
        transform: `translateY(-50%) translateX(${translateX}px)`,
      }}
    >
      <div
        style={{
          borderRadius: 16,
          border: `1px solid ${colors.borderStrong}`,
          backgroundColor: colors.surface,
          overflow: 'hidden',
          boxShadow: '0 40px 90px rgba(0,0,0,0.65)',
          transform: `rotateY(${tilt}deg)`,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '14px 20px',
            backgroundColor: colors.panel,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <div style={{display: 'flex', gap: 8}}>
            {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => (
              <div
                key={c}
                style={{width: 12, height: 12, borderRadius: 6, backgroundColor: c}}
              />
            ))}
          </div>
          <div
            style={{
              flex: 1,
              maxWidth: 420,
              margin: '0 auto',
              padding: '6px 18px',
              borderRadius: 8,
              backgroundColor: colors.bg,
              fontFamily: fonts.body,
              fontSize: 16,
              color: colors.textMuted,
              textAlign: 'center',
            }}
          >
            {PRODUCT_DOMAIN}
          </div>
        </div>
        <div style={{aspectRatio: '16 / 9', overflow: 'hidden'}}>
          <Img
            src={staticFile(src)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: `${focusX} top`,
              transform: `scale(${kenBurns})`,
            }}
          />
        </div>
      </div>
    </div>
  );
};

// Copy block on the opposite side, vertically centered.
const CopyBlock: React.FC<{
  eyebrow: string;
  headline: string;
  body: string;
  side: 'left' | 'right';
}> = ({eyebrow, headline, body, side}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const rows = [
    {
      text: eyebrow,
      style: {
        fontFamily: fonts.display,
        fontWeight: 600,
        fontSize: 26,
        letterSpacing: 5,
        textTransform: 'uppercase' as const,
        color: colors.accent,
      },
    },
    {
      text: headline,
      style: {
        fontFamily: fonts.display,
        fontWeight: 700,
        fontSize: 64,
        letterSpacing: 2,
        textTransform: 'uppercase' as const,
        color: colors.textPrimary,
        lineHeight: 1.08,
      },
    },
    {
      text: body,
      style: {
        fontFamily: fonts.body,
        fontWeight: 500,
        fontSize: 28,
        color: colors.textSecondary,
        lineHeight: 1.4,
      },
    },
  ];
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        [side]: 90,
        width: '32%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: 22,
      }}
    >
      {rows.map((row, i) => {
        const s = springIn(frame, fps, 8 + i * 5);
        return (
          <div
            key={row.text}
            style={{
              ...row.style,
              opacity: s,
              transform: `translateY(${interpolate(s, [0, 1], [36, 0])}px)`,
            }}
          >
            {row.text}
          </div>
        );
      })}
    </div>
  );
};

const FeatureScene: React.FC<{
  watermark: string;
  eyebrow: string;
  headline: string;
  body: string;
  capture: string;
  browserSide: 'left' | 'right';
}> = ({watermark, eyebrow, headline, body, capture, browserSide}) => (
  <Backdrop>
    <Watermark word={watermark} />
    <BrowserFrame src={capture} enterFrom={browserSide} />
    <CopyBlock
      eyebrow={eyebrow}
      headline={headline}
      body={body}
      side={browserSide === 'left' ? 'right' : 'left'}
    />
  </Backdrop>
);

const Lockup: React.FC<{speed?: number}> = ({speed = 1}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const logoS = springIn(frame, fps, 2 * speed);
  const titleS = springIn(frame, fps, 14 * speed);
  const barS = springIn(frame, fps, 24 * speed);
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24}}>
      <Img
        src={staticFile('logo.png')}
        style={{
          width: 240,
          height: 240,
          opacity: logoS,
          transform: `scale(${interpolate(logoS, [0, 1], [0.7, 1])})`,
        }}
      />
      <div
        style={{
          fontFamily: fonts.display,
          fontWeight: 700,
          fontSize: 96,
          letterSpacing: 4,
          textTransform: 'uppercase',
          color: colors.textPrimary,
          lineHeight: 1,
          opacity: titleS,
          transform: `translateY(${interpolate(titleS, [0, 1], [60, 0])}px)`,
        }}
      >
        APP NAME
      </div>
      <div
        style={{
          width: 160,
          height: 6,
          backgroundColor: colors.accent,
          transformOrigin: 'left',
          transform: `scaleX(${barS})`,
        }}
      />
    </div>
  );
};

const IntroScene: React.FC = () => (
  <AbsoluteFill
    style={{backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center'}}
  >
    <Lockup />
  </AbsoluteFill>
);

const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const ctaS = springIn(frame, fps, 22);
  return (
    <AbsoluteFill
      style={{backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center'}}
    >
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 30}}>
        <Lockup speed={0.6} />
        <div
          style={{
            fontFamily: fonts.body,
            fontWeight: 600,
            fontSize: 34,
            color: colors.textPrimary,
            opacity: ctaS,
            transform: `translateY(${interpolate(ctaS, [0, 1], [26, 0])}px)`,
          }}
        >
          {PRODUCT_DOMAIN}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const PromoWeb: React.FC = () => {
  const timing = linearTiming({durationInFrames: TRANSITION_FRAMES});
  return (
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={DURATIONS.intro}>
        <IntroScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={timing} />

      <TransitionSeries.Sequence durationInFrames={DURATIONS.feature1}>
        <FeatureScene
          watermark="FEATURE WORD"
          eyebrow="EYEBROW"
          headline="HEADLINE"
          body="One-sentence body copy."
          capture="web/01-home.png"
          browserSide="right"
        />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={slide({direction: 'from-right'})}
        timing={timing}
      />

      <TransitionSeries.Sequence durationInFrames={DURATIONS.feature2}>
        <FeatureScene
          watermark="FEATURE WORD"
          eyebrow="EYEBROW"
          headline="HEADLINE"
          body="One-sentence body copy."
          capture="web/02-feature.png"
          browserSide="left"
        />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={slide({direction: 'from-left'})}
        timing={timing}
      />

      <TransitionSeries.Sequence durationInFrames={DURATIONS.feature3}>
        <FeatureScene
          watermark="FEATURE WORD"
          eyebrow="EYEBROW"
          headline="HEADLINE"
          body="One-sentence body copy."
          capture="web/03-feature.png"
          browserSide="right"
        />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={timing} />

      <TransitionSeries.Sequence durationInFrames={DURATIONS.outro}>
        <OutroScene />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );
};
