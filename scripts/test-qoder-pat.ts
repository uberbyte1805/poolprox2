import { QoderProvider, activateQoderPat } from "../src/proxy/providers/qoder";
import type { Account } from "../src/db/schema";

const PAT = process.argv[2] || process.env.QODER_PAT || "";

if (!PAT) {
  console.error("Usage: bun scripts/test-qoder-pat.ts <PAT>  (or set QODER_PAT env)");
  process.exit(1);
}

async function main() {
  const { tokens, jobToken } = await activateQoderPat(PAT);
  console.log("user:", jobToken.email);

  const fakeAccount = {
    id: 999, provider: "qoder", email: jobToken.email || "test@pat",
    password: "test", status: "active", enabled: true, tokens,
    quotaLimit: 0, quotaRemaining: 0, quotaResetAt: null,
    lastUsedAt: null, lastLoginAt: null, errorMessage: null,
    metadata: null, createdAt: new Date(), updatedAt: new Date(),
  } as unknown as Account;

  const provider = new QoderProvider();

  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather in a given location",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string", description: "City name" },
            unit: { type: "string", enum: ["celsius", "fahrenheit"] },
          },
          required: ["location"],
        },
      },
    },
  ];

  console.log("\n=== [A] STREAMING (no tools) ===");
  const sA = await provider.chatCompletionStream(fakeAccount, {
    model: "qd-auto",
    stream: true,
    messages: [{ role: "user", content: "Count from 1 to 5, one number per line." }],
  });
  if (sA.success && sA.stream) {
    const reader = sA.stream.getReader();
    const dec = new TextDecoder();
    let chunks = 0, content = "", finishReason = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const obj = JSON.parse(line.slice(6));
          chunks++;
          if (obj.choices?.[0]?.delta?.content) content += obj.choices[0].delta.content;
          if (obj.choices?.[0]?.finish_reason) finishReason = obj.choices[0].finish_reason;
        } catch {}
      }
    }
    console.log("  chunks =", chunks);
    console.log("  finish =", finishReason);
    console.log("  text   =", JSON.stringify(content.slice(0, 300)));
  } else {
    console.log("  failed:", sA.error);
  }

  console.log("\n=== [B] NON-STREAM + tools ===");
  const rB = await provider.chatCompletion(fakeAccount, {
    model: "qd-auto",
    messages: [{ role: "user", content: "What's the weather in Jakarta? Use the get_weather function." }],
    tools,
  });
  console.log("  success=", rB.success, "error=", rB.error?.slice(0, 200));
  if (rB.response) {
    const c = rB.response.choices[0];
    console.log("  finish =", c?.finish_reason);
    console.log("  content=", JSON.stringify((typeof c?.message.content === "string" ? c.message.content : "").slice(0, 200)));
    const tc = c?.message.tool_calls;
    console.log("  tool_calls count =", tc?.length || 0);
    if (tc?.length) {
      for (const t of tc) {
        console.log("    -", JSON.stringify(t));
      }
    }
  }

  console.log("\n=== [C] STREAMING + tools ===");
  const sC = await provider.chatCompletionStream(fakeAccount, {
    model: "qd-auto",
    stream: true,
    messages: [{ role: "user", content: "What's the weather in Tokyo? Use the get_weather function." }],
    tools,
  });
  if (sC.success && sC.stream) {
    const reader = sC.stream.getReader();
    const dec = new TextDecoder();
    let chunks = 0, content = "", finishReason = "";
    const toolAcc: any[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const obj = JSON.parse(line.slice(6));
          chunks++;
          const d = obj.choices?.[0]?.delta;
          if (d?.content) content += d.content;
          if (Array.isArray(d?.tool_calls)) {
            for (const tc of d.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolAcc[idx]) toolAcc[idx] = { id: "", function: { name: "", arguments: "" } };
              if (tc.id) toolAcc[idx].id = tc.id;
              if (tc.function?.name) toolAcc[idx].function.name = tc.function.name;
              if (tc.function?.arguments) toolAcc[idx].function.arguments += tc.function.arguments;
            }
          }
          if (obj.choices?.[0]?.finish_reason) finishReason = obj.choices[0].finish_reason;
        } catch {}
      }
    }
    console.log("  chunks =", chunks);
    console.log("  finish =", finishReason);
    console.log("  text   =", JSON.stringify(content.slice(0, 200)));
    console.log("  tool_calls count =", toolAcc.length);
    for (const t of toolAcc) {
      console.log("    -", JSON.stringify(t));
    }
  } else {
    console.log("  failed:", sC.error);
  }
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
