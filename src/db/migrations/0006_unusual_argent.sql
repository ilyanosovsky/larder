CREATE TABLE "kitchen_profiles" (
	"household_id" uuid PRIMARY KEY NOT NULL,
	"household_size" integer DEFAULT 2 NOT NULL,
	"equipment" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kitchen_profiles" ADD CONSTRAINT "kitchen_profiles_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;