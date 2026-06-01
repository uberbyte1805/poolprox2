import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle as DTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Plus, Upload, RefreshCw, Play, RotateCcw, Flame } from "lucide-react";
import {
  createAccount,
  fetchAccounts,
  fetchApi,
  fetchAuthQueue,
  fetchAutoWarmupStatus,
  fetchSettings,
  fetchWarmupQueue,
  getWsBase,
  importAccounts,
  loginAccounts,
  loginAllAccounts,
  updateSettings,
  warmupAllAccounts,
  type AutoWarmupStatus,
} from "@/lib/api";

type Provider = "kiro" | "kiro-pro" | "codebuddy" | "canva" | "zai" | "moclaw" | "codex" | "pioneer" | "qoder" | "oneminai";

interface Account {
  id: number;
  email: string;
  provider: Provider;
  status: string;
  quotaLimit?: number;
  quotaRemaining?: number;
}

const providers: Provider[] = ["kiro", "kiro-pro", "codebuddy", "canva", "zai", "moclaw", "codex", "pioneer", "qoder", "oneminai"];

function labelProvider(provider: string) {
  if (provider === "kiro-pro") return "Kiro Pro";
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "zai") return "Z.ai";
  if (provider === "moclaw") return "Moclaw";
  if (provider === "codex") return "Codex";
  if (provider === "qoder") return "Qoder";
  if (provider === "oneminai") return "1minAI";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export default function Accounts() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<any>(null);
  const [warmupQueue, setWarmupQueue] = useState<any>(null);
  const [autoWarmup, setAutoWarmup] = useState<AutoWarmupStatus | null>(null);
  const [settingsMap, setSettingsMap] = useState<Record<string, string>>({});
  const [now, setNow] = useState<number>(Date.now());

  const [addForm, setAddForm] = useState({ email: "", password: "", provider: "kiro" as Provider, browserEngine: "camoufox", headless: false });
  const [addDialogProvider, setAddDialogProvider] = useState<Provider | null>(null);
  const [instantTokens, setInstantTokens] = useState("");
  const [cookieValue, setCookieValue] = useState("");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [addMode, setAddMode] = useState<"single" | "bulk" | "instant" | "pat" | "apikey">("bulk");
  const [bulkBrowserEngine, setBulkBrowserEngine] = useState("camoufox");
  const [bulkHeadless, setBulkHeadless] = useState(true);
  const [bulkConcurrency, setBulkConcurrency] = useState(3);
  const [bulkUseProxy, setBulkUseProxy] = useState(true);
  const [bulkProxyMode, setBulkProxyMode] = useState<"round-robin" | "random">("round-robin");
  const [loginPendingDialog, setLoginPendingDialog] = useState(false);
  const [loginPendingConcurrency, setLoginPendingConcurrency] = useState(2);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingRef = useRef(false);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const [accountsRes, queueRes, warmupQueueRes, autoWarmupRes, settingsRes] = await Promise.all([
        fetchAccounts() as Promise<{ data: Account[] }>,
        fetchAuthQueue().catch(() => null),
        fetchWarmupQueue().catch(() => null),
        fetchAutoWarmupStatus().catch(() => null),
        fetchSettings().catch(() => null) as Promise<{ data: Record<string, string> } | null>,
      ]);
      setAccounts(accountsRes.data || []);
      setQueue(queueRes);
      setWarmupQueue(warmupQueueRes);
      setAutoWarmup(autoWarmupRes);
      setSettingsMap(settingsRes?.data || {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => {
      if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const active = Number(warmupQueue?.active || 0) + Number(queue?.active || 0);
    if (active === 0) return;
    const interval = setInterval(() => load(), 2000);
    return () => clearInterval(interval);
  }, [warmupQueue?.active, queue?.active]);

  useEffect(() => {
    if (!autoWarmup?.nextRunAt) return;
    const targetMs = new Date(autoWarmup.nextRunAt).getTime();
    let refetched = false;
    const tick = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (!refetched && current >= targetMs) {
        refetched = true;
        setTimeout(() => {
          fetchAutoWarmupStatus().then(setAutoWarmup).catch(() => {});
          load();
        }, 1500);
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [autoWarmup?.nextRunAt]);

  // Set the default add-mode for the freshly-opened provider dialog so the
  // right panel renders (each provider exposes a different set of tabs).
  useEffect(() => {
    if (!addDialogProvider) return;
    if (addDialogProvider === "kiro-pro" || addDialogProvider === "codex" || addDialogProvider === "pioneer") {
      setAddMode("instant");
    } else if (addDialogProvider === "qoder") {
      setAddMode("pat");
    } else if (addDialogProvider === "oneminai") {
      setAddMode("apikey");
    } else {
      setAddMode("bulk");
    }
  }, [addDialogProvider]);

  useEffect(() => {
    const ws = new WebSocket(`${getWsBase()}/ws`);
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = () => {
      if (loadTimer) clearTimeout(loadTimer);
      loadTimer = setTimeout(() => load(), 800);
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "auto_warmup_status") {
          setAutoWarmup(msg.data);
          return;
        }
        if (
          msg.type === "warmup_complete" ||
          msg.type === "warmup_success" ||
          msg.type === "warmup_exhausted" ||
          msg.type === "warmup_auth_error" ||
          msg.type === "warmup_transient_error" ||
          msg.type === "account_status"
        ) {
          scheduleLoad();
        }
      } catch {}
    };
    return () => {
      if (loadTimer) clearTimeout(loadTimer);
      ws.close();
    };
  }, []);

  async function handleToggleAutoWarmup(provider: Provider) {
    const key = `auto_warmup_provider_${provider}`;
    const next = settingsMap[key] === "true" ? "false" : "true";
    setSettingsMap((current) => ({ ...current, [key]: next }));
    try {
      await updateSettings({ [key]: next });
      const status = await fetchAutoWarmupStatus();
      setAutoWarmup(status);
      showSuccess(`Auto WarmUp ${next === "true" ? "enabled" : "disabled"} for ${labelProvider(provider)}`);
    } catch (err) {
      setSettingsMap((current) => ({ ...current, [key]: next === "true" ? "false" : "true" }));
      showError(err);
    }
  }

  function autoWarmupEnabledFor(provider: Provider): boolean {
    return settingsMap[`auto_warmup_provider_${provider}`] === "true";
  }

  function countdownLabel(): string {
    if (!autoWarmup?.nextRunAt) return "—";
    const remaining = Math.max(0, new Date(autoWarmup.nextRunAt).getTime() - now);
    const totalSeconds = Math.floor(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  function showSuccess(text: string) {
    setMessage(text);
    setError(null);
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    messageTimerRef.current = setTimeout(() => setMessage(null), 4000);
  }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); setMessage(null); }

  async function handleAdd() {
    if (!addDialogProvider) return;
    try {
      const payload: any = { email: addForm.email, password: addForm.password, provider: addDialogProvider, headless: addForm.headless, browserEngine: addForm.browserEngine };
      await createAccount(payload);
      showSuccess("Account added and bot login started.");
      setAddForm({ email: "", password: "", provider: "kiro", browserEngine: "camoufox", headless: false });
      setAddDialogProvider(null);
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  async function handleInstantLogin() {
    if (!instantTokens.trim()) { showError(new Error("Paste refresh tokens (one per line)")); return; }
    const tokens = instantTokens.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (tokens.length === 0) { showError(new Error("No valid tokens found")); return; }

    try {
      const res = await fetchApi<{ success: number; failed: number; errors?: string[] }>("/api/accounts/instant-login", {
        method: "POST",
        body: JSON.stringify({ tokens, provider: addDialogProvider }),
      });
      showSuccess(`Instant login: ${res.success} success, ${res.failed} failed`);
      setInstantTokens("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleCookieLogin() {
    if (!cookieValue.trim()) { showError(new Error("Paste Personal Access Token (PAT)")); return; }
    try {
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: "qoder",
          personalToken: cookieValue.trim(),
        }),
      });
      showSuccess("Qoder account added successfully");
      setCookieValue("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleApiKeyLogin() {
    if (!apiKeyValue.trim()) { showError(new Error("Paste 1minAI API key(s), one per line")); return; }
    // Each line: "email:api_key" OR just "api_key" (email auto-generated).
    const lines = apiKeyValue.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) { showError(new Error("No valid API keys found")); return; }

    let ok = 0, failed = 0;
    for (const line of lines) {
      // Split only on the FIRST ':' so api keys containing ':' stay intact.
      const idx = line.indexOf(":");
      const hasEmail = idx > 0 && line.slice(0, idx).includes("@");
      const email = hasEmail ? line.slice(0, idx) : `1minai-${Date.now()}-${ok + failed}@apikey.local`;
      const apiKey = hasEmail ? line.slice(idx + 1).trim() : line;
      if (!apiKey) { failed++; continue; }
      try {
        await fetchApi("/api/accounts", {
          method: "POST",
          body: JSON.stringify({
            provider: "oneminai",
            email,
            password: "api-key-login",
            tokens: { api_key: apiKey },
          }),
        });
        ok++;
      } catch { failed++; }
    }
    showSuccess(`1minAI: ${ok} added${failed ? `, ${failed} failed` : ""}. Quota auto-fetching...`);
    setApiKeyValue("");
    setAddDialogProvider(null);
    await load();
  }

  async function handleBulkImport() {
    if (!addDialogProvider || !bulkText.trim()) { showError(new Error("Paste email|password atau email:password lines")); return; }
    try {
      const opts: any = { headless: bulkHeadless, browserEngine: bulkBrowserEngine, concurrency: bulkConcurrency, useProxy: bulkUseProxy, proxyMode: bulkProxyMode };
      const res = await importAccounts(bulkText, [addDialogProvider], opts) as any;
      showSuccess(res.message || "Bulk import queued.");
      setBulkText("");
      setAddDialogProvider(null);
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  async function handleLoginAll() {
    setLoginPendingDialog(true);
  }

  async function confirmLoginAll() {
    setLoginPendingDialog(false);
    try {
      const res = await loginAllAccounts({ concurrency: loginPendingConcurrency }) as any;
      showSuccess(res.message || "Login all queued.");
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  async function handleWarmupProvider(provider: Provider) {
    try {
      const res = await warmupAllAccounts({ providers: [provider], statuses: ["active", "exhausted", "error"] }) as any;
      showSuccess(res.message || `${labelProvider(provider)} WarmUp queued.`);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleRetryErrors(provider: Provider) {
    const ids = accounts.filter((a) => a.provider === provider && a.status === "error").map((a) => a.id);
    if (ids.length === 0) return;
    await loginAccounts(ids);
    showSuccess(`Queued ${ids.length} ${labelProvider(provider)} error accounts for retry.`);
    await load();
  }

  const providerStats = useMemo(() => {
    return providers.map((provider) => {
      const rows = accounts.filter((a) => a.provider === provider);
      return {
        provider,
        total: rows.length,
        active: rows.filter((a) => a.status === "active").length,
        exhausted: rows.filter((a) => a.status === "exhausted").length,
        pending: rows.filter((a) => a.status === "pending").length,
        error: rows.filter((a) => a.status === "error").length,
      };
    });
  }, [accounts]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Accounts</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">Manage provider accounts</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleLoginAll}>
            <Play className="w-4 h-4 mr-2" /> Login Pending
          </Button>
        </div>
      </div>

      {/* Messages */}
      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
          {message || error}
        </div>
      )}

      {/* Queue status */}
      {(Number(queue?.active || 0) > 0 || Number(queue?.queued || 0) > 0 || Number(warmupQueue?.active || 0) > 0 || Number(warmupQueue?.queued || 0) > 0) && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3 text-xs text-[var(--muted-foreground)]">
          Login: {Number(queue?.active || 0)} running, {Number(queue?.queued || 0)} queued
          {" | "}
          WarmUp: {Number(warmupQueue?.active || 0)} running, {Number(warmupQueue?.queued || 0)} queued
        </div>
      )}

      {/* Provider cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {providerStats.map((stat) => (
          <Card
            key={stat.provider}
            className="border-[var(--border)] cursor-pointer hover:border-[var(--primary)]/50 transition-colors"
            onClick={() => navigate(`/accounts/${stat.provider}`)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{labelProvider(stat.provider)}</CardTitle>
                <span className="text-xs text-[var(--muted-foreground)]">{stat.total} accounts</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Status grid */}
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-green-400">{stat.active}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Active</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-yellow-400">{stat.exhausted}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Exhausted</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-orange-400">{stat.pending}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Pending</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-red-400">{stat.error}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Error</p>
                </div>
              </div>

              {/* Auto WarmUp toggle + countdown */}
              <div
                className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 p-2"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Flame className={`h-4 w-4 shrink-0 ${autoWarmupEnabledFor(stat.provider) ? "text-orange-400" : "text-[var(--muted-foreground)]"}`} />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[var(--foreground)] leading-tight">Auto WarmUp</p>
                    <p className="text-[10px] text-[var(--muted-foreground)] leading-tight">
                      {autoWarmupEnabledFor(stat.provider)
                        ? autoWarmup?.nextRunAt
                          ? `Next in ${countdownLabel()} · every ${autoWarmup.intervalMinutes}m`
                          : `Every ${autoWarmup?.intervalMinutes ?? 15}m`
                        : "Disabled"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleAutoWarmup(stat.provider)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    autoWarmupEnabledFor(stat.provider) ? "bg-[var(--primary)]" : "bg-[var(--border)]"
                  }`}
                  aria-label={`Toggle auto warmup for ${labelProvider(stat.provider)}`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      autoWarmupEnabledFor(stat.provider) ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>

              {/* Buttons */}
              <div className="grid grid-cols-3 gap-2" onClick={(e) => e.stopPropagation()}>
                <Button className="w-full" variant="default" size="sm" onClick={() => setAddDialogProvider(stat.provider)}>
                  <Plus className="mr-1 h-4 w-4" /> Add
                </Button>
                <Button className="w-full" variant="outline" size="sm" onClick={() => handleWarmupProvider(stat.provider)}>
                  <RefreshCw className="mr-1 h-4 w-4" /> Warmup
                </Button>
                <Button className="w-full" variant="outline" size="sm" onClick={() => handleRetryErrors(stat.provider)} disabled={stat.error === 0}>
                  <RotateCcw className="mr-1 h-4 w-4" /> Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Login Pending Dialog */}
      <Dialog open={loginPendingDialog} onOpenChange={setLoginPendingDialog}>
        <DialogContent>
          <DialogHeader>
            <DTitle>Login Pending Accounts</DTitle>
            <DialogDescription>Choose how many accounts to login concurrently.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="flex items-center gap-3">
              <label className="text-sm text-[var(--muted-foreground)]">Concurrent:</label>
              <select value={loginPendingConcurrency} onChange={(e) => setLoginPendingConcurrency(Number(e.target.value))} className="h-8 w-20 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)]">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setLoginPendingDialog(false)}>Cancel</Button>
              <Button size="sm" onClick={confirmLoginAll}>
                <Play className="w-4 h-4 mr-2" /> Start Login
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Account Dialog (per-provider) */}
      <Dialog open={addDialogProvider !== null} onOpenChange={(open) => { if (!open) setAddDialogProvider(null); }}>
        <DialogContent>
          <DialogHeader>
            <DTitle>Add {addDialogProvider ? labelProvider(addDialogProvider) : ""} Account</DTitle>
            <DialogDescription>
              {addDialogProvider === "kiro-pro" || addDialogProvider === "codex" || addDialogProvider === "pioneer"
                ? "Add via browser login or instant login with API key/token."
                : addDialogProvider === "qoder"
                ? "Add via PAT, bulk Google accounts, or single account."
                : `Add account for ${addDialogProvider ? labelProvider(addDialogProvider) : "this provider"}.`}
            </DialogDescription>
          </DialogHeader>

          {/* Mode tabs */}
          {addDialogProvider === "kiro-pro" || addDialogProvider === "codex" || addDialogProvider === "pioneer" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("instant")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "instant" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Instant Login (Token)</button>
              <button onClick={() => setAddMode("bulk")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk (Email|Pass)</button>
              <button onClick={() => setAddMode("single")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Single</button>
            </div>
          ) : addDialogProvider === "qoder" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("pat")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >PAT (Token)</button>
              <button onClick={() => setAddMode("bulk")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk (Email|Pass)</button>
              <button onClick={() => setAddMode("single")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Single</button>
            </div>
          ) : addDialogProvider === "oneminai" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("apikey")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "apikey" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >API Key</button>
              <button onClick={() => setAddMode("bulk")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk (Google Login)</button>
            </div>
          ) : (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("bulk")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk (Email|Pass)</button>
              <button onClick={() => setAddMode("single")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Single</button>
            </div>
          )}

          {/* API Key mode (1minAI only) */}
          {addMode === "apikey" && addDialogProvider === "oneminai" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">1minAI API Key(s) — satu per baris</label>
                <textarea
                  value={apiKeyValue}
                  onChange={(e) => setApiKeyValue(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder={"email@example.com:1minai-api-key\natau langsung:\n1minai-api-key-tanpa-email"}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Format: <span className="font-mono">email:api_key</span> atau api_key polos. Quota saldo otomatis ke-fetch setelah ditambahkan.</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleApiKeyLogin}>Add 1minAI</Button>
              </div>
            </div>
          )}

          {/* Personal Access Token mode (Qoder only) */}
          {addMode === "pat" && addDialogProvider === "qoder" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Personal Access Token (PAT)</label>
                <textarea
                  value={cookieValue}
                  onChange={(e) => setCookieValue(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder="qd-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Paste Qoder Personal Access Token. Server akan menukar dengan jobToken otomatis dan menyimpan kredensial untuk inference.</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleCookieLogin}>Add Account</Button>
              </div>
            </div>
          )}

          {/* Instant Login mode (Kiro Pro only) */}
          {addMode === "instant" && (addDialogProvider === "kiro-pro" || addDialogProvider === "codex") && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Refresh Tokens (satu per baris)</label>
                <textarea
                  value={instantTokens}
                  onChange={(e) => setInstantTokens(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder={"eyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs..."}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Paste refresh token per baris. Email otomatis di-extract dari token.</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleInstantLogin}>Login Instant</Button>
              </div>
            </div>
          )}

          {/* Bulk mode (all providers) */}
          {addMode === "bulk" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Accounts (email|password atau email:password per baris)</label>
                <textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder={"email@example.com|password123\nanother@example.com:pass456"}
                />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Browser Engine</label>
                <select value={bulkBrowserEngine} onChange={(e) => setBulkBrowserEngine(e.target.value)} className="mt-1 w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
                  <option value="camoufox">Camoufox (Anti-detect, default)</option>
                  <option value="chromium">Chromium (Playwright)</option>
                </select>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                  <input type="checkbox" checked={bulkHeadless} onChange={(e) => setBulkHeadless(e.target.checked)} className="h-4 w-4 rounded border-[var(--border)]" />
                  Run browser headless
                </label>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-[var(--foreground)]">Concurrent:</label>
                  <select value={bulkConcurrency} onChange={(e) => setBulkConcurrency(Number(e.target.value))} className="h-8 w-16 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)]">
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={5}>5</option>
                    <option value={10}>10</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                  <input type="checkbox" checked={bulkUseProxy} onChange={(e) => setBulkUseProxy(e.target.checked)} className="h-4 w-4 rounded border-[var(--border)]" />
                  Use Proxy
                </label>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-[var(--foreground)]">Mode:</label>
                  <select value={bulkProxyMode} onChange={(e) => setBulkProxyMode(e.target.value as "round-robin" | "random")} disabled={!bulkUseProxy} className="h-8 w-28 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] disabled:opacity-50">
                    <option value="round-robin">Urut</option>
                    <option value="random">Random</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleBulkImport}>Import & Login</Button>
              </div>
            </div>
          )}

          {/* Single mode (all providers) */}
          {addMode === "single" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Email</label>
                <Input value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} placeholder="email@example.com" className="mt-1" />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Password</label>
                <Input value={addForm.password} onChange={(e) => setAddForm({ ...addForm, password: e.target.value })} type="password" placeholder="********" className="mt-1" />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Browser Engine</label>
                <select value={addForm.browserEngine} onChange={(e) => setAddForm({ ...addForm, browserEngine: e.target.value })} className="mt-1 w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
                  <option value="camoufox">Camoufox (Anti-detect, default)</option>
                  <option value="chromium">Chromium (Playwright)</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                <input type="checkbox" checked={addForm.headless} onChange={(e) => setAddForm({ ...addForm, headless: e.target.checked })} className="h-4 w-4 rounded border-[var(--border)]" />
                Run browser headless
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleAdd}>Add Account</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
