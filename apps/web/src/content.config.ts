import { defineCollection, z } from 'astro:content';
import { file } from 'astro/loaders';

/**
 * Features de argos. Contenido repetitivo → content collection,
 * nunca arrays hardcodeados en las páginas.
 */
const features = defineCollection({
  loader: file('src/data/features.json'),
  schema: z.object({
    order: z.number(),
    title: z.string(),
    summary: z.string(),
    command: z.string().optional(),
    accent: z.enum(['http', 'constant', 'brand']),
    featured: z.boolean().default(false),
  }),
});

/**
 * Pasos de "cómo funciona" (getting started en 3 pasos).
 */
const steps = defineCollection({
  loader: file('src/data/steps.json'),
  schema: z.object({
    order: z.number(),
    command: z.string(),
    title: z.string(),
    detail: z.string(),
  }),
});

/**
 * Líneas de la simulación de terminal (`argos workspace graph`).
 * kind controla cómo la isla las renderiza/anima.
 */
const terminal = defineCollection({
  loader: file('src/data/terminal.json'),
  schema: z.object({
    order: z.number(),
    kind: z.enum(['prompt', 'out', 'ok', 'http', 'constant', 'warn']),
    text: z.string(),
  }),
});

export const collections = { features, steps, terminal };
