import { db } from "../db/index";
import { peers, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { syncAllPeers } from "./engine";
import { broadcast } from "../ws/index";
import { addAuthLog } from "../auth/logs";

const INTERVAL_KEY = "sync_interval_minutes";
const DEFAULT_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;

export function isSyncSettingKey(key: string): boolean {
  return key === INTERVAL_KEY;
}

class SyncScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private intervalMinutes = DEFAULT_INTERVAL_MINUTES;
  private nextRunAt: Date | null = null;
  private lastRunAt: Date | null = null;
  private running = false;
  private ticking = false;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.reload();
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.nextRunAt = null;
    this.running = false;
  }

  async reload(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }

    const [row] = await db.select().from(settings).where(eq(settings.key, INTERVAL_KEY));
    const raw = Number(row?.value);
    this.intervalMinutes = Number.isFinite(raw) && raw > 0
      ? Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.floor(raw)))
      : DEFAULT_INTERVAL_MINUTES;

    const peerCount = (await db.select().from(peers).where(eq(peers.enabled, true))).length;
    this.broadcastStatus();

    if (!this.running || peerCount === 0) {
      this.nextRunAt = null;
      return;
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    const delay = this.intervalMinutes * 60_000;
    this.nextRunAt = new Date(Date.now() + delay);
    this.timer = setTimeout(() => { void this.tick(); }, delay);
    this.broadcastStatus();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.timer = null;
    this.lastRunAt = new Date();
    try {
      const results = await syncAllPeers();
      const totals = results.reduce(
        (a, r) => ({ ins: a.ins + r.inserted, upd: a.upd + r.updated, del: a.del + r.deleted, err: a.err + (r.ok ? 0 : 1) }),
        { ins: 0, upd: 0, del: 0, err: 0 },
      );
      if (totals.ins || totals.upd || totals.del || totals.err) {
        addAuthLog({
          type: "sync_tick",
          message: `Sync tick: +${totals.ins} ~${totals.upd} -${totals.del}${totals.err ? ` (${totals.err} peer errors)` : ""}`,
          data: { results },
        });
      }
    } catch (e) {
      addAuthLog({ type: "sync_error", error: e instanceof Error ? e.message : String(e), message: "Sync tick failed" });
    } finally {
      this.ticking = false;
      if (this.running) {
        const peerCount = (await db.select().from(peers).where(eq(peers.enabled, true))).length;
        if (peerCount > 0) this.scheduleNext();
        else { this.nextRunAt = null; this.broadcastStatus(); }
      }
    }
  }

  getStatus() {
    return {
      running: this.running,
      intervalMinutes: this.intervalMinutes,
      nextRunAt: this.nextRunAt ? this.nextRunAt.toISOString() : null,
      lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
    };
  }

  private broadcastStatus(): void {
    broadcast({ type: "sync_status", data: this.getStatus() });
  }
}

export const syncScheduler = new SyncScheduler();
