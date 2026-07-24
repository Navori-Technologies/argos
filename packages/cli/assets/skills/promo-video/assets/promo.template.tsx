// Scene architecture template — verified on a real render.
// Replace SCREENSHOT_ASPECT, scene copy, screenshot filenames, and lockup text
// with the target app's values. Copy language = the store listing's locale.
import React from 'react';
import {
  AbsoluteFill,
  Audio,
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

// Real pixel ratio of the source screenshots (width / height).
const SCREENSHOT_ASPECT = 1320 / 2868;

// Scene durations (frames @ 30fps). Transitions overlap TRANSITION_FRAMES each:
// total = sum(durations) - (transitions * TRANSITION_FRAMES). Tune to hit target.
export const DURATIONS = {
  intro: 110,
  feature1: 145,
  feature2: 145,
  feature3: 145,
  feature4: 130,
  outro: 135,
};
const TRANSITION_FRAMES = 12;
export const TOTAL_DURATION =
  Object.values(DURATIONS).reduce((a, b) => a + b, 0) - 5 * TRANSITION_FRAMES;

const springIn = (frame: number, fps: number, delay = 0) =>
  spring({frame: frame - delay, fps, config: {damping: 16}});

const Backdrop: React.FC<{children: React.ReactNode}> = ({children}) => (
  <AbsoluteFill style={{background: radialBackground}}>{children}</AbsoluteFill>
);

// Giant outlined word drifting behind feature scenes for depth.
const Watermark: React.FC<{word: string}> = ({word}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const drift = interpolate(frame, [0, durationInFrames], [0, -18]);
  return (
    <div
      style={{
        position: 'absolute',
        top: 260,
        left: -120,
        fontFamily: fonts.display,
        fontWeight: 700,
        fontSize: 340,
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

// Staggered copy block: eyebrow, headline, body — 5 frames apart.
const HeadlineBlock: React.FC<{
  eyebrow: string;
  headline: string;
  body: string;
  delay?: number;
}> = ({eyebrow, headline, body, delay = 8}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const rows = [
    {
      text: eyebrow,
      style: {
        fontFamily: fonts.display,
        fontWeight: 600,
        fontSize: 30,
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
        fontSize: 72,
        letterSpacing: 2,
        textTransform: 'uppercase' as const,
        color: colors.textPrimary,
        lineHeight: 1.05,
      },
    },
    {
      text: body,
      style: {
        fontFamily: fonts.body,
        fontWeight: 500,
        fontSize: 34,
        color: colors.textSecondary,
      },
    },
  ];
  return (
    <div
      style={{
        position: 'absolute',
        top: 130,
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 20,
        textAlign: 'center',
        padding: '0 80px',
      }}
    >
      {rows.map((row, i) => {
        const s = springIn(frame, fps, delay + i * 5);
        return (
          <div
            key={row.text}
            style={{
              ...row.style,
              opacity: s,
              transform: `translateY(${interpolate(s, [0, 1], [40, 0])}px)`,
            }}
          >
            {row.text}
          </div>
        );
      })}
    </div>
  );
};

// CSS device frame with entrance spring, perspective tilt settling to a
// small residual (never fully flat — keeps depth), and a slow sine float.
const Phone: React.FC<{
  src: string;
  enterFrom: 'bottom' | 'left' | 'right';
  tiltY: number;
}> = ({src, enterFrom, tiltY}) => {
  const frame = useCurrentFrame();
  const {fps, height} = useVideoConfig();
  const enter = springIn(frame, fps, 4);

  const phoneHeight = height * 0.62;
  const phoneWidth = phoneHeight * SCREENSHOT_ASPECT;

  const offset = interpolate(enter, [0, 1], [1, 0]);
  const translateX =
    enterFrom === 'left' ? -900 * offset : enterFrom === 'right' ? 900 * offset : 0;
  const translateY = enterFrom === 'bottom' ? 1100 * offset : 0;

  const rotateY = interpolate(enter, [0, 1], [tiltY, tiltY * 0.25]);
  const rotateX = interpolate(enter, [0, 1], [2, 0.5]);

  const float = Math.sin((frame / fps) * Math.PI) * 8;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 110,
        left: '50%',
        perspective: 1200,
        transform: `translateX(-50%) translate(${translateX}px, ${translateY + float}px)`,
      }}
    >
      <div
        style={{
          width: phoneWidth,
          height: phoneHeight,
          borderRadius: 64,
          border: `10px solid ${colors.border}`,
          backgroundColor: colors.surface,
          overflow: 'hidden',
          boxShadow: '0 40px 80px rgba(0,0,0,0.6)',
          transform: `rotateY(${rotateY}deg) rotateX(${rotateX}deg)`,
        }}
      >
        <Img
          src={staticFile(src)}
          style={{width: '100%', height: '100%', objectFit: 'cover'}}
        />
      </div>
    </div>
  );
};

// One-shot accent glow pulse behind the device — use on ONE scene only.
const GlowPulse: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [18, 40, 85], [0, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 60,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 1000,
        height: 1100,
        borderRadius: '50%',
        background:
          'radial-gradient(ellipse at center, rgba(220,38,38,0.25) 0%, rgba(220,38,38,0) 65%)',
        opacity,
      }}
    />
  );
};

const FeatureScene: React.FC<{
  watermark: string;
  eyebrow: string;
  headline: string;
  body: string;
  screenshot: string;
  enterFrom: 'bottom' | 'left' | 'right';
  tiltY: number;
  glow?: boolean;
}> = ({watermark, eyebrow, headline, body, screenshot, enterFrom, tiltY, glow}) => (
  <Backdrop>
    <Watermark word={watermark} />
    {glow ? <GlowPulse /> : null}
    <Phone src={screenshot} enterFrom={enterFrom} tiltY={tiltY} />
    <HeadlineBlock eyebrow={eyebrow} headline={headline} body={body} />
  </Backdrop>
);

// Logo + wordmark lockup shared by intro and outro. `speed` shortens delays.
const Lockup: React.FC<{speed?: number}> = ({speed = 1}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const logoS = springIn(frame, fps, 2 * speed);
  const eyebrowS = springIn(frame, fps, 22 * speed);
  const titleS = springIn(frame, fps, 16 * speed);
  const barS = springIn(frame, fps, 28 * speed);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 28,
      }}
    >
      <Img
        src={staticFile('logo.png')}
        style={{
          width: 360,
          height: 360,
          opacity: logoS,
          transform: `scale(${interpolate(logoS, [0, 1], [0.7, 1])})`,
        }}
      />
      <div
        style={{
          fontFamily: fonts.display,
          fontWeight: 600,
          fontSize: 28,
          letterSpacing: 6,
          textTransform: 'uppercase',
          color: colors.textSecondary,
          opacity: eyebrowS,
          transform: `translateY(${interpolate(eyebrowS, [0, 1], [24, 0])}px)`,
        }}
      >
        APP TAGLINE
      </div>
      <div
        style={{
          fontFamily: fonts.display,
          fontWeight: 700,
          fontSize: 110,
          letterSpacing: 4,
          textTransform: 'uppercase',
          color: colors.textPrimary,
          lineHeight: 1,
          opacity: titleS,
          transform: `translateY(${interpolate(titleS, [0, 1], [70, 0])}px)`,
        }}
      >
        APP NAME
      </div>
      <div
        style={{
          width: 180,
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
    style={{
      backgroundColor: colors.bg,
      justifyContent: 'center',
      alignItems: 'center',
    }}
  >
    <Lockup />
  </AbsoluteFill>
);

const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const ctaS = springIn(frame, fps, 26);
  const subS = springIn(frame, fps, 34);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 36,
        }}
      >
        <Lockup speed={0.6} />
        <div
          style={{
            fontFamily: fonts.body,
            fontWeight: 600,
            fontSize: 36,
            color: colors.textPrimary,
            opacity: ctaS,
            transform: `translateY(${interpolate(ctaS, [0, 1], [30, 0])}px)`,
          }}
        >
          STORE CTA LINE
        </div>
        <div
          style={{
            fontFamily: fonts.body,
            fontWeight: 400,
            fontSize: 30,
            color: colors.textSecondary,
            opacity: subS,
            transform: `translateY(${interpolate(subS, [0, 1], [24, 0])}px)`,
          }}
        >
          OUTRO SUBTITLE
        </div>
      </div>
    </AbsoluteFill>
  );
};

// User-provided music bed (public/audio/bgm.mp3). Keep null when absent —
// never source or download music for the user (licensing is theirs).
const BGM: string | null = null;

export const Promo: React.FC = () => {
  const timing = linearTiming({durationInFrames: TRANSITION_FRAMES});
  return (
    <>
      {BGM ? (
        <Audio
          src={staticFile(BGM)}
          volume={(f) =>
            interpolate(f, [TOTAL_DURATION - 30, TOTAL_DURATION], [1, 0], {
              extrapolateLeft: 'clamp',
            })
          }
        />
      ) : null}
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
          screenshot="01-feature.png"
          enterFrom="bottom"
          tiltY={-6}
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
          screenshot="02-feature.png"
          enterFrom="right"
          tiltY={6}
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
          screenshot="03-feature.png"
          enterFrom="left"
          tiltY={-6}
        />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={timing} />

      <TransitionSeries.Sequence durationInFrames={DURATIONS.feature4}>
        <FeatureScene
          watermark="FEATURE WORD"
          eyebrow="EYEBROW"
          headline="HEADLINE"
          body="One-sentence body copy."
          screenshot="04-feature.png"
          enterFrom="bottom"
          tiltY={-6}
          glow
        />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={timing} />

      <TransitionSeries.Sequence durationInFrames={DURATIONS.outro}>
        <OutroScene />
      </TransitionSeries.Sequence>
    </TransitionSeries>
    </>
  );
};
