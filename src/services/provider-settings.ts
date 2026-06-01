import { db } from "../db/index";
import { settings, accounts } from "../db/schema";
import { and, eq, like } from "drizzle-orm";

const PREFIX = "provider_enabled_";
const CACHE_TTL_MS = 5000;

let statesCache: Record<string, boolean> | null = null;
let statesCacheTs = 0;

/** Refresh the enabled/disabled state map from settings (key `provider_enabled_<name>`). */
async function refreshStates(): Promise<Record<string, boolean>> {
  const now = Date.now();
  if (statesCache && now - statesCacheTs < CACHE_TTL_MS) return statesCache;

  const rows = await db.select().from(settings).where(like(settings.key, `${PREFIX}%`));
  const map: Record<string, boolean> = {};
  for (const r of rows) {
    const name = r.key.slice(PREFIX.length);
    map[name] = r.value !== "false";
  }
  statesCache = map;
  statesCacheTs = now;
  return map;
}

export function invalidateProviderSettingsCache() {
  statesCache = null;
  statesCacheTs = 0;
}

export function providerEnabledKey(provider: string): string {
  return `${PREFIX}${provider}`;
}

/** Default-enabled: a provider is disabled only when its setting is explicitly "false". */
export async function isProviderEnabled(provider: string): Promise<boolean> {
  const map = await refreshStates();
  return map[provider] !== false;
}

/** Full enabled/disabled map for the given providers (defaults to enabled). */
export async function getProviderStates(
  allProviders: readonly string[],
): Promise<Record<string, boolean>> {
  const map = await refreshStates();
  const result: Record<string, boolean> = {};
  for (const p of allProviders) result[p] = map[p] !== false;
  return result;
}

/**
 * Providers that are servable right now: enabled AND have at least one
 * active+enabled account. Used to filter /v1/models so clients only see
 * models backed by a real, usable account.
 */
export async function getServableProviders(): Promise<Set<string>> {
  const [states, activeRows] = await Promise.all([
    refreshStates(),
    db
      .select({ provider: accounts.provider })
      .from(accounts)
      .where(and(eq(accounts.status, "active"), eq(accounts.enabled, true)))
      .groupBy(accounts.provider),
  ]);

  const servable = new Set<string>();
  for (const row of activeRows) {
    if (states[row.provider] !== false) servable.add(row.provider);
  }
  return servable;
}
