import { z } from "zod";

/**
 * Purchase units for a product (VISION §3.1: "шт / кг / г / л / упаковка").
 *
 * This is the phase-wide canon: cart items, reference-catalog defaults and
 * recipe ingredients all store one of these as text and share this list —
 * VISION's own examples plus the design content's пучок/банка/плитка/г are
 * the decided superset (task 1.2). Extend it here, never redeclare it
 * per-feature.
 */
export const UNITS = [
  "шт",
  "кг",
  "г",
  "л",
  "мл",
  "уп",
  "пучок",
  "банка",
  "плитка",
] as const;

export type Unit = (typeof UNITS)[number];

export const unitSchema = z.enum(UNITS);
