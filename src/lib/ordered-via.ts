import { z } from "zod";

/**
 * Where an ordered cart line was ordered (VISION §3.1: Wolt Market / Carrefour
 * delivery, or something else).
 *
 * Lives here rather than on the `cart` router — same reasoning as
 * `src/lib/units.ts`'s `unitSchema`: the row action sheet (task 2.5) and the
 * offline queue's pending-row extraction both need this vocabulary on the
 * client, and importing it from `@/server/api/routers/cart` would drag that
 * router's drizzle/db imports into a client bundle for the sake of one enum.
 */
export const ORDERED_VIA_OPTIONS = ["wolt", "carrefour", "other"] as const;

export type OrderedVia = (typeof ORDERED_VIA_OPTIONS)[number];

export const orderedViaSchema = z.enum(ORDERED_VIA_OPTIONS);
