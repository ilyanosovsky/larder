CREATE TYPE "public"."ai_job_status" AS ENUM('pending', 'running', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."ai_job_type" AS ENUM('product_enrich', 'parse_photo', 'parse_url', 'parse_text', 'assistant');--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"type" "ai_job_type" NOT NULL,
	"status" "ai_job_status" NOT NULL,
	"input_ref" text,
	"output_json" jsonb,
	"error" text,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text NOT NULL,
	"default_unit" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_jobs_userId_createdAt_idx" ON "ai_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_jobs_householdId_createdAt_idx" ON "ai_jobs" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_householdId_lowerName_uidx" ON "products" USING btree ("household_id",lower("name"));--> statement-breakpoint
CREATE INDEX "products_householdId_categoryId_idx" ON "products" USING btree ("household_id","category_id");