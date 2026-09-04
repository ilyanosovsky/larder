CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"week_menu_id" uuid NOT NULL,
	"dish_id" uuid NOT NULL,
	"portions" integer NOT NULL,
	"day_of_week" integer,
	"cooked_at" timestamp with time zone,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "week_menus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"last_build_request_id" uuid,
	"last_built_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_week_menu_id_week_menus_id_fk" FOREIGN KEY ("week_menu_id") REFERENCES "public"."week_menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_dish_id_dishes_id_fk" FOREIGN KEY ("dish_id") REFERENCES "public"."dishes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_menus" ADD CONSTRAINT "week_menus_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "menu_items_weekMenuId_dishId_uidx" ON "menu_items" USING btree ("week_menu_id","dish_id");--> statement-breakpoint
CREATE INDEX "menu_items_householdId_idx" ON "menu_items" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "menu_items_dishId_idx" ON "menu_items" USING btree ("dish_id");--> statement-breakpoint
CREATE UNIQUE INDEX "week_menus_householdId_weekStart_uidx" ON "week_menus" USING btree ("household_id","week_start");