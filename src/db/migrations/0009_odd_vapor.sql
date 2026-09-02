CREATE TYPE "public"."dish_source_type" AS ENUM('photo', 'url', 'text', 'manual');--> statement-breakpoint
CREATE TABLE "dishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"photo_url" text,
	"photo_key" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_type" "dish_source_type" NOT NULL,
	"source_url" text,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"product_id" uuid,
	"raw_text" text NOT NULL,
	"name" text NOT NULL,
	"qty" numeric(10, 3),
	"unit" text,
	"note" text,
	"is_optional" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"step_order" integer NOT NULL,
	"text" text NOT NULL,
	"timer_sec" integer,
	"timer_max_sec" integer
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"dish_id" uuid NOT NULL,
	"portions_base" integer DEFAULT 2 NOT NULL,
	"portions_min" integer,
	"yield_unit" text,
	"total_time_min" integer,
	"equipment" text[] DEFAULT '{}'::text[] NOT NULL,
	"original_draft" jsonb,
	"adapted_at" timestamp with time zone,
	"adapted_note" text
);
--> statement-breakpoint
ALTER TABLE "dishes" ADD CONSTRAINT "dishes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dishes" ADD CONSTRAINT "dishes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_steps" ADD CONSTRAINT "recipe_steps_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_steps" ADD CONSTRAINT "recipe_steps_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_dish_id_dishes_id_fk" FOREIGN KEY ("dish_id") REFERENCES "public"."dishes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dishes_householdId_createdAt_idx" ON "dishes" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "dishes_householdId_normalizedTitle_idx" ON "dishes" USING btree ("household_id","normalized_title");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_recipeId_sortOrder_idx" ON "recipe_ingredients" USING btree ("recipe_id","sort_order");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_householdId_idx" ON "recipe_ingredients" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_productId_idx" ON "recipe_ingredients" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "recipe_steps_recipeId_stepOrder_idx" ON "recipe_steps" USING btree ("recipe_id","step_order");--> statement-breakpoint
CREATE INDEX "recipe_steps_householdId_idx" ON "recipe_steps" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_dishId_uidx" ON "recipes" USING btree ("dish_id");--> statement-breakpoint
CREATE INDEX "recipes_householdId_idx" ON "recipes" USING btree ("household_id");