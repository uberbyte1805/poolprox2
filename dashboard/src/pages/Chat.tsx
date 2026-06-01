import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  MessageSquare,
  Send,
  Loader2,
  Bot,
  User as UserIcon,
  Trash2,
  ChevronDown,
  Square,
  Sliders,
} from "lucide-react";
import {
  fetchModels,
  chatCompletion,
  type ChatCompletionMessage,
  type ModelInfo,
} from "@/lib/api";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  model?: string;
  tokens?: number;
  ms?: number;
}

const DEFAULT_MODEL = "1m-gpt-4o-mini";

// Best-effort provider grouping from a model id, mirroring pool.ts getProviderForModel.
function providerOf(id: string): string {
  if (id.startsWith("1m-")) return "1minAI";
  if (id.startsWith("ws-")) return "Windsurf";
  if (id.startsWith("zai-")) return "Z.ai";
  if (id.includes("canva")) return "Canva";
  if (id.startsWith("pio-")) return "Pioneer";
  if (id.startsWith("qd-")) return "Qoder";
  if (id.startsWith("kp-")) return "Kiro Pro";
  if (id.startsWith("cb-")) return "CodeBuddy";
  if (id.startsWith("codex-") || id === "gpt-5-codex") return "Codex";
  if (id.startsWith("gpt-5") || id.startsWith("gemini-") || id.startsWith("kimi-")) return "CodeBuddy";
  if (id === "auto") return "Kiro";
  if (id.startsWith("claude-") || id.startsWith("deepseek") || id.startsWith("glm") || id.startsWith("minimax") || id.startsWith("qwen")) return "Kiro";
  return "Other";
}

export default function Chat() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxTokens, setMaxTokens] = useState<number>(1024);
  const [showSettings, setShowSettings] = useState(false);

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetchModels()
      .then((res: any) => {
        const data: ModelInfo[] = res?.data || [];
        setModels(data);
        if (!data.find((m) => m.id === DEFAULT_MODEL) && data[0]) {
          setModel(data[0].id);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, thinking]);

  const groupedModels = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const p = providerOf(m.id);
      const list = map.get(p) || [];
      list.push(m);
      map.set(p, list);
    }
    // 1minAI first (this is the internal test target), then alphabetical.
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === "1minAI") return -1;
      if (b[0] === "1minAI") return 1;
      return a[0].localeCompare(b[0]);
    });
  }, [models]);

  async function send() {
    const trimmed = input.trim();
    if (!trimmed || thinking) return;

    const history: ChatTurn[] = [...turns, { role: "user", content: trimmed }];
    setTurns(history);
    setInput("");
    setError(null);
    setThinking(true);

    const payload: ChatCompletionMessage[] = history.map((t) => ({
      role: t.role,
      content: t.content,
    }));

    const controller = new AbortController();
    abortRef.current = controller;
    const started = Date.now();

    try {
      const res = await chatCompletion(
        { model, messages: payload, temperature, maxTokens },
        { signal: controller.signal },
      );
      setTurns([
        ...history,
        {
          role: "assistant",
          content: res.content,
          model: res.model,
          tokens: res.usage?.total_tokens,
          ms: Date.now() - started,
        },
      ]);
    } catch (err) {
      if (controller.signal.aborted) {
        setError("Dibatalkan.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setTurns(history);
    } finally {
      setThinking(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function reset() {
    if (thinking) return;
    setTurns([]);
    setInput("");
    setError(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const totalTokens = turns.reduce((sum, t) => sum + (t.tokens || 0), 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Page Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500/20 via-violet-500/15 to-emerald-500/20 ring-1 ring-inset ring-[var(--border)]">
            <MessageSquare className="h-5 w-5 text-[var(--primary)]" />
            <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-[var(--background)]" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-[var(--foreground)]">
              Chat Playground
            </h1>
            <p className="text-xs text-[var(--muted-foreground)]">
              Internal test untuk endpoint chat pool (OpenAI-compatible)
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {totalTokens > 0 && (
            <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5">
              <Bot className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
              <span className="text-[var(--muted-foreground)]">
                <span className="font-medium text-[var(--foreground)]">{totalTokens}</span> tokens
              </span>
            </div>
          )}
          <Button
            variant="outline"
            onClick={reset}
            disabled={thinking || turns.length === 0}
            className="h-8 gap-1.5 px-2.5 text-xs"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Reset
          </Button>
        </div>
      </div>

      {/* Settings strip */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-1.5">
        <Bot className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
        <div className="relative">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="h-7 max-w-[220px] appearance-none truncate rounded border border-[var(--border)] bg-[var(--background)] pl-2 pr-6 text-[11px] text-[var(--foreground)] focus:border-[var(--primary)]/50 focus:outline-none"
            title="Model"
          >
            {groupedModels.map(([provider, list]) => (
              <optgroup key={provider} label={provider}>
                {list.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--muted-foreground)]" />
        </div>

        <div className="h-5 w-px bg-[var(--border)]" />

        <button
          type="button"
          onClick={() => setShowSettings((v) => !v)}
          className={`flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition-colors ${
            showSettings
              ? "border-[var(--primary)]/50 text-[var(--foreground)]"
              : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          }`}
          title="Parameter"
        >
          <Sliders className="h-3 w-3" /> Params
        </button>

        {showSettings && (
          <>
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
              temp
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
                className="h-7 w-14 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 text-[11px] text-[var(--foreground)] focus:border-[var(--primary)]/50 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
              max_tokens
              <input
                type="number"
                min={1}
                max={32000}
                step={64}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                className="h-7 w-20 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 text-[11px] text-[var(--foreground)] focus:border-[var(--primary)]/50 focus:outline-none"
              />
            </label>
          </>
        )}
      </div>

      {/* Conversation */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] p-4"
      >
        {turns.length === 0 && !thinking && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <MessageSquare className="h-8 w-8 text-[var(--muted-foreground)]/40" />
            <p className="text-sm text-[var(--muted-foreground)]">
              Mulai chat untuk nge-test model dari pool.
            </p>
            <p className="text-xs text-[var(--muted-foreground)]/60">
              Model aktif: <span className="font-mono">{model}</span>
            </p>
          </div>
        )}

        {turns.map((t, i) => (
          <div key={i} className={`flex gap-3 ${t.role === "user" ? "justify-end" : "justify-start"}`}>
            {t.role === "assistant" && (
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--primary)]/10 ring-1 ring-inset ring-[var(--border)]">
                <Bot className="h-4 w-4 text-[var(--primary)]" />
              </div>
            )}
            <div className={`max-w-[80%] ${t.role === "user" ? "order-1" : ""}`}>
              <div
                className={`whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
                  t.role === "user"
                    ? "bg-[var(--primary)] text-white"
                    : "border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
                }`}
              >
                {t.content}
              </div>
              {t.role === "assistant" && (t.model || t.tokens || t.ms) && (
                <div className="mt-1 flex flex-wrap gap-2 px-1 text-[10px] text-[var(--muted-foreground)]">
                  {t.model && <span className="font-mono">{t.model}</span>}
                  {typeof t.tokens === "number" && <span>{t.tokens} tok</span>}
                  {typeof t.ms === "number" && <span>{(t.ms / 1000).toFixed(1)}s</span>}
                </div>
              )}
            </div>
            {t.role === "user" && (
              <div className="order-2 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--secondary)] ring-1 ring-inset ring-[var(--border)]">
                <UserIcon className="h-4 w-4 text-[var(--muted-foreground)]" />
              </div>
            )}
          </div>
        ))}

        {thinking && (
          <div className="flex gap-3">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--primary)]/10 ring-1 ring-inset ring-[var(--border)]">
              <Bot className="h-4 w-4 text-[var(--primary)]" />
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--muted-foreground)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Mikir...
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Composer */}
      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ketik pesan... (Enter kirim, Shift+Enter baris baru)"
          rows={2}
          className="min-h-[44px] flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)]/50 focus:outline-none"
        />
        {thinking ? (
          <Button onClick={stop} variant="outline" className="h-11 gap-1.5 px-4">
            <Square className="h-4 w-4" />
            Stop
          </Button>
        ) : (
          <Button onClick={send} disabled={!input.trim()} className="h-11 gap-1.5 px-4">
            <Send className="h-4 w-4" />
            Kirim
          </Button>
        )}
      </div>
    </div>
  );
}
