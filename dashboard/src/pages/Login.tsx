import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff, Lock, KeyRound } from "lucide-react";
import {
  loginWithPassword,
  setDashboardPassword,
  checkHasPassword,
} from "@/lib/api";

interface LoginProps {
  onLogin: () => void;
}

type Mode = "password" | "recover";

export default function Login({ onLogin }: LoginProps) {
  // null = masih cek ke server apakah password sudah diset
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>("password");

  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // recover / first-run
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    checkHasPassword()
      .then((has) => {
        setHasPassword(has);
        // Belum ada password → langsung ke mode setup (recover form).
        if (!has) setMode("recover");
      })
      .catch(() => setHasPassword(false));
  }, []);

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!password) {
      setError("Masukkan password");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const key = await loginWithPassword(password);
      localStorage.setItem("api_key", key);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleRecover(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError("Masukkan API key");
      return;
    }
    if (newPassword.length < 6) {
      setError("Password baru minimal 6 karakter");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const key = await setDashboardPassword(apiKey.trim(), newPassword);
      localStorage.setItem("api_key", key);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const isFirstRun = hasPassword === false;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--background)] p-4">
      <Card className="w-full max-w-sm border-[var(--border)]">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--primary)]/10">
            {mode === "password" ? (
              <Lock className="h-6 w-6 text-[var(--primary)]" />
            ) : (
              <KeyRound className="h-6 w-6 text-[var(--primary)]" />
            )}
          </div>
          <CardTitle className="text-xl">Pool Proxy</CardTitle>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            {mode === "password"
              ? "Masukkan password untuk masuk dashboard"
              : isFirstRun
                ? "Setup awal — masukkan API key & buat password"
                : "Reset password dengan API key kamu"}
          </p>
        </CardHeader>
        <CardContent>
          {mode === "password" ? (
            <form onSubmit={handlePasswordLogin} className="space-y-4">
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  placeholder="Password"
                  className="pr-10 text-sm"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              {error && (
                <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{error}</div>
              )}

              <Button type="submit" className="w-full" disabled={loading || hasPassword === null}>
                {loading ? "Memverifikasi..." : "Login"}
              </Button>

              <button
                type="button"
                onClick={() => {
                  setMode("recover");
                  setError(null);
                }}
                className="w-full text-center text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                Lupa password? Pakai API key
              </button>
            </form>
          ) : (
            <form onSubmit={handleRecover} className="space-y-4">
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setError(null);
                  }}
                  placeholder="sk-pool-..."
                  className="pr-10 font-mono text-sm"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              <Input
                type="password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setError(null);
                }}
                placeholder="Password baru (min. 6 karakter)"
                className="text-sm"
              />

              {error && (
                <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{error}</div>
              )}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Menyimpan..." : isFirstRun ? "Buat Password & Masuk" : "Reset Password & Masuk"}
              </Button>

              {!isFirstRun && (
                <button
                  type="button"
                  onClick={() => {
                    setMode("password");
                    setError(null);
                  }}
                  className="w-full text-center text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  Kembali ke login password
                </button>
              )}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
