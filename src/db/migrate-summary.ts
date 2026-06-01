/**
 * One-time migration script: Aggregate existing request_logs into usage_summary.
 * Run this BEFORE enabling auto-prune on request_logs.
 *
 * Usage: bun src/db/migrate-summary.ts
 */
import { db, client } from "./index";
import { requestLogs, usageSummary } from "./schema";
import { sql } from "drizzle-orm";

async function migrateSummary() {
  console.log("[migrate-summary] Starting aggregation of request_logs → usage_summary...");

  // Check current state
  const [logCount] = await db.select({ count: sql<number>`count(*)` }).from(requestLogs);
  const [summaryCount] = await db.select({ count: sql<number>`count(*)` }).from(usageSummary);
  console.log(`[migrate-summary] request_logs: ${logCount?.count || 0} rows`);
  console.log(`[migrate-summary] usage_summary: ${summaryCount?.count || 0} rows (before)`);

  // Aggregate all request_logs into usage_summary, grouped by hour + provider + model
  const result = await db.execute(sql`
    INSERT INTO usage_summary (bucket, provider, model, total_requests, success_requests, error_requests, prompt_tokens, completion_tokens, total_tokens, credits_used, total_duration_ms)
    SELECT
      date_trunc('hour', created_at) AS bucket,
      COALESCE(provider, 'unknown') AS provider,
      COALESCE(model, 'unknown') AS model,
      count(*)::integer AS total_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::integer AS success_requests,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::integer AS error_requests,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(credits_used), 0) AS credits_used,
      COALESCE(SUM(duration_ms), 0) AS total_duration_ms
    FROM request_logs
    GROUP BY date_trunc('hour', created_at), COALESCE(provider, 'unknown'), COALESCE(model, 'unknown')
    ON CONFLICT (bucket, provider, model) DO UPDATE SET
      total_requests = usage_summary.total_requests + EXCLUDED.total_requests,
      success_requests = usage_summary.success_requests + EXCLUDED.success_requests,
      error_requests = usage_summary.error_requests + EXCLUDED.error_requests,
      prompt_tokens = usage_summary.prompt_tokens + EXCLUDED.prompt_tokens,
      completion_tokens = usage_summary.completion_tokens + EXCLUDED.completion_tokens,
      total_tokens = usage_summary.total_tokens + EXCLUDED.total_tokens,
      credits_used = usage_summary.credits_used + EXCLUDED.credits_used,
      total_duration_ms = usage_summary.total_duration_ms + EXCLUDED.total_duration_ms
  `);

  // Verify
  const [afterCount] = await db.select({ count: sql<number>`count(*)` }).from(usageSummary);
  const [summaryTotals] = await db.select({
    totalRequests: sql<number>`SUM(total_requests)`,
    totalTokens: sql<number>`SUM(total_tokens)`,
    totalCredits: sql<number>`SUM(credits_used)`,
  }).from(usageSummary);

  console.log(`[migrate-summary] usage_summary: ${afterCount?.count || 0} rows (after)`);
  console.log(`[migrate-summary] Summary totals: ${summaryTotals?.totalRequests || 0} requests, ${summaryTotals?.totalTokens || 0} tokens, ${Number(summaryTotals?.totalCredits || 0).toFixed(2)} credits`);

  // Cross-check with request_logs
  const [logTotals] = await db.select({
    totalRequests: sql<number>`count(*)`,
    totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
    totalCredits: sql<number>`COALESCE(SUM(credits_used), 0)`,
  }).from(requestLogs);

  console.log(`[migrate-summary] Request logs totals: ${logTotals?.totalRequests || 0} requests, ${logTotals?.totalTokens || 0} tokens, ${Number(logTotals?.totalCredits || 0).toFixed(2)} credits`);
  console.log("[migrate-summary] Done! Data is safe in usage_summary.");

  await client.end();
}

migrateSummary().catch((err) => {
  console.error("[migrate-summary] Error:", err);
  process.exit(1);
});
