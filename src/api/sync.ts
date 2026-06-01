import { Hono } from "hono";
import { db } from "../db/index";
import { accounts, accountTombstones, peers, settings } from "../db/schema";
import { gt, eq } from "drizzle-orm";
import { decrypt } from "../utils/crypto";
import { getActiveApiKey } from "./keys";

export const syncRouter = new Hono();

const SELF_URL_SETTING = "sync_self_url";

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, ""); // strip trailing slashes
}

async function getSelfUrl(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SELF_URL_SETTING));
  return row?.value ? normalizeUrl(row.value) : "";
}

// Account fields that are SHARED across devices (identity + credentials).
// Runtime fields (quota, status, lastUsedAt, errorMessage) stay local and
// are intentionally NOT exported — each device tracks its own usage.
export interface SyncAccount {
  provider: string;
  email: string;
  password: string; // DECRYPTED plaintext — re-encrypted by the importer
  tokens: unknown; // plain JSON (not encrypted at rest)
  enabled: boolean;
  updatedAt: string; // ISO, used for last-write-wins
}

export interface SyncTombstone {
  provider: string;
  email: string;
  deletedAt: string; // ISO
}

export interface SyncExport {
  now: string; // server clock — caller stores this as its next `since` watermark
  accounts: SyncAccount[];
  tombstones: SyncTombstone[];
}

/**
 * GET /api/sync/export?since=<ISO>
 *
 * Returns accounts + tombstones changed since the given watermark (or all if
 * omitted). Tokens travel raw over the (HTTPS) wire; the endpoint is already
 * behind the /api/* API-key auth middleware. Password is decrypted here so the
 * importer can re-encrypt with ITS OWN key — this is what lets each device run
 * a different ENCRYPTION_KEY while still sharing accounts.
 */
syncRouter.get("/export", async (c) => {
  const sinceParam = c.req.query("since");
  const since = sinceParam ? new Date(sinceParam) : null;
  const validSince = since && !isNaN(since.getTime()) ? since : null;

  const allAccounts = validSince
    ? await db.select().from(accounts).where(gt(accounts.updatedAt, validSince))
    : await db.select().from(accounts);

  const allTombstones = validSince
    ? await db.select().from(accountTombstones).where(gt(accountTombstones.deletedAt, validSince))
    : await db.select().from(accountTombstones);

  const exportedAccounts: SyncAccount[] = allAccounts.map((acc) => {
    let password = "";
    try {
      password = acc.password ? decrypt(acc.password) : "";
    } catch {
      password = ""; // unreadable locally → send empty, importer keeps existing
    }
    return {
      provider: acc.provider,
      email: acc.email,
      password,
      tokens: acc.tokens ?? null,
      enabled: acc.enabled,
      updatedAt: (acc.updatedAt ?? acc.createdAt ?? new Date()).toISOString(),
    };
  });

  const exportedTombstones: SyncTombstone[] = allTombstones.map((t) => ({
    provider: t.provider,
    email: t.email,
    deletedAt: t.deletedAt.toISOString(),
  }));

  const payload: SyncExport = {
    now: new Date().toISOString(),
    accounts: exportedAccounts,
    tombstones: exportedTombstones,
  };
  return c.json(payload);
});

// ── Peer management ──────────────────────────────────────────────
// Peers are other poolprox instances we two-way sync accounts with.

function sanitizePeer(p: typeof peers.$inferSelect) {
  return { ...p, apiKey: p.apiKey ? "[set]" : null };
}

// GET /api/sync/peers — list configured peers (api key redacted)
syncRouter.get("/peers", async (c) => {
  const rows = await db.select().from(peers);
  const selfUrl = await getSelfUrl();
  return c.json({ data: rows.map(sanitizePeer), selfUrl });
});

// POST /api/sync/peers — add a peer and announce ourselves to it (two-way).
// body: { url, apiKey, label?, selfUrl? }
// selfUrl = our own public URL so the peer can pull from us too. If provided
// it is persisted so future pairings can omit it.
syncRouter.post("/peers", async (c) => {
  const body = await c.req
    .json<{ url?: string; apiKey?: string; label?: string; selfUrl?: string }>()
    .catch(() => ({}) as Record<string, string>);

  const url = normalizeUrl(body.url || "");
  const apiKey = (body.apiKey || "").trim();
  if (!url || !apiKey) {
    return c.json({ error: "url and apiKey are required" }, 400);
  }
  if (!/^https?:\/\//.test(url)) {
    return c.json({ error: "url must start with http:// or https://" }, 400);
  }

  // Persist our own URL if the caller told us what it is.
  let selfUrl = await getSelfUrl();
  if (body.selfUrl) {
    selfUrl = normalizeUrl(body.selfUrl);
    const [exists] = await db.select().from(settings).where(eq(settings.key, SELF_URL_SETTING));
    if (exists) {
      await db.update(settings).set({ value: selfUrl, updatedAt: new Date() }).where(eq(settings.key, SELF_URL_SETTING));
    } else {
      await db.insert(settings).values({ key: SELF_URL_SETTING, value: selfUrl });
    }
  }

  // Refuse to peer with ourselves (would create an endless self-sync loop).
  if (selfUrl && url === selfUrl) {
    return c.json({ error: "Cannot add self as a peer (url matches this instance's selfUrl)" }, 400);
  }

  // Verify the peer is reachable + key works before saving.
  let reachable = false;
  let peerErr = "";
  try {
    const res = await fetch(`${url}/api/sync/export?since=2099-01-01T00:00:00.000Z`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    reachable = res.ok;
    if (!res.ok) peerErr = `peer returned HTTP ${res.status}`;
  } catch (e) {
    peerErr = e instanceof Error ? e.message : String(e);
  }
  if (!reachable) {
    return c.json({ error: `Cannot reach peer: ${peerErr}` }, 400);
  }

  // Upsert peer locally (unique by url).
  const [existing] = await db.select().from(peers).where(eq(peers.url, url));
  if (existing) {
    await db.update(peers).set({ apiKey, label: body.label ?? existing.label, enabled: true, updatedAt: new Date() }).where(eq(peers.id, existing.id));
  } else {
    await db.insert(peers).values({ url, apiKey, label: body.label });
  }

  // Announce ourselves to the peer so it pulls from us too (best-effort).
  let announced = false;
  let announceErr = "";
  if (selfUrl) {
    const ourKey = await getActiveApiKey();
    try {
      const res = await fetch(`${url}/api/sync/register-peer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ url: selfUrl, apiKey: ourKey, label: body.label }),
        signal: AbortSignal.timeout(10_000),
      });
      announced = res.ok;
      if (!res.ok) announceErr = `peer register HTTP ${res.status}`;
    } catch (e) {
      announceErr = e instanceof Error ? e.message : String(e);
    }
  } else {
    announceErr = "selfUrl not set — peer cannot pull from us until configured";
  }

  return c.json({ ok: true, url, twoWay: announced, announceError: announced ? null : announceErr });
});

// POST /api/sync/register-peer — a peer announces itself to us (two-way pairing).
// Already behind /api/* auth, so the caller proved it holds OUR api key.
// body: { url, apiKey, label? } = the caller's own URL + key for us to pull from.
syncRouter.post("/register-peer", async (c) => {
  const body = await c.req
    .json<{ url?: string; apiKey?: string; label?: string }>()
    .catch(() => ({}) as Record<string, string>);
  const url = normalizeUrl(body.url || "");
  const apiKey = (body.apiKey || "").trim();
  if (!url || !apiKey) {
    return c.json({ error: "url and apiKey are required" }, 400);
  }
  const [existing] = await db.select().from(peers).where(eq(peers.url, url));
  if (existing) {
    await db.update(peers).set({ apiKey, label: body.label ?? existing.label, enabled: true, updatedAt: new Date() }).where(eq(peers.id, existing.id));
  } else {
    await db.insert(peers).values({ url, apiKey, label: body.label });
  }
  return c.json({ ok: true });
});

// DELETE /api/sync/peers/:id — remove a peer (local only; does not unpair remote)
syncRouter.delete("/peers/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(peers).where(eq(peers.id, id));
  return c.json({ ok: true });
});

// POST /api/sync/run — trigger a sync pull from all enabled peers right now.
syncRouter.post("/run", async (c) => {
  const { syncAllPeers } = await import("../sync/engine");
  const results = await syncAllPeers();
  return c.json({ ok: true, results });
});

// GET /api/sync/status — scheduler status + peer summary
syncRouter.get("/status", async (c) => {
  const { syncScheduler } = await import("../sync/scheduler");
  const peerRows = await db.select().from(peers);
  return c.json({
    scheduler: syncScheduler.getStatus(),
    peers: peerRows.map(sanitizePeer),
    selfUrl: await getSelfUrl(),
  });
});
