CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_householdId_name_uidx" ON "categories" USING btree ("household_id","name");--> statement-breakpoint
CREATE INDEX "categories_householdId_sortOrder_idx" ON "categories" USING btree ("household_id","sort_order");--> statement-breakpoint
-- Backfill: households created before this migration have no rows in the
-- new table, so give each of them the same 7 defaults `household.create`
-- now seeds for a brand-new household (VISION §3.1, DESIGN_BRIEF §5 route
-- order). A household that somehow already has categories is left alone.
INSERT INTO "categories" ("household_id", "name", "icon", "sort_order")
SELECT h."id", d.name, d.icon, d.sort_order
FROM "households" h
CROSS JOIN (VALUES
	('Овощи и фрукты', '🥬', 0),
	('Молочное и яйца', '🥛', 1),
	('Мясо и курица', '🥩', 2),
	('Хлеб и выпечка', '🥖', 3),
	('Бакалея', '🍝', 4),
	('Заморозка', '🧊', 5),
	('Хозяйственное', '🧴', 6)
) AS d(name, icon, sort_order)
WHERE NOT EXISTS (
	SELECT 1 FROM "categories" c WHERE c."household_id" = h."id"
);