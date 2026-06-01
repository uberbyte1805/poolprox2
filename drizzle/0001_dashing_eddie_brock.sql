CREATE TABLE "usage_summary" (
	"id" serial PRIMARY KEY NOT NULL,
	"bucket" timestamp NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"total_requests" integer DEFAULT 0,
	"success_requests" integer DEFAULT 0,
	"error_requests" integer DEFAULT 0,
	"prompt_tokens" bigint DEFAULT 0,
	"completion_tokens" bigint DEFAULT 0,
	"total_tokens" bigint DEFAULT 0,
	"credits_used" real DEFAULT 0,
	"total_duration_ms" bigint DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_summary_bucket_provider_model_idx" ON "usage_summary" USING btree ("bucket","provider","model");--> statement-breakpoint
CREATE INDEX "usage_summary_bucket_idx" ON "usage_summary" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "usage_summary_provider_idx" ON "usage_summary" USING btree ("provider","bucket");