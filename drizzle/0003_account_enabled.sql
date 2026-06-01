ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_provider_status_enabled_idx" ON "accounts" USING btree ("provider","status","enabled");
