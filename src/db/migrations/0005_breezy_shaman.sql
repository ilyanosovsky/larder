-- Uniqueness moves from `lower(name)` onto a stored canonical column, so the
-- database enforces the application's own definition of "the same product"
-- (`normalizeProductName`: lower-case, ё→е, collapsed whitespace) instead of a
-- weaker approximation that admitted «Сёмга» and «Семга» as two rows.
--
-- Hand-ordered rather than left as drizzle-kit emitted it: the generator wrote
-- a bare `ADD COLUMN ... NOT NULL`, which fails outright on a table that has
-- any rows. Split into add → backfill → constrain, so this is runnable against
-- a populated table and not only against the empty ones it happens to meet
-- today.
ALTER TABLE "products" ADD COLUMN "normalized_name" text;--> statement-breakpoint
-- The SQL twin of `normalizeProductName` (src/server/catalog/normalize.ts):
-- lower-case (which also folds Ё to ё), ё→е, trim, collapse inner whitespace.
UPDATE "products"
SET "normalized_name" = regexp_replace(
  regexp_replace(translate(lower("name"), 'ё', 'е'), '^\s+|\s+$', '', 'g'),
  '\s+', ' ', 'g'
)
WHERE "normalized_name" IS NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "normalized_name" SET NOT NULL;--> statement-breakpoint
-- Created before the old index is dropped, so there is never a moment without
-- a uniqueness guarantee on the catalog.
CREATE UNIQUE INDEX "products_householdId_normalizedName_uidx" ON "products" USING btree ("household_id","normalized_name");--> statement-breakpoint
DROP INDEX "products_householdId_lowerName_uidx";
