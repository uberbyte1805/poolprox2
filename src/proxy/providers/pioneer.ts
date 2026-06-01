import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";

interface PioneerTokens {
  api_key: string;
  access_token?: string;
  refresh_token?: string;
  user_id?: string;
  email?: string;
  plan?: string;
  supabase_anon_key?: string;
}

const PIONEER_API_BASE = "https://api.pioneer.ai";
const PIONEER_CHAT_URL = `${PIONEER_API_BASE}/v1/chat/completions`;
const PIONEER_MODELS_URL = `${PIONEER_API_BASE}/v1/models`;
const PIONEER_BILLING_URL = `${PIONEER_API_BASE}/billing/billing-status`;
const PIONEER_USER_URL = `${PIONEER_API_BASE}/users/me`;
const SUPABASE_TOKEN_URL = "https://db.pioneer.ai/auth/v1/token?grant_type=refresh_token";
const SUPABASE_ANON_KEY = process.env.PIONEER_SUPABASE_ANON_KEY || "sb_publishable_AtlDtPFv9cqxkWcH1b7A1g_J3OZbosp";

export class PioneerProvider extends BaseProvider {
  name = "pioneer";

  // Maps pio-* alias → upstream Pioneer model id (some upstream ids contain "/").
  private static readonly MODEL_MAP: Record<string, string> = {
    // Claude family — best for nuanced coding and long-context reasoning
    "pio-claude-opus-4-7": "claude-opus-4-7",
    "pio-claude-sonnet-4-6": "claude-sonnet-4-6",
    "pio-claude-haiku-4-5": "claude-haiku-4-5",
    // GPT-5 family — strong coding + agentic tool use
    "pio-gpt-5-5": "gpt-5.5",
    "pio-gpt-5-4": "gpt-5.4",
    "pio-gpt-5-4-mini": "gpt-5.4-mini",
    "pio-gpt-5-1": "gpt-5.1",
    "pio-gpt-5-mini": "gpt-5-mini",
    // GPT-4.1 — solid coding + function calling
    "pio-gpt-4-1": "gpt-4.1",
    "pio-gpt-4-1-mini": "gpt-4.1-mini",
    "pio-gpt-4o": "gpt-4o",
    // DeepSeek — open-weight coding/reasoning
    "pio-deepseek-v4-pro": "deepseek-ai/DeepSeek-V4-Pro",
    "pio-deepseek-v4-flash": "deepseek-ai/DeepSeek-V4-Flash",
    "pio-deepseek-v3-1": "deepseek-ai/DeepSeek-V3.1",
    // Other strong open coding models
    "pio-kimi-k2-6": "moonshotai/Kimi-K2.6",
    "pio-qwen3-235b": "Qwen/Qwen3-235B-A22B-Instruct-2507",
    "pio-qwen3-32b": "Qwen/Qwen3-32B",
    "pio-llama-3-3-70b": "meta-llama/Llama-3.3-70B-Instruct",
    "pio-glm-5-1": "zai-org/GLM-5.1",
    "pio-gpt-oss-120b": "openai/gpt-oss-120b",
  };

  supportedModels: ModelInfo[] = [
    { id: "pio-claude-opus-4-7",     object: "model", created: Date.now(), owned_by: "pioneer", tier: "max",      context_window: 1000000, max_output: 64000, thinking: true,  vision: true,  creditUnit: "credit", creditRate: 0.025 / 1000, creditSource: "estimated" },
    { id: "pio-claude-sonnet-4-6",   object: "model", created: Date.now(), owned_by: "pioneer", tier: "max",      context_window: 1000000, max_output: 64000, thinking: true,  vision: true,  creditUnit: "credit", creditRate: 0.015 / 1000, creditSource: "estimated" },
    { id: "pio-claude-haiku-4-5",    object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 200000,  max_output: 16000, thinking: false, vision: true,  creditUnit: "credit", creditRate: 0.005 / 1000, creditSource: "estimated" },
    { id: "pio-gpt-5-5",             object: "model", created: Date.now(), owned_by: "pioneer", tier: "max",      context_window: 400000,  max_output: 64000, thinking: true,  vision: true,  creditUnit: "credit", creditRate: 0.030 / 1000, creditSource: "estimated" },
    { id: "pio-gpt-5-4",             object: "model", created: Date.now(), owned_by: "pioneer", tier: "max",      context_window: 1047576, max_output: 64000, thinking: true,  vision: true,  creditUnit: "credit", creditRate: 0.015 / 1000, creditSource: "estimated" },
    { id: "pio-gpt-5-4-mini",        object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 400000,  max_output: 32000, thinking: true,  vision: true,  creditUnit: "credit", creditRate: 0.0045 / 1000, creditSource: "estimated" },
    { id: "pio-gpt-5-1",             object: "model", created: Date.now(), owned_by: "pioneer", tier: "max",      context_window: 400000,  max_output: 64000, thinking: true,  vision: true,  creditUnit: "credit", creditRate: 0.010 / 1000, creditSource: "estimated" },
    { id: "pio-gpt-5-mini",          object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 400000,  max_output: 32000, thinking: false, vision: true,  creditUnit: "credit", creditRate: 0.002 / 1000, creditSource: "estimated" },
    { id: "pio-gpt-4-1",             object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 1047576, max_output: 32000, thinking: false, vision: true,  creditUnit: "credit", creditRate: 0.008 / 1000, creditSource: "estimated" },
    { id: "pio-gpt-4-1-mini",        object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 1047576, max_output: 32000, thinking: false, vision: true,  creditUnit: "credit", creditRate: 0.0016 / 1000, creditSource: "estimated" },
    { id: "pio-gpt-4o",              object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 128000,  max_output: 16000, thinking: false, vision: true,  creditUnit: "credit", creditRate: 0.010 / 1000, creditSource: "estimated" },
    { id: "pio-deepseek-v4-pro",     object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 1000000, max_output: 32000, thinking: true,  vision: false, creditUnit: "credit", creditRate: 0.0034 / 1000, creditSource: "estimated" },
    { id: "pio-deepseek-v4-flash",   object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 1000000, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.00028 / 1000, creditSource: "estimated" },
    { id: "pio-deepseek-v3-1",       object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 163840,  max_output: 16000, thinking: true,  vision: false, creditUnit: "credit", creditRate: 0.00168 / 1000, creditSource: "estimated" },
    { id: "pio-kimi-k2-6",           object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 256000,  max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.004 / 1000, creditSource: "estimated" },
    { id: "pio-qwen3-235b",          object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 262144,  max_output: 32000, thinking: true,  vision: false, creditUnit: "credit", creditRate: 0.0012 / 1000, creditSource: "estimated" },
    { id: "pio-qwen3-32b",           object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 40960,   max_output: 16000, thinking: true,  vision: false, creditUnit: "credit", creditRate: 0.0009 / 1000, creditSource: "estimated" },
    { id: "pio-llama-3-3-70b",       object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 131072,  max_output: 16000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.0009 / 1000, creditSource: "estimated" },
    { id: "pio-glm-5-1",             object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 202752,  max_output: 16000, thinking: true,  vision: false, creditUnit: "credit", creditRate: 0.0035 / 1000, creditSource: "estimated" },
    { id: "pio-gpt-oss-120b",        object: "model", created: Date.now(), owned_by: "pioneer", tier: "standard", context_window: 131072,  max_output: 16000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.0006 / 1000, creditSource: "estimated" },
  ];

  private getTokens(account: Account): PioneerTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as PioneerTokens;
    } catch { return null; }
  }

  private resolveModel(model: string): string {
    const m = model.toLowerCase();
    if (PioneerProvider.MODEL_MAP[m]) return PioneerProvider.MODEL_MAP[m]!;
    if (m.startsWith("pio-")) return model.slice(4);
    return model;
  }

  private getHeaders(tokens: PioneerTokens): Record<string, string> {
    return {
      "Authorization": `Bearer ${tokens.api_key}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Pioneer's upstream returns tool IDs in non-standard formats like
   * `tooluse_xxx` or `toolu_bdrk_xxx`. Some clients (e.g. the assistant)
   * validate that tool IDs match the Anthropic-standard `toolu_[a-zA-Z0-9_]+` shape,
   * so normalize anything that doesn't already match.
   */
  private normalizeToolId(id: string | undefined | null): string {
    if (!id) return `toolu_${Math.random().toString(36).slice(2, 14)}`;
    if (/^call_[A-Za-z0-9_]+$/.test(id)) return id;
    // Strip known non-standard prefixes: toolu_bdrk_, tooluse_, etc.
    const stripped = id
      .replace(/^toolu_bdrk_/, "toolu_")
      .replace(/^tooluse_/i, "toolu_");
    if (/^toolu_[A-Za-z0-9]+$/.test(stripped)) return stripped;
    const cleaned = id.replace(/^tool(use|u|u_bdrk)_+/i, "").replace(/[^A-Za-z0-9]/g, "");
    return `toolu_${cleaned || Math.random().toString(36).slice(2, 14)}`;
  }

  private normalizeChoiceToolIds(choice: any): any {
    if (!choice?.message?.tool_calls) return choice;
    return {
      ...choice,
      message: {
        ...choice.message,
        tool_calls: choice.message.tool_calls.map((tc: any) => ({
          ...tc,
          id: this.normalizeToolId(tc.id),
        })),
      },
    };
  }

  private buildBody(request: ChatCompletionRequest, stream: boolean) {
    return {
      model: this.resolveModel(request.model),
      messages: this.normalizeMessages(request.messages),
      stream,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.max_tokens !== undefined && { max_tokens: request.max_tokens }),
      ...(request.top_p !== undefined && { top_p: request.top_p }),
      ...(request.tools && request.tools.length > 0 && { tools: request.tools }),
      ...(request.tool_choice !== undefined && { tool_choice: request.tool_choice }),
    };
  }

  private normalizeMessages(messages: ChatCompletionRequest["messages"]): any[] {
    const out: any[] = [];

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) {
        out.push(msg);
        continue;
      }

      const blocks = msg.content as any[];
      if (blocks.length === 0) {
        out.push({ ...msg, content: "" });
        continue;
      }

      if (msg.role === "assistant") {
        const textParts: string[] = [];
        const toolCalls: any[] = [];
        for (const block of blocks) {
          if (block?.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block?.type === "tool_use" && block.name) {
            toolCalls.push({
              id: block.id || `toolu_${Math.random().toString(36).slice(2, 14)}`,
              type: "function",
              function: {
                name: block.name,
                arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
              },
            });
          }
        }
        const assistantMsg: any = { role: "assistant", content: textParts.join("\n") || "" };
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        out.push(assistantMsg);
        continue;
      }

      if (msg.role === "user") {
        const textParts: string[] = [];
        const imageParts: any[] = [];
        const toolResults: any[] = [];

        for (const block of blocks) {
          if (block?.type === "tool_result" && block.tool_use_id) {
            let content: string;
            if (typeof block.content === "string") {
              content = block.content;
            } else if (Array.isArray(block.content)) {
              content = (block.content as any[])
                .map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
                .filter(Boolean)
                .join("\n");
            } else if (block.content != null) {
              content = JSON.stringify(block.content);
            } else {
              content = "";
            }
            toolResults.push({ role: "tool", tool_call_id: block.tool_use_id, content });
          } else if (block?.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block?.type === "image_url" || block?.type === "image") {
            imageParts.push(block);
          }
        }

        if (textParts.length > 0 || imageParts.length > 0) {
          if (imageParts.length > 0) {
            const parts: any[] = [];
            if (textParts.length > 0) parts.push({ type: "text", text: textParts.join("\n") });
            parts.push(...imageParts);
            out.push({ role: "user", content: parts });
          } else {
            out.push({ role: "user", content: textParts.join("\n") });
          }
        }

        for (const tr of toolResults) out.push(tr);
        continue;
      }

      out.push(msg);
    }

    return out;
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.api_key) return { success: false, error: "expired: no api_key" };

    try {
      const response = await this.fetchWithTimeout(PIONEER_CHAT_URL, {
        method: "POST",
        headers: this.getHeaders(tokens),
        body: JSON.stringify(this.buildBody(request, false)),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", quotaExhausted: true };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = await response.json() as ChatCompletionResponse;
      const promptTokens = data.usage?.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = data.usage?.completion_tokens || this.estimateTokens(String(data.choices?.[0]?.message?.content || ""));

      const normalizedChoices = (data.choices || []).map((c) => this.normalizeChoiceToolIds(c));

      const resp: ChatCompletionResponse = {
        id: data.id || this.generateId(),
        object: "chat.completion",
        created: data.created || Math.floor(Date.now() / 1000),
        model: request.model,
        choices: normalizedChoices.length > 0 ? normalizedChoices : [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      };

      return { success: true, response: resp, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.api_key) return { success: false, error: "expired: no api_key" };

    try {
      const response = await this.fetchWithTimeout(PIONEER_CHAT_URL, {
        method: "POST",
        headers: this.getHeaders(tokens),
        body: JSON.stringify(this.buildBody(request, true)),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", quotaExhausted: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const id = this.generateId();
      const model = request.model;
      const encoder = new TextEncoder();
      const upstream = response.body;
      const normalizeToolId = (rawId: string | undefined | null) => this.normalizeToolId(rawId);

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let started = false;

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });

              let idx;
              while ((idx = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);

                if (!line || !line.startsWith("data: ")) continue;
                const dataStr = line.slice(6);
                if (dataStr === "[DONE]") {
                  if (!started) {
                    const chunk = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                  const stopChunk = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                  return;
                }

                try {
                  const obj = JSON.parse(dataStr);
                  const delta = obj.choices?.[0]?.delta;
                  const finishReason = obj.choices?.[0]?.finish_reason;

                  if (delta) {
                    if (!started && (delta.role || delta.content || delta.tool_calls)) {
                      started = true;
                    }
                    if (Array.isArray(delta.tool_calls)) {
                      delta.tool_calls = delta.tool_calls.map((tc: any) =>
                        tc?.id ? { ...tc, id: normalizeToolId(tc.id) } : tc,
                      );
                    }
                    const chunk = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason || null }] };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

                    if (finishReason) {
                      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                      controller.close();
                      return;
                    }
                  }
                } catch { /* skip malformed */ }
              }
            }

            if (!started) {
              const chunk = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }] };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
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

  private async refreshSupabaseToken(refreshToken: string, perAccountAnonKey?: string): Promise<{ access_token: string; refresh_token: string } | null> {
    if (!refreshToken) return null;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const apikey = perAccountAnonKey || SUPABASE_ANON_KEY;
      if (apikey) headers["apikey"] = apikey;
      const response = await this.fetchWithTimeout(SUPABASE_TOKEN_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ refresh_token: refreshToken }),
      }, 15000);
      if (!response.ok) return null;
      const data = await response.json() as any;
      if (!data?.access_token || !data?.refresh_token) return null;
      return { access_token: data.access_token, refresh_token: data.refresh_token };
    } catch {
      return null;
    }
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "No tokens" };

    if (tokens.refresh_token) {
      const refreshed = await this.refreshSupabaseToken(tokens.refresh_token, tokens.supabase_anon_key);
      if (refreshed) {
        const merged: PioneerTokens = {
          ...tokens,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
        };
        return { success: true, tokens: JSON.stringify(merged) };
      }
    }

    if (tokens.api_key) {
      return { success: true, tokens: JSON.stringify(tokens) };
    }

    return { success: false, error: "Supabase refresh failed and no api_key available" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!tokens?.api_key;
  }

  async fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) return { success: true, quota: { limit: 20000, remaining: 20000, used: 0 } };

    try {
      const response = await this.fetchWithTimeout(PIONEER_BILLING_URL, {
        method: "GET",
        headers: { "Authorization": `Bearer ${tokens.access_token}` },
      }, config.providerQuotaTimeoutMs);

      if (!response.ok) {
        return { success: true, quota: { limit: 20000, remaining: 20000, used: 0 } };
      }

      const data = await response.json() as any;
      const limit = Number(data.credit_limit || 20000);
      const used = Number(data.total_usage || 0);
      const remaining = Number(data.free_tier_remaining ?? Math.max(0, limit - used));

      return {
        success: true,
        quota: { limit, remaining, used },
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  override async healthCheck(account: Account) {
    const valid = await this.validateAccount(account);
    if (!valid) {
      return { kind: "missing_tokens" as const, success: false, error: "No valid tokens available" };
    }

    const tokens = this.getTokens(account);
    if (!tokens?.api_key) {
      return { kind: "missing_tokens" as const, success: false, error: "No api_key" };
    }

    if (!tokens.access_token) {
      const quotaResult = await this.fetchQuota(account);
      const quota = quotaResult.quota || { limit: 20000, remaining: 20000, used: 0 };
      return {
        kind: quota.remaining <= 0 ? ("exhausted" as const) : ("healthy" as const),
        success: true,
        quota: { ...quota, resetAt: null, source: "pioneer.fetchQuota" },
      };
    }

    let activeTokens: PioneerTokens = tokens;
    let refreshedTokensJson: string | undefined;

    const probeUser = async (accessToken: string) => {
      return await this.fetchWithTimeout(PIONEER_USER_URL, {
        method: "GET",
        headers: { "Authorization": `Bearer ${accessToken}` },
      }, config.providerQuotaTimeoutMs);
    };

    try {
      let response = await probeUser(activeTokens.access_token!);

      if ((response.status === 401 || response.status === 403) && activeTokens.refresh_token) {
        const refreshed = await this.refreshSupabaseToken(activeTokens.refresh_token, activeTokens.supabase_anon_key);
        if (refreshed) {
          activeTokens = { ...activeTokens, access_token: refreshed.access_token, refresh_token: refreshed.refresh_token };
          refreshedTokensJson = JSON.stringify(activeTokens);
          response = await probeUser(activeTokens.access_token!);
        }
      }

      if (response.status === 401 || response.status === 403) {
        // api_key is still valid for inference — don't kick from pool, keep existing quota from DB
        if (tokens.api_key) {
          return {
            kind: "healthy" as const,
            success: true,
            skipQuotaUpdate: true,
            ...(refreshedTokensJson ? { tokens: refreshedTokensJson } : {}),
          };
        }
        return { kind: "auth_error" as const, success: false, retryable: false, error: `expired: HTTP ${response.status}` };
      }
      if (!response.ok) {
        return { kind: "transient_error" as const, success: false, retryable: true, error: `HTTP ${response.status}` };
      }

      const billingResp = await this.fetchWithTimeout(PIONEER_BILLING_URL, {
        method: "GET",
        headers: { "Authorization": `Bearer ${activeTokens.access_token}` },
      }, config.providerQuotaTimeoutMs);

      let limit = 20000;
      let used = 0;
      let remaining = 20000;
      if (billingResp.ok) {
        const data = await billingResp.json() as any;
        limit = Number(data.credit_limit || 20000);
        used = Number(data.total_usage || 0);
        remaining = Number(data.free_tier_remaining ?? Math.max(0, limit - used));
      }

      const exhausted = remaining <= 0;
      return {
        kind: exhausted ? ("exhausted" as const) : ("healthy" as const),
        success: true,
        quota: { limit, remaining, used, resetAt: null, source: "pioneer.fetchQuota" },
        ...(refreshedTokensJson ? { tokens: refreshedTokensJson } : {}),
      };
    } catch (e) {
      return { kind: "transient_error" as const, success: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
