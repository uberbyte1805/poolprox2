import { db } from "../db/index";
import { accounts, settings } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { broadcast } from "../ws/index";
import { addAuthLog } from "./logs";
import { OneMinAIProvider } from "../proxy/providers/oneminai";
import { pool } from "../proxy/pool";
import type { ProviderName } from "../proxy/pool";
import { loginQueue } from "./queue";

// Settings keys (key/value `settings` table, same pattern as auto-warmup).
const ENABLED_KEY = "auto_claim_oneminai_enabled";        // "true" | "false"
const INTERVAL_KEY = "auto_claim_interval_minutes";        // default 24h
const RELOGIN_KEY = "auto_claim_relogin_on_expiry";        // "true" | "false" (default on)
const DEFAULT_INTERVAL_MINUTES = 24 * 60; // once per day
const MIN_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export function isAutoClaimSettingKey(key: string): boolean {
  return key === ENABLED_KEY || key === INTERVAL_KEY || key === RELOGIN_KEY;
}

/**
 * A failed dailyCheckin whose error points at an expired/missing JWT. These
 * accounts (e.g. api_key-only ones) need a browser re-login to mint a fresh
 * 7-day JWT — which also fixes their stale quota display as a side effect.
 */
function isJwtExpiryError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return e.includes("jwt") || e.includes("re-login") || e.includes("expired") || e.includes("teamid");
}

/**
 * Daily free-credit auto-claim scheduler for 1min.ai (oneminai) accounts.
 *
 * 1MinAI's FREE plan grants a daily credit top-up server-side when the account
 * "reads" its unread notifications (same trigger the web app uses). Because the
 * x-auth-token JWT is valid for 7 days, the daily claim is pure HTTP — no
 * browser needed. We just iterate active oneminai accounts that still hold a
 * valid JWT and call provider.dailyCheckin(); the fresh balance is persisted so
 * the dashboard reflects the real number (and any reward delta is logged).
 *
 * Accounts whose JWT has expired (>7 days) fail the read; those need a browser
 * re-login to refresh the JWT (handled separately, ~weekly). Toggle on/off via
 * the `auto_claim_oneminai_enabled` setting.
 */
class AutoClaimScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private intervalMinutes: number = DEFAULT_INTERVAL_MINUTES;
  private enabled = false;
  private reloginOnExpiry = true;
  private nextRunAt: Date | null = null;
  private lastRunAt: Date | null = null;
  private running = false;
  private ticking = false;
  private provider = new OneMinAIProvider();

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.reload();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
    this.running = false;
  }

  async reload(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const rows = await db
      .select()
      .from(settings)
      .where(eq(settings.key, ENABLED_KEY));
    const intervalRows = await db
      .select()
      .from(settings)
      .where(eq(settings.key, INTERVAL_KEY));
    const reloginRows = await db
      .select()
      .from(settings)
      .where(eq(settings.key, RELOGIN_KEY));

    this.enabled = rows[0]?.value === "true";
    // Default ON: only disabled if the setting is explicitly "false".
    this.reloginOnExpiry = reloginRows[0]?.value !== "false";
    const rawInterval = Number(intervalRows[0]?.value);
    this.intervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0
      ? Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.floor(rawInterval)))
      : DEFAULT_INTERVAL_MINUTES;

    this.broadcastStatus();

    if (!this.running || !this.enabled) {
      this.nextRunAt = null;
      return;
    }

    this.scheduleNext();
  }

  private scheduleNext(): void {
    const delay = this.intervalMinutes * 60_000;
    this.nextRunAt = new Date(Date.now() + delay);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
    this.broadcastStatus();
  }

  /** Run the claim cycle now (used by the scheduler tick and the manual API). */
  async runNow(): Promise<{ processed: number; claimed: number; totalReward: number; skipped: number; relogged: number }> {
    this.lastRunAt = new Date();

    const rows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.provider, "oneminai"), eq(accounts.enabled, true)));

    let claimed = 0;
    let totalReward = 0;
    let skipped = 0;
    let relogged = 0;

    for (const account of rows) {
      try {
        const res = await this.provider.dailyCheckin(account);
        if (!res.success) {
          skipped++;
          // Stale/expired JWT (e.g. api_key-only accounts) → trigger a browser
          // re-login to mint a fresh 7-day JWT. This also repairs the stale
          // quota display. enqueue() de-dupes, so repeated ticks are safe.
          const willRelogin = this.reloginOnExpiry && isJwtExpiryError(res.error);
          if (willRelogin) {
            relogged++;
            loginQueue.enqueue(account.id, { headless: true });
          }
          addAuthLog({
            type: "auto_claim_skipped",
            accountId: account.id,
            email: account.email,
            provider: "oneminai",
            message: willRelogin
              ? `Auto-claim skipped ${account.email}: ${res.error || "unknown"} — queued browser re-login`
              : `Auto-claim skipped ${account.email}: ${res.error || "unknown"}`,
            data: { error: res.error, relogin: willRelogin },
          });
          continue;
        }

        claimed++;
        totalReward += res.reward;

        // Persist the live balance so the dashboard stays accurate.
        if (res.balance !== null) {
          await db
            .update(accounts)
            .set({ quotaRemaining: Math.max(0, res.balance), updatedAt: new Date() })
            .where(eq(accounts.id, account.id));
        }

        addAuthLog({
          type: "auto_claim_success",
          accountId: account.id,
          email: account.email,
          provider: "oneminai",
          message:
            res.reward > 0
              ? `Auto-claim ${account.email}: +${res.reward} credits (balance ${res.balance})`
              : `Auto-claim ${account.email}: no reward (already claimed) — balance ${res.balance}`,
          data: { reward: res.reward, balance: res.balance },
        });
      } catch (error) {
        skipped++;
        const message = error instanceof Error ? error.message : String(error);
        addAuthLog({
          type: "auto_claim_error",
          accountId: account.id,
          email: account.email,
          provider: "oneminai",
          error: message,
          message: `Auto-claim failed ${account.email}: ${message}`,
        });
      }
    }

    if (claimed > 0) {
      pool.invalidate("oneminai" as ProviderName);
    }

    addAuthLog({
      type: "auto_claim_tick",
      message: `Auto-claim cycle: ${claimed} claimed (+${totalReward} total), ${skipped} skipped${relogged > 0 ? ` (${relogged} re-login queued)` : ""}, ${rows.length} accounts`,
      data: { processed: rows.length, claimed, totalReward, skipped, relogged },
    });
    this.broadcastStatus();

    return { processed: rows.length, claimed, totalReward, skipped, relogged };
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.ticking) {
      // A manual run is in progress — just reschedule.
      if (this.running && this.enabled) this.scheduleNext();
      return;
    }
    this.ticking = true;
    try {
      await this.runNow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addAuthLog({ type: "auto_claim_error", error: message, message: `Auto-claim tick failed: ${message}` });
    } finally {
      this.ticking = false;
    }

    if (this.running && this.enabled) {
      this.scheduleNext();
    } else {
      this.nextRunAt = null;
      this.broadcastStatus();
    }
  }

  getStatus() {
    return {
      running: this.running,
      enabled: this.enabled,
      intervalMinutes: this.intervalMinutes,
      nextRunAt: this.nextRunAt ? this.nextRunAt.toISOString() : null,
      lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
    };
  }

  private broadcastStatus(): void {
    broadcast({ type: "auto_claim_status", data: this.getStatus() });
  }
}

export const autoClaimScheduler = new AutoClaimScheduler();
