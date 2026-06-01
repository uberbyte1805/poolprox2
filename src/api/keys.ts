import { Hono } from "hono";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";

const API_KEY_SETTING = "api_key";
const PASSWORD_SETTING = "dashboard_password_hash";
const API_KEY_CACHE_TTL_MS = 5_000;

let activeApiKeyCache: { key: string; expiresAt: number } | null = null;

export const keysRouter = new Hono();

function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `sk-pool-${token}`;
}

export async function getActiveApiKey(): Promise<string> {
  const now = Date.now();
  if (activeApiKeyCache && activeApiKeyCache.expiresAt > now) {
    return activeApiKeyCache.key;
  }

  const [row] = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  const key = row?.value || config.apiKey;
  activeApiKeyCache = { key, expiresAt: now + API_KEY_CACHE_TTL_MS };
  return key;
}

export async function isValidApiKey(token: string): Promise<boolean> {
  if (!token) return false;
  if (token === config.apiKey) return true;
  const active = await getActiveApiKey();
  return token === active;
}

async function saveApiKey(key: string) {
  const existing = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  if (existing.length > 0) {
    await db.update(settings).set({ value: key, updatedAt: new Date() }).where(eq(settings.key, API_KEY_SETTING));
  } else {
    await db.insert(settings).values({ key: API_KEY_SETTING, value: key });
  }
  activeApiKeyCache = { key, expiresAt: Date.now() + API_KEY_CACHE_TTL_MS };
}

keysRouter.get("/", async (c) => {
  const key = await getActiveApiKey();
  return c.json({ key, source: key === config.apiKey ? "env" : "database" });
});

keysRouter.post("/regenerate", async (c) => {
  const key = generateApiKey();
  await saveApiKey(key);
  return c.json({ key, source: "database" });
});

keysRouter.post("/set", async (c) => {
  const body = await c.req.json<{ key: string }>();
  if (!body.key || body.key.length < 16) {
    return c.json({ error: "API key must be at least 16 characters" }, 400);
  }
  await saveApiKey(body.key);
  return c.json({ key: body.key, source: "database" });
});

keysRouter.post("/test", async (c) => {
  const body = await c.req.json<{ key: string }>();
  const valid = await isValidApiKey(body.key || "");
  return c.json({ valid });
});

// ── Password-based dashboard login ───────────────────────────────
// Password is a friendly front-door: verifying it returns the active
// API key, which the frontend stores and uses for every other call.
// The API key remains the source of truth (and the recovery proof).

async function getPasswordHash(): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, PASSWORD_SETTING));
  return row?.value || null;
}

async function savePasswordHash(hash: string) {
  const existing = await db.select().from(settings).where(eq(settings.key, PASSWORD_SETTING));
  if (existing.length > 0) {
    await db.update(settings).set({ value: hash, updatedAt: new Date() }).where(eq(settings.key, PASSWORD_SETTING));
  } else {
    await db.insert(settings).values({ key: PASSWORD_SETTING, value: hash });
  }
}

// Whether a dashboard password has been set (drives first-run setup UI).
keysRouter.get("/has-password", async (c) => {
  const hash = await getPasswordHash();
  return c.json({ hasPassword: !!hash });
});

// Login with password → returns the active API key on success.
keysRouter.post("/login", async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  const password = body.password || "";
  if (!password) {
    return c.json({ error: "Password required" }, 400);
  }
  const hash = await getPasswordHash();
  if (!hash) {
    return c.json({ error: "No password set. Use API key to set one first." }, 409);
  }
  const ok = await Bun.password.verify(password, hash);
  if (!ok) {
    return c.json({ error: "Invalid password" }, 401);
  }
  const key = await getActiveApiKey();
  return c.json({ key });
});

// Set/reset password. Proof = a valid API key (also the first-run path
// and the "forgot password" recovery). Optionally returns the key so the
// caller can log straight in.
keysRouter.post("/set-password", async (c) => {
  const body = await c.req
    .json<{ key?: string; password?: string }>()
    .catch(() => ({}) as { key?: string; password?: string });
  const key = (body.key || "").trim();
  const password = body.password || "";

  if (!(await isValidApiKey(key))) {
    return c.json({ error: "Invalid API key" }, 401);
  }
  if (password.length < 6) {
    return c.json({ error: "Password must be at least 6 characters" }, 400);
  }

  const hash = await Bun.password.hash(password);
  await savePasswordHash(hash);
  const activeKey = await getActiveApiKey();
  return c.json({ ok: true, key: activeKey });
});
