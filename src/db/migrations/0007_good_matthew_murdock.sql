CREATE TYPE "public"."cart_item_status" AS ENUM('needed', 'ordered', 'bought');--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty" numeric(10, 3) NOT NULL,
	"unit" text NOT NULL,
	"status" "cart_item_status" DEFAULT 'needed' NOT NULL,
	"note" text,
	"added_by" text,
	"buyer_id" text,
	"ordered_via" text,
	"trip_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopping_trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_trip_id_shopping_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."shopping_trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_trips" ADD CONSTRAINT "shopping_trips_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_productId_active_uidx" ON "cart_items" USING btree ("product_id") WHERE trip_id is null;--> statement-breakpoint
CREATE INDEX "cart_items_householdId_tripId_idx" ON "cart_items" USING btree ("household_id","trip_id");--> statement-breakpoint
CREATE INDEX "cart_items_tripId_idx" ON "cart_items" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "shopping_trips_householdId_closedAt_idx" ON "shopping_trips" USING btree ("household_id","closed_at");