import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Plus, Trash2, Link2, AlertCircle, CheckCircle2 } from "lucide-react";
import {
  fetchSyncStatus,
  addSyncPeer,
  deleteSyncPeer,
  runSyncNow,
  type SyncStatus,
  type SyncPeer,
} from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return new Date(iso).toLocaleTimeString();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function Sync() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const { message, setMessage } = useTimedMessage<string>(null, 4000);
  const { message: errorMsg, setMessage: setErrorMsg } = useTimedMessage<string>(null, 6000);

  // Add-peer form
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [selfUrl, setSelfUrl] = useState("");
  const [adding, setAdding] = useState(false);

  async function load() {
    try {
      const s = await fetchSyncStatus();
      setStatus(s);
      if (s.selfUrl && !selfUrl) setSelfUrl(s.selfUrl);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || !apiKey.trim()) {
      setErrorMsg("URL dan API key wajib diisi");
      return;
    }
    setAdding(true);
    setErrorMsg(null);
    try {
      const res = await addSyncPeer({
        url: url.trim(),
        apiKey: apiKey.trim(),
        label: label.trim() || undefined,
        selfUrl: selfUrl.trim() || undefined,
      });
      if (res.twoWay) {
        setMessage("Peer ditambahkan. Sinkron dua arah aktif.");
      } else {
        setMessage(`Peer ditambahkan (satu arah). ${res.announceError || ""}`.trim());
      }
      setUrl("");
      setApiKey("");
      setLabel("");
      setShowForm(false);
      await load();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(peer: SyncPeer) {
    if (!confirm(`Hapus peer ${peer.url}? Akun yang sudah tersinkron tetap ada.`)) return;
    try {
      await deleteSyncPeer(peer.id);
      setMessage("Peer dihapus.");
      await load();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRunNow() {
    setRunning(true);
    setErrorMsg(null);
    try {
      const res = await runSyncNow();
      const r = (res.results || []) as Array<{ inserted: number; updated: number; deleted: number; ok: boolean }>;
      const tot = r.reduce(
        (a, x) => ({ ins: a.ins + (x.inserted || 0), upd: a.upd + (x.updated || 0), del: a.del + (x.deleted || 0), err: a.err + (x.ok ? 0 : 1) }),
        { ins: 0, upd: 0, del: 0, err: 0 },
      );
      setMessage(`Sync selesai: +${tot.ins} baru, ${tot.upd} update, ${tot.del} hapus${tot.err ? ` (${tot.err} peer error)` : ""}`);
      await load();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const peers = status?.peers || [];
  const sched = status?.scheduler;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Account Sync</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Sinkron akun antar device. Tiap device tetap punya API key & encryption key sendiri.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="w-4 h-4 mr-2" /> Reload
          </Button>
          <Button size="sm" onClick={handleRunNow} disabled={running || peers.length === 0}>
            <RefreshCw className={`w-4 h-4 mr-2 ${running ? "animate-spin" : ""}`} />
            {running ? "Menyinkron..." : "Sync Sekarang"}
          </Button>
        </div>
      </div>

      {message && (
        <div className="rounded-md bg-green-500/10 p-3 text-sm text-green-400 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" /> {message}
        </div>
      )}
      {errorMsg && (
        <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {errorMsg}
        </div>
      )}

      {/* Scheduler status */}
      <Card className="border-[var(--border)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Status Scheduler</CardTitle>
          <CardDescription>
            Pull otomatis dari semua peer aktif tiap interval.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-[var(--muted-foreground)]">Status</p>
              <p className="font-medium text-[var(--foreground)]">
                {sched?.running ? (peers.length ? "Aktif" : "Idle (no peer)") : "Mati"}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted-foreground)]">Interval</p>
              <p className="font-medium text-[var(--foreground)]">{sched?.intervalMinutes ?? "-"} menit</p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted-foreground)]">Sync terakhir</p>
              <p className="font-medium text-[var(--foreground)]">{relTime(sched?.lastRunAt ?? null)}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted-foreground)]">Sync berikutnya</p>
              <p className="font-medium text-[var(--foreground)]">
                {sched?.nextRunAt ? new Date(sched.nextRunAt).toLocaleTimeString() : "-"}
              </p>
            </div>
          </div>
          {status?.selfUrl && (
            <p className="mt-4 text-xs text-[var(--muted-foreground)]">
              URL device ini (selfUrl): <span className="font-mono text-[var(--foreground)]">{status.selfUrl}</span>
            </p>
          )}
        </CardContent>
      </Card>

      {/* Peers list */}
      <Card className="border-[var(--border)]">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Link2 className="w-4 h-4 text-[var(--primary)]" /> Device Terhubung
              </CardTitle>
              <CardDescription>Peer yang akunnya disinkron dua arah dengan device ini.</CardDescription>
            </div>
            <Button size="sm" variant={showForm ? "outline" : "default"} onClick={() => setShowForm((v) => !v)}>
              <Plus className="w-4 h-4 mr-2" /> {showForm ? "Tutup" : "Tambah Peer"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {showForm && (
            <form onSubmit={handleAdd} className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4 space-y-3">
              <div>
                <label className="text-sm text-[var(--foreground)]">URL PoolProxy pertama</label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://proxy.yahnia.my.id"
                  className="mt-1 font-mono text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">API Key device tujuan</label>
                <Input
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="pp2-..."
                  className="mt-1 font-mono text-sm"
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  API key milik PoolProxy yang mau kamu tarik akunnya (bukan key device ini).
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-[var(--foreground)]">Label (opsional)</label>
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Server / Laptop" className="mt-1 text-sm" />
                </div>
                <div>
                  <label className="text-sm text-[var(--foreground)]">URL device ini (selfUrl)</label>
                  <Input
                    value={selfUrl}
                    onChange={(e) => setSelfUrl(e.target.value)}
                    placeholder="https://laptop.example.com"
                    className="mt-1 font-mono text-sm"
                  />
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                    Biar peer bisa narik balik dari device ini (sinkron dua arah).
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={adding}>
                  {adding ? "Menghubungkan..." : "Hubungkan & Sync"}
                </Button>
              </div>
            </form>
          )}

          {peers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border)] p-8 text-center">
              <p className="text-sm text-[var(--muted-foreground)]">
                Belum ada device terhubung. Tambah peer untuk mulai sinkron akun.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {peers.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-3 p-3 rounded-lg bg-[var(--secondary)] border border-transparent hover:border-[var(--border)] transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--foreground)] truncate">
                      {p.label || p.url}
                    </p>
                    <p className="text-xs text-[var(--muted-foreground)] font-mono truncate">{p.url}</p>
                    <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
                      {p.lastSyncStatus === "error" ? (
                        <span className="text-red-400">Error: {p.lastError || "gagal sync"}</span>
                      ) : (
                        <span>
                          Terakhir sync: {relTime(p.lastSyncAt)}
                          {p.lastSyncStatus === "ok" && <span className="text-green-400"> · ok</span>}
                        </span>
                      )}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(p)}
                    className="text-red-400 hover:bg-red-500/10 shrink-0"
                  >
                    <Trash2 className="w-4 h-4 mr-2" /> Hapus
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
