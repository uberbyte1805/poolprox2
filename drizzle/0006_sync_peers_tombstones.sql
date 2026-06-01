CREATE TABLE IF NOT EXISTS "peers" (
	"id" serial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"api_key" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_status" text,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "peers_url_idx" ON "peers" USING btree ("url");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_tombstones" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"email" text NOT NULL,
	"deleted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_tombstones_provider_email_idx" ON "account_tombstones" USING btree ("provider","email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_tombstones_deleted_at_idx" ON "account_tombstones" USING btree ("deleted_at");
