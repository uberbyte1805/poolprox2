import { db } from "../db/index";
import { accounts, settings } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import type { Account } from "../db/schema";
import { broadcast } from "../ws/index";
import { config } from "../config";

export type ProviderName = "kiro" | "kiro-pro" | "codebuddy" | "canva" | "zai" | "windsurf" | "moclaw" | "codex" | "pioneer" | "qoder" | "oneminai";

/**
 * Detect a *temporary* account suspension (vs a permanent ban / dead token).
 * Kiro locks an account ("Your User ID (...) temporarily is suspended. We've
 * locked your account as a security precaution") when the same refresh token is
 * used by concurrent sessions (e.g. 9Router + poolprox2). The lock lifts on its
 * own after a short while, so these accounts must NOT be marked error-permanent —
 * they go to "cooldown" and auto-revive.
 */
export function isSuspendedError(message?: string | null): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("temporarily is suspended") ||
    m.includes("temporarily suspended") ||
    m.includes("security precaution") ||
    (m.includes("locked your account") && m.includes("restore access"))
  );
}

interface PoolState {
  lastIndex: Map<ProviderName, number>;
}

interface ActiveAccountsCacheEntry {
  accounts: Account[];
  expiresAt: number;
  inFlight?: Promise<Account[]>;
}

class AccountPool {
  private state: PoolState = {
    lastIndex: new Map(),
  };

  private activeAccountsCache = new Map<ProviderName, ActiveAccountsCacheEntry>();
  private inFlightByAccountId = new Map<number, number>();
  private lbMethodCache: { global: string; perProvider: Map<ProviderName, string>; expiresAt: number } | null = null;

  /**
   * Clear cached active accounts after account mutations or status changes.
   */
  invalidate(provider?: ProviderName): void {
    if (provider) {
      this.activeAccountsCache.delete(provider);
      return;
    }

    this.activeAccountsCache.clear();
  }

  private async getLoadBalancingMethod(provider: ProviderName): Promise<string> {
    const now = Date.now();
    if (!this.lbMethodCache || this.lbMethodCache.expiresAt <= now) {
      try {
        const rows = await db.select().from(settings);
        const perProvider = new Map<ProviderName, string>();
        let global = "round_robin";
        for (const row of rows) {
          if (!row.value) continue;
          if (row.key === "load_balancing_method") {
            global = row.value;
            continue;
          }
          const match = row.key.match(/^provider_(.+)_lb_method$/);
          if (match && match[1]) perProvider.set(match[1] as ProviderName, row.value);
        }
        this.lbMethodCache = { global, perProvider, expiresAt: now + 10000 };
      } catch {
        this.lbMethodCache = { global: "round_robin", perProvider: new Map(), expiresAt: now + 10000 };
      }
    }
    return this.lbMethodCache.perProvider.get(provider) || this.lbMethodCache.global;
  }

  invalidateLoadBalancingCache(): void {
    this.lbMethodCache = null;
  }

  /**
   * Get the next available account for a provider using configured method.
   */
  async getNextAccount(provider: ProviderName): Promise<Account | null> {
    const activeAccounts = await this.getActiveAccounts(provider);

    if (activeAccounts.length === 0) {
      return null;
    }

    const method = await this.getLoadBalancingMethod(provider);

    if (method === "sequential") {
      // Sequential: use first account with lowest in-flight, prefer order
      for (const account of activeAccounts) {
        if (this.getInFlightCount(account.id) === 0) return account;
      }
      return activeAccounts[0] || null;
    }

    // Round Robin (default)
    const startIdx = ((this.state.lastIndex.get(provider) || 0) + 1) % activeAccounts.length;
    let selected = activeAccounts[startIdx];
    let selectedIdx = startIdx;
    let selectedLoad = selected ? this.getInFlightCount(selected.id) : Number.POSITIVE_INFINITY;

    for (let i = 1; i < activeAccounts.length; i++) {
      const idx = (startIdx + i) % activeAccounts.length;
      const candidate = activeAccounts[idx];
      if (!candidate) continue;
      const load = this.getInFlightCount(candidate.id);
      if (load < selectedLoad) {
        selected = candidate;
        selectedIdx = idx;
        selectedLoad = load;
        if (load === 0) break;
      }
    }

    this.state.lastIndex.set(provider, selectedIdx);
    return selected || null;
  }

  private getInFlightCount(accountId: number): number {
    return this.inFlightByAccountId.get(accountId) || 0;
  }

  trackRequestStart(accountId: number): void {
    this.inFlightByAccountId.set(accountId, this.getInFlightCount(accountId) + 1);
  }

  trackRequestEnd(accountId: number): void {
    const next = this.getInFlightCount(accountId) - 1;
    if (next > 0) this.inFlightByAccountId.set(accountId, next);
    else this.inFlightByAccountId.delete(accountId);
  }

  async decrementQuota(accountId: number, creditsUsed: number): Promise<number> {
    if (!Number.isFinite(creditsUsed) || creditsUsed <= 0) {
      const [account] = await db
        .select({ quotaRemaining: accounts.quotaRemaining })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      return Number(account?.quotaRemaining || 0);
    }

    const [account] = await db
      .update(accounts)
      .set({
        quotaRemaining: sql`GREATEST(0, COALESCE(${accounts.quotaRemaining}, 0) - ${creditsUsed})`,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning({ quotaRemaining: accounts.quotaRemaining });

    return Number(account?.quotaRemaining || 0);
  }

  /**
   * Count currently-active accounts for a provider (cache-aware).
   * Used by the router to size its failover budget so a few
   * suspended/rate-limited accounts don't sink a request when
   * healthy accounts still exist in the pool.
   */
  async getActiveCount(provider: ProviderName): Promise<number> {
    const accs = await this.getActiveAccounts(provider);
    return accs.length;
  }

  private async getActiveAccounts(provider: ProviderName): Promise<Account[]> {
    const ttlMs = Math.max(0, config.accountCacheTtlMs);
    if (ttlMs === 0) return this.fetchActiveAccounts(provider);

    const now = Date.now();
    const cached = this.activeAccountsCache.get(provider);
    if (cached && cached.expiresAt > now) return cached.accounts;
    if (cached?.inFlight) return cached.inFlight;

    const fetchTime = now;
    const inFlight = this.fetchActiveAccounts(provider)
      .then((activeAccounts) => {
        this.activeAccountsCache.set(provider, {
          accounts: activeAccounts,
          expiresAt: fetchTime + ttlMs,
        });
        return activeAccounts;
      })
      .catch((error) => {
        this.activeAccountsCache.delete(provider);
        throw error;
      });

    this.activeAccountsCache.set(provider, {
      accounts: cached?.accounts || [],
      expiresAt: 0,
      inFlight,
    });

    return inFlight;
  }

  private async fetchActiveAccounts(provider: ProviderName): Promise<Account[]> {
    // Auto-revive: any account whose cooldown window has elapsed goes back to
    // "active" (Kiro's temporary suspension lifts on its own). This is what makes
    // a few concurrent-session locks self-heal instead of permanently draining
    // the pool. Cheap UPDATE scoped to this provider's cooldown rows.
    await db
      .update(accounts)
      .set({ status: "active", errorMessage: null, updatedAt: new Date() })
      .where(
        and(
          eq(accounts.provider, provider),
          eq(accounts.status, "cooldown"),
          eq(accounts.enabled, true),
          sql`${accounts.quotaResetAt} IS NOT NULL AND ${accounts.quotaResetAt} <= NOW()`,
        )
      );

    return db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, provider),
          eq(accounts.status, "active"),
          eq(accounts.enabled, true),
        )
      );
  }

  /**
   * Get any available account across all providers that support the model.
   */
  async getAccountForModel(model: string): Promise<{ account: Account; provider: ProviderName } | null> {
    // Determine which provider handles this model
    const provider = this.getProviderForModel(model);
    if (!provider) return null;

    const account = await this.getNextAccount(provider);
    if (!account) return null;

    return { account, provider };
  }

  /**
   * Map model name to provider.
   *
   * Kiro (Standard): auto, claude-haiku-4.5, claude-sonnet-4, claude-sonnet-4.5,
   *                  claude-sonnet-4.5-thinking, deepseek-3.2, glm-5,
   *                  glm-5-thinking, minimax-m2.1, minimax-m2.5, qwen3-coder-next
   *
   * CodeBuddy (MAX): claude-opus-4.6, deepseek-v3-2-volc, enowx-default,
   *                  gemini-*, gpt-5.*, kimi-k2.5
   *
   * Canva: canva-image
   */
  getProviderForModel(model: string): ProviderName | null {
    const m = model.toLowerCase().replace("-thinking", "");

    // === WINDSURF ===
    if (m.startsWith("ws-")) return "windsurf";

    // === 1MINAI ===
    if (m.startsWith("1m-")) return "oneminai";

    // === Z.AI ===
    if (m.startsWith("zai-")) return "zai";

    // === CANVA ===
    if (m.includes("canva")) return "canva";

    // === MOCLAW ===
    if (m.includes("moclaw") || m === "mo-auto") return "moclaw";

    // === PIONEER ===
    if (m.startsWith("pio-")) return "pioneer";

    // === QODER ===
    if (m.startsWith("qd-")) return "qoder";

    // === CODEX (OpenAI) ===
    if (m.startsWith("codex-") || m === "gpt-5-codex") return "codex";

    // === KIRO PRO ===
    if (m.startsWith("kp-")) return "kiro-pro";

    // === CODEBUDDY (MAX tier) ===
    if (m.startsWith("cb-")) return "codebuddy";
    if (m.startsWith("gpt-5")) return "codebuddy";
    if (m.startsWith("gemini-")) return "codebuddy";
    if (m === "deepseek-v3-2-volc") return "codebuddy";
    if (m === "enowx-default") return "codebuddy";
    if (m.startsWith("kimi-")) return "codebuddy";

    // === KIRO (Standard tier) ===
    if (m === "auto") return "kiro";
    if (m === "claude-haiku-4.5") return "kiro";
    if (m === "claude-sonnet-4") return "kiro";
    if (m === "claude-sonnet-4.5") return "kiro";
    if (m === "deepseek-3.2") return "kiro";
    if (m === "glm-5") return "kiro";
    if (m.startsWith("minimax-")) return "kiro";
    if (m.startsWith("qwen")) return "kiro";

    // Fallback: any claude model → kiro (standard)
    if (m.includes("claude") || m.includes("sonnet") || m.includes("haiku")) return "kiro";

    // Default to kiro
    return "kiro";
  }

  /**
   * Mark an account as used (update last_used_at)
   */
  async markUsed(accountId: number): Promise<void> {
    await db
      .update(accounts)
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
  }

  /**
   * Mark an account as exhausted
   */
  async markExhausted(accountId: number): Promise<void> {
    const [account] = await db
      .update(accounts)
      .set({
        status: "exhausted",
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) {
      this.invalidate(account.provider as ProviderName);
      broadcast({
        type: "account_status",
        data: { id: accountId, status: "exhausted", provider: account.provider },
      });
    }
  }

  /**
   * Mark an account as errored
   */
  async markError(accountId: number, errorMessage: string): Promise<void> {
    const [account] = await db
      .update(accounts)
      .set({
        status: "error",
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: "error", error: errorMessage },
    });
  }

  /**
   * Mark an account as temporarily on cooldown (e.g. Kiro security suspension).
   * Sets quota_reset_at = now + cooldownMs; fetchActiveAccounts auto-revives it
   * to "active" once that timestamp passes. Excluded from selection meanwhile.
   */
  async markCooldown(accountId: number, errorMessage: string, cooldownMs = config.accountCooldownMs): Promise<void> {
    const resetAt = new Date(Date.now() + Math.max(60_000, cooldownMs));
    const [account] = await db
      .update(accounts)
      .set({
        status: "cooldown",
        errorMessage,
        quotaResetAt: resetAt,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: "cooldown", error: errorMessage, resetAt: resetAt.toISOString() },
    });
  }

  async markTransientFailure(accountId: number, errorMessage: string): Promise<void> {
    const [account] = await db
      .update(accounts)
      .set({
        status: "active",
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: "active", warning: errorMessage },
    });
  }

  /**
   * Update account tokens (stored as jsonb)
   */
  async updateTokens(accountId: number, tokens: unknown): Promise<void> {
    await db
      .update(accounts)
      .set({
        tokens,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
  }

  /**
   * Toggle account enabled flag (user-controlled active/inactive).
   */
  async setEnabled(accountId: number, enabled: boolean): Promise<Account | null> {
    const [account] = await db
      .update(accounts)
      .set({
        enabled,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (!account) return null;

    this.invalidate(account.provider as ProviderName);
    broadcast({
      type: "account_status",
      data: { id: accountId, enabled, provider: account.provider, status: account.status },
    });
    return account;
  }

  /**
   * Get pool statistics
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    exhausted: number;
    error: number;
    pending: number;
    disabled: number;
    byProvider: Record<string, { active: number; total: number; disabled: number }>;
  }> {
    const [totals, providerRows] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)`,
          active: sql<number>`SUM(CASE WHEN status = 'active' AND enabled = true THEN 1 ELSE 0 END)`,
          exhausted: sql<number>`SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END)`,
          error: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
          pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
          disabled: sql<number>`SUM(CASE WHEN enabled = false THEN 1 ELSE 0 END)`,
        })
        .from(accounts),
      db
        .select({
          provider: accounts.provider,
          total: sql<number>`count(*)`,
          active: sql<number>`SUM(CASE WHEN status = 'active' AND enabled = true THEN 1 ELSE 0 END)`,
          disabled: sql<number>`SUM(CASE WHEN enabled = false THEN 1 ELSE 0 END)`,
        })
        .from(accounts)
        .groupBy(accounts.provider),
    ]);

    const totalRow = totals[0];
    const byProvider: Record<string, { active: number; total: number; disabled: number }> = {};

    for (const row of providerRows) {
      byProvider[row.provider] = {
        active: row.active || 0,
        total: row.total || 0,
        disabled: row.disabled || 0,
      };
    }

    return {
      total: totalRow?.total || 0,
      active: totalRow?.active || 0,
      exhausted: totalRow?.exhausted || 0,
      error: totalRow?.error || 0,
      pending: totalRow?.pending || 0,
      disabled: totalRow?.disabled || 0,
      byProvider,
    };
  }
}

export const pool = new AccountPool();
