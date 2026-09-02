import { normalizeProductName } from "@/server/catalog/normalize";

/**
 * The canonical form of a dish title — deliberately the **same** canon the
 * product catalog uses (`normalizeProductName`: lower-case, ё→е, collapsed
 * whitespace), aliased rather than copied.
 *
 * Aliased, because two normalizations that drift apart are worse than one
 * that is imperfect: the assistant (task 6.1) resolves «сделай нам лазанью»
 * against `dishes.normalized_title` the same way it resolves a product name,
 * and a household typing «Оладьи» in one place and «оладьи» in another means
 * one dish either way.
 *
 * Copied would be the mistake: `normalizeProductName`'s doc comment records
 * that its steps are already written into stored rows and that changing them
 * needs a backfill. A second implementation would silently stop tracking it.
 *
 * **Unlike `products.normalized_name`, this column carries no unique index**
 * (see `dishes` in `src/db/schema.ts`). It exists for lookup, not for a
 * constraint: a duplicate product is the bug the catalog exists to prevent, a
 * second «Оладьи» is a library decision the household is allowed to make.
 */
export const normalizeDishTitle = normalizeProductName;
