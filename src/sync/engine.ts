import { db } from "../db/index";
import { accounts, accountTombstones, peers } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/crypto";
import { pool } from "../proxy/pool";
import { broadcast } from "../ws/index";
import { addAuthLog } from "../auth/logs";
import type { SyncExport, SyncAccount } from "../api/sync";

export interface SyncResult {
  peerUrl: string;
  ok: boolean;
  pulled: number; // accounts received
  inserted: number;
  updated: number;
  skipped: number;
  deleted: number; // accounts removed via tombstone
  error?: string;
}

// Does the local row already match the incoming account? If so we must NOT
// write (writing bumps updatedAt → causes an endless ping-pong between peers
// that keep re-pushing identical data each cycle).
function sameData(localPasswordEnc: string, localTokens: unknown, localEnabled: boolean, incoming: SyncAccount): boolean {
  let localPw = "";
  try {
    localPw = localPasswordEnc ? decrypt(localPasswordEnc) : "";
  } catch {
    localPw = "\u0000unreadable"; // force "different" so we heal a corrupt row
  }
  const pwSame = localPw === incoming.password;
  const tokSame = JSON.stringify(localTokens ?? null) === JSON.stringify(incoming.tokens ?? null);
  const enSame = localEnabled === incoming.enabled;
  return pwSame && tokSame && enSame;
}

/**
 * Pull from a single peer and merge into the local DB.
 *  - new account            → INSERT (password re-encrypted with OUR key)
 *  - existing, peer newer    → UPDATE (only if data actually differs)
 *  - existing, local newer   → SKIP
 *  - tombstone newer than local copy → DELETE local + record tombstone locally
 * Watermark = the peer's own clock (`now`), stored in peers.lastSyncAt.
 */
export async function syncFromPeer(peer: typeof peers.$inferSelect): Promise<SyncResult> {
  const result: SyncResult = {
    peerUrl: peer.url, ok: false, pulled: 0, inserted: 0, updated: 0, skipped: 0, deleted: 0,
  };

  const since = peer.lastSyncAt ? peer.lastSyncAt.toISOString() : null;
  const url = `${peer.url}/api/sync/export${since ? `?since=${encodeURIComponent(since)}` : ""}`;

  let payload: SyncExport;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${peer.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = (await res.json()) as SyncExport;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await db.update(peers).set({ lastSyncStatus: "error", lastError: result.error, updatedAt: new Date() }).where(eq(peers.id, peer.id));
    return result;
  }

  result.pulled = payload.accounts.length;
  const affectedProviders = new Set<string>();

  // ── Merge accounts ──────────────────────────────────────────────
  for (const inc of payload.accounts) {
    const [local] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.provider, inc.provider), eq(accounts.email, inc.email)));

    if (!local) {
      // Don't resurrect something we deliberately deleted more recently.
      const [tomb] = await db
        .select()
        .from(accountTombstones)
        .where(and(eq(accountTombstones.provider, inc.provider), eq(accountTombstones.email, inc.email)));
      if (tomb && tomb.deletedAt >= new Date(inc.updatedAt)) {
        result.skipped++;
        continue;
      }
      await db.insert(accounts).values({
        provider: inc.provider,
        email: inc.email,
        password: encrypt(inc.password || ""),
        tokens: inc.tokens as unknown,
        enabled: inc.enabled,
        status: "pending", // local runtime state, re-evaluated by warmup/use
      });
      result.inserted++;
      affectedProviders.add(inc.provider);
      continue;
    }

    const localUpdated = (local.updatedAt ?? local.createdAt ?? new Date(0)).getTime();
    const incUpdated = new Date(inc.updatedAt).getTime();
    if (incUpdated <= localUpdated) {
      result.skipped++;
      continue;
    }
    if (sameData(local.password, local.tokens, local.enabled, inc)) {
      result.skipped++; // newer timestamp but identical payload → no write (anti-bounce)
      continue;
    }
    await db.update(accounts).set({
      password: encrypt(inc.password || ""),
      tokens: inc.tokens as unknown,
      enabled: inc.enabled,
      updatedAt: new Date(),
    }).where(eq(accounts.id, local.id));
    result.updated++;
    affectedProviders.add(inc.provider);
  }

  // ── Apply tombstones ────────────────────────────────────────────
  for (const t of payload.tombstones) {
    const deletedAt = new Date(t.deletedAt);
    const [local] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.provider, t.provider), eq(accounts.email, t.email)));
    if (local) {
      const localUpdated = (local.updatedAt ?? local.createdAt ?? new Date(0)).getTime();
      if (deletedAt.getTime() > localUpdated) {
        await db.delete(accounts).where(eq(accounts.id, local.id));
        result.deleted++;
        affectedProviders.add(t.provider);
      }
    }
    // Record/refresh the tombstone locally so it propagates onward.
    const [existingTomb] = await db
      .select()
      .from(accountTombstones)
      .where(and(eq(accountTombstones.provider, t.provider), eq(accountTombstones.email, t.email)));
    if (!existingTomb) {
      await db.insert(accountTombstones).values({ provider: t.provider, email: t.email, deletedAt });
    } else if (deletedAt > existingTomb.deletedAt) {
      await db.update(accountTombstones).set({ deletedAt }).where(eq(accountTombstones.id, existingTomb.id));
    }
  }

  // Advance watermark to the peer's clock; invalidate affected provider pools.
  await db.update(peers).set({
    lastSyncAt: new Date(payload.now),
    lastSyncStatus: "ok",
    lastError: null,
    updatedAt: new Date(),
  }).where(eq(peers.id, peer.id));

  for (const p of affectedProviders) pool.invalidate(p as never);
  if (result.inserted || result.updated || result.deleted) {
    broadcast({ type: "accounts_synced", data: { peer: peer.url, ...result } });
    addAuthLog({
      type: "sync_pull",
      message: `Sync from ${peer.url}: +${result.inserted} ~${result.updated} -${result.deleted} (skip ${result.skipped})`,
      data: { ...result },
    });
  }

  result.ok = true;
  return result;
}

/** Pull from every enabled peer once. */
export async function syncAllPeers(): Promise<SyncResult[]> {
  const allPeers = await db.select().from(peers).where(eq(peers.enabled, true));
  const results: SyncResult[] = [];
  for (const peer of allPeers) {
    results.push(await syncFromPeer(peer));
  }
  return results;
}
