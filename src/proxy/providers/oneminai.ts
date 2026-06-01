import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";

/**
 * 1MinAI provider.
 * Upstream: https://api.1min.ai  (POST /api/chat-with-ai, header `API-KEY`)
 * Quota:    x-auth-token Bearer <jwt> -> /users (teams[0].team.credit) | /user/me
 *
 * Each farmed account carries:
 *   api_key      -> API-KEY for chat (persistent, does not expire like a JWT)
 *   access_token -> x-auth-token JWT for quota reads (optional, from browser farm)
 * Port source: /root/SERVER/farming-ai/ (middleware_1minai.py + engine/adapters.py)
 */

interface OneMinAITokens {
  api_key?: string;
  // The browser farm stores the x-auth-token JWT as `jwt` (NOT `access_token`).
  jwt?: string;
  access_token?: string;
  refresh_token?: string;
  team_id?: string;
  user_id?: string;
  web_cookie?: string;
  credits_total?: number;
  credits_remaining?: number;
  plan_type?: string;
  email?: string;
}

const ONEMINAI_BASE = "https://api.1min.ai";
const CHAT_PATH = "/api/chat-with-ai";

// OpenAI-name -> 1MinAI-name (most are identity). Drives supportedModels + resolveModel.
const oneminaiModelMap: Record<string, string> = {
  // OpenAI
  "gpt-4o": "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini",
  "gpt-4-turbo": "gpt-4-turbo",
  "gpt-3.5-turbo": "gpt-3.5-turbo",
  "gpt-4.1": "gpt-4.1",
  "gpt-4.1-mini": "gpt-4.1-mini",
  "gpt-4.1-nano": "gpt-4.1-nano",
  "gpt-5": "gpt-5",
  "o1": "o1",
  "o1-mini": "o1-mini",
  "o1-pro": "o1-pro",
  "o3": "o3",
  "o3-mini": "o3-mini",
  "o3-pro": "o3-pro",
  "o4-mini": "o4-mini",
  // Claude
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-20250514": "claude-sonnet-4-20250514",
  "claude-opus-4-20250514": "claude-opus-4-20250514",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  // Gemini
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-2.5-flash": "gemini-2.5-flash",
  "gemini-3-flash-preview": "gemini-3-flash-preview",
  "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
  // DeepSeek
  "deepseek-chat": "deepseek-chat",
  "deepseek-reasoner": "deepseek-reasoner",
  // Grok
  "grok-3": "grok-3",
  "grok-3-mini": "grok-3-mini",
  "grok-4-0709": "grok-4-0709",
  // Mistral
  "mistral-large-latest": "mistral-large-latest",
  "mistral-small-latest": "mistral-small-latest",
  // Perplexity
  "sonar": "sonar",
  "sonar-pro": "sonar-pro",
  "sonar-reasoning-pro": "sonar-reasoning-pro",
  // Qwen
  "qwen-max": "qwen-max",
  "qwen-plus": "qwen-plus",
};

const VISION_HINT = /^(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|claude-|gemini-)/i;

export class OneMinAIProvider extends BaseProvider {
  name = "oneminai";

  supportedModels: ModelInfo[] = Object.keys(oneminaiModelMap).map((id) => ({
    id: `1m-${id}`,
    object: "model" as const,
    created: Date.now(),
    owned_by: "oneminai",
    tier: "standard" as const,
    context_window: 128000,
    max_output: 16000,
    thinking: /reasoner|o1|o3|sonar-reasoning|thinking/i.test(id),
    vision: VISION_HINT.test(id),
    creditUnit: "credit" as const,
    creditRate: 1 / 1000,
    creditSource: "upstream" as const,
  }));

  private getTokens(account: Account): OneMinAITokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as OneMinAITokens;
    } catch {
      return null;
    }
  }

  private resolveModel(model: string): string {
    // Public ids are prefixed with `1m-` to avoid collision with kiro/codex/codebuddy.
    const stripped = model.toLowerCase().replace(/^1m-/, "");
    return oneminaiModelMap[stripped] || stripped;
  }

  /** Flatten the OpenAI conversation into a single 1MinAI prompt string. */
  private buildPrompt(request: ChatCompletionRequest): string {
    const lines: string[] = [];
    let system = "";
    for (const msg of request.messages) {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as any[]).map((b) => {
              if (typeof b === "string") return b;
              if (b?.type === "text" || b?.type === "input_text") return b.text || "";
              return "";
            }).filter(Boolean).join("\n")
          : "";
      if (!text) continue;
      const role = msg.role as string;
      if (role === "system") { system += (system ? "\n" : "") + text; continue; }
      if (role === "assistant") lines.push(`Assistant: ${text}`);
      else lines.push(`User: ${text}`);
    }
    let prompt = lines.join("\n\n");
    if (system) prompt = `[System: ${system}]\n\n${prompt}`;
    return prompt;
  }

  private buildPayload(request: ChatCompletionRequest): Record<string, unknown> {
    return {
      type: "UNIFY_CHAT_WITH_AI",
      model: this.resolveModel(request.model),
      promptObject: {
        prompt: this.buildPrompt(request),
        settings: { historySettings: { isMixed: false, historyMessageLimit: 10 } },
      },
    };
  }

  private async makeRequest(
    account: Account,
    request: ChatCompletionRequest,
    streaming: boolean,
  ): Promise<Response> {
    const tokens = this.getTokens(account);
    if (!tokens?.api_key) throw new Error("expired: no api_key");

    const url = `${ONEMINAI_BASE}${CHAT_PATH}${streaming ? "?isStreaming=true" : ""}`;
    return this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "API-KEY": tokens.api_key,
        "Content-Type": "application/json",
        ...(streaming ? { Accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify(this.buildPayload(request)),
    });
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const response = await this.makeRequest(account, request, false);
      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", quotaExhausted: true };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        // 1MinAI signals insufficient credit with 402/403 or message text
        const exhausted = response.status === 402 || /credit|insufficient|quota/i.test(text);
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}`, quotaExhausted: exhausted };
      }

      const data = await response.json().catch(() => null) as any;
      const { text, usage } = this.parseResult(data);

      const promptTokens = usage.prompt || this.estimateMessagesTokens(request.messages);
      const completionTokens = usage.completion || this.estimateTokens(text);

      const resp: ChatCompletionResponse = {
        id: this.generateId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      };

      return { success: true, response: resp, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Extract assistant text + token usage from a 1MinAI response body. */
  private parseResult(data: any): { text: string; usage: { prompt: number; completion: number } } {
    if (!data) return { text: "", usage: { prompt: 0, completion: 0 } };
    const aiRecord = data.aiRecord || {};
    const detail = aiRecord.aiRecordDetail || {};
    let result = "";
    const ro = detail.resultObject;
    if (Array.isArray(ro)) result = ro.join("");
    else if (ro) result = String(ro);
    if (!result) result = aiRecord.result || data.result || "";
    const meta = aiRecord.metadata || {};
    return {
      text: result,
      usage: { prompt: Number(meta.inputToken) || 0, completion: Number(meta.outputToken) || 0 },
    };
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const response = await this.makeRequest(account, request, true);
      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", quotaExhausted: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        const exhausted = response.status === 402 || /credit|insufficient|quota/i.test(text);
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}`, quotaExhausted: exhausted };
      }

      const id = this.generateId();
      const model = request.model;
      const encoder = new TextEncoder();
      const upstream = response.body;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let started = false;

          const emit = (delta: any, finish_reason: string | null = null) => {
            const chunk = {
              id, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta, finish_reason }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          };

          const pushContent = (content: string) => {
            if (!content) return;
            if (!started) { started = true; emit({ role: "assistant", content: "" }); }
            emit({ content });
          };

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });

              let nl;
              while ((nl = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;

                if (line.startsWith("data: ") || line.startsWith("data:")) {
                  const dataStr = line.replace(/^data:\s?/, "");
                  if (dataStr === "[DONE]") continue;
                  try {
                    const obj = JSON.parse(dataStr);
                    pushContent(obj.content ?? obj.text ?? "");
                  } catch {
                    if (dataStr) pushContent(dataStr);
                  }
                } else if (
                  line.startsWith("event:") ||
                  line.startsWith("id:") ||
                  line.startsWith("retry:") ||
                  line.startsWith(":")
                ) {
                  // SSE metadata/comment line (1MinAI sends `event: content`) -> ignore
                  continue;
                } else {
                  // raw non-SSE line = treat as content
                  pushContent(line);
                }
              }
            }
            if (!started) emit({ role: "assistant", content: "" });
            emit({}, "stop");
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            try { controller.error(err); } catch { /* already errored */ }
          }
        },
      });

      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    // 1MinAI chat auth uses a persistent API-KEY (not a short-lived JWT), so there is
    // nothing to refresh for the chat path. Optionally refresh the x-auth-token JWT.
    const tokens = this.getTokens(account);
    if (!tokens?.refresh_token) {
      // No JWT refresh available; api_key is still valid -> report success, keep tokens.
      return tokens?.api_key
        ? { success: true, tokens: JSON.stringify(tokens) }
        : { success: false, error: "No api_key or refresh_token" };
    }
    try {
      const resp = await this.fetchWithTimeout(`${ONEMINAI_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokens.refresh_token }),
      }, 15000);
      if (!resp.ok) return { success: true, tokens: JSON.stringify(tokens) }; // keep api_key
      const data = await resp.json() as any;
      const td = data.data || data;
      return {
        success: true,
        tokens: JSON.stringify({
          ...tokens,
          access_token: td.token || tokens.access_token,
          refresh_token: td.refreshToken || tokens.refresh_token,
        }),
      };
    } catch {
      return { success: true, tokens: JSON.stringify(tokens) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!tokens?.api_key;
  }

  async fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.api_key) return { success: false, error: "No api_key" };

    // Preferred: live read via x-auth-token JWT -> team.credit is the REAL balance.
    // The farm stores it as `jwt`; older records may use `access_token`.
    const jwt = tokens.jwt || tokens.access_token;
    if (jwt) {
      const live = await this.fetchLiveQuota(jwt);
      if (live) return { success: true, quota: live };
    }

    // Fallback: stored credit from last farm (so the account stays usable without a JWT).
    if (typeof tokens.credits_remaining === "number") {
      const total = tokens.credits_total ?? tokens.credits_remaining;
      return {
        success: true,
        quota: { limit: total, remaining: tokens.credits_remaining, used: Math.max(0, total - tokens.credits_remaining), resetAt: null },
      };
    }

    // api_key-only path: 1MinAI's chat response only embeds `creditLimit`/`usedCredit`
    // (the FREE-plan cap, NOT the real balance). `creditLimit - usedCredit` would show
    // a bogus ~100M figure, so we DO NOT use it as a balance. The account is still fully
    // usable for chat (api_key works); the dashboard just can't show a live balance until
    // a JWT is refreshed (via the daily auto-claim re-login). Report unsupported so the
    // warmup layer keeps the account healthy without overwriting quota with a fake number.
    return { success: false, error: "not supported: live balance needs a JWT (api_key only)" };
  }

  private async fetchLiveQuota(accessToken: string): Promise<{ limit: number; remaining: number; used: number; resetAt: null } | null> {
    const headers = { "x-auth-token": `Bearer ${accessToken}` };
    // 1) /users -> user.teams[0].team.credit is the REAL remaining balance.
    //    `creditLimit` is the FREE-plan cap (~100M) and `usedCredit` sits on the
    //    team wrapper, NOT inside `team`. Verified live against the API 2026-05-31.
    try {
      const r = await this.fetchWithTimeout(`${ONEMINAI_BASE}/users`, { method: "GET", headers }, config.providerQuotaTimeoutMs);
      if (r.ok) {
        const d = await r.json() as any;
        const tw = d?.user?.teams?.[0];           // team wrapper
        const team = tw?.team;
        if (team && typeof team.credit === "number") {
          const remaining = Number(team.credit);
          const used = Number(tw.usedCredit ?? team.usedCredit ?? 0);
          // limit = real spendable ceiling for this cycle = remaining + used.
          return { limit: remaining + used, remaining, used, resetAt: null };
        }
      }
    } catch { /* try next */ }
    // 2) /user/me -> credits / creditsUsed (legacy shape)
    try {
      const r = await this.fetchWithTimeout(`${ONEMINAI_BASE}/user/me`, { method: "GET", headers }, config.providerQuotaTimeoutMs);
      if (r.ok) {
        const d = await r.json() as any;
        const u = d?.data || d;
        const credits = Number(u?.credits ?? 0);
        const used = Number(u?.creditsUsed ?? 0);
        if (credits || used) return { limit: credits, remaining: Math.max(0, credits - used), used, resetAt: null };
      }
    } catch { /* fall through */ }
    return null;
  }

  /**
   * Daily free-credit check-in (pure HTTP — no browser needed, since the
   * x-auth-token JWT is valid for 7 days). 1MinAI grants the daily reward
   * server-side when the account "reads" its unread notifications, exactly
   * like the official web app does. Mechanism reverse-engineered from
   * github.com/7a6163/1min-checkin:
   *   1) GET /teams/{teamId}/credits      -> balance BEFORE
   *   2) GET /notifications/unread        -> triggers the daily reward
   *   3) GET /teams/{teamId}/credits      -> balance AFTER (reward settled)
   * Returns the delta + fresh balance so the caller can log it and persist
   * the live quota. Needs a JWT; api_key-only accounts must be re-logged in
   * first (the JWT also fixes their stale quota display as a side effect).
   */
  async dailyCheckin(account: Account): Promise<{
    success: boolean;
    reward: number;
    balance: number | null;
    teamId?: string;
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    const jwt = tokens?.jwt || tokens?.access_token;
    if (!jwt) {
      return { success: false, reward: 0, balance: null, error: "no JWT (re-login required for check-in)" };
    }

    // Resolve teamId: prefer the stored one, else look it up via /users.
    let teamId = tokens?.team_id || "";
    const headers: Record<string, string> = {
      "x-auth-token": `Bearer ${jwt}`,
      "Content-Type": "application/json",
      Origin: "https://app.1min.ai",
      Referer: "https://app.1min.ai/",
    };

    try {
      if (!teamId) {
        const ur = await this.fetchWithTimeout(`${ONEMINAI_BASE}/users`, { method: "GET", headers }, config.providerQuotaTimeoutMs);
        if (ur.ok) {
          const ud = await ur.json() as any;
          teamId = ud?.user?.teams?.[0]?.teamId || ud?.user?.teams?.[0]?.team?.uuid || "";
        }
      }
      if (!teamId) {
        return { success: false, reward: 0, balance: null, error: "could not resolve teamId (JWT may be expired)" };
      }

      const creditsUrl = `${ONEMINAI_BASE}/teams/${teamId}/credits`;
      const readCredit = async (): Promise<number | null> => {
        const r = await this.fetchWithTimeout(creditsUrl, { method: "GET", headers }, config.providerQuotaTimeoutMs);
        if (!r.ok) return null;
        const d = await r.json() as any;
        return typeof d?.credit === "number" ? d.credit : null;
      };

      const before = await readCredit();
      if (before === null) {
        // A failed read here almost always means the JWT expired (>7 days).
        return { success: false, reward: 0, balance: null, teamId, error: "credits read failed (JWT likely expired)" };
      }

      // Trigger the daily reward by reading unread notifications.
      try {
        await this.fetchWithTimeout(`${ONEMINAI_BASE}/notifications/unread`, { method: "GET", headers }, config.providerQuotaTimeoutMs);
      } catch { /* non-fatal — reward may already be claimed */ }

      // Let the reward settle, then re-read.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const after = await readCredit();
      const balance = after ?? before;
      const reward = Math.max(0, balance - before);

      return { success: true, reward, balance, teamId };
    } catch (e) {
      return { success: false, reward: 0, balance: null, teamId, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
