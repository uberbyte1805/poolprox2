/**
 * Qoder Trial Probe v4 — multiple machine fingerprint variations
 * Test if trial is tied to specific OS/IDE combinations
 * Usage: bun scripts/qoder-trial-probe.ts <PAT> [variant|all]
 */

import { activateQoderPat, bearerFetch, openApiHeaders, signatureHeaders, encodeQoderPayload } from "../src/proxy/providers/qoder";

const OPENAPI_BASE = "https://openapi.qoder.sh";
const CENTER_BASE = "https://center.qoder.sh";

const QUOTA_USAGE_URL = `${OPENAPI_BASE}/api/v2/quota/usage`;
const USER_PLAN_URL = `${OPENAPI_BASE}/api/v2/user/plan`;
const HEARTBEAT_URL = `${CENTER_BASE}/algo/api/v1/heartbeat?Encode=1`;
const USER_STATUS_URL = `${CENTER_BASE}/algo/api/v3/user/status?Encode=1`;
const CHAT_URL = "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

const FINGERPRINT_VARIANTS: Record<string, { os_arch: string; os_version: string; ide_type: string; ide_version: string }> = {
  windows_qodercli: { os_arch: "windows_amd64", os_version: "Windows 10 10.0", ide_type: "qodercli", ide_version: "0.1.43" },
  windows_qoder_ide: { os_arch: "windows_amd64", os_version: "Windows 10 10.0", ide_type: "qoder", ide_version: "0.3.0" },
  macos_qodercli: { os_arch: "darwin_amd64", os_version: "Darwin 23.0.0", ide_type: "qodercli", ide_version: "0.1.43" },
  macos_qoder_ide: { os_arch: "darwin_arm64", os_version: "Darwin 23.0.0", ide_type: "qoder", ide_version: "0.3.0" },
  linux_qodercli_old: { os_arch: "linux_amd64", os_version: "Linux 5.10", ide_type: "qodercli", ide_version: "0.1.40" },
  vscode_extension: { os_arch: "windows_amd64", os_version: "Windows 10 10.0", ide_type: "vscode", ide_version: "1.85.0" },
};

async function checkQuota(oaHeaders: Record<string, string>, label: string): Promise<any> {
  const r = await fetch(QUOTA_USAGE_URL, { headers: oaHeaders });
  const data: any = await r.json();
  console.log(`[${label}] quota: total=${data.userQuota?.total}, remaining=${data.userQuota?.remaining}, exceeded=${data.isQuotaExceeded}`);
  return data;
}

async function checkPlan(oaHeaders: Record<string, string>, label: string): Promise<any> {
  const r = await fetch(USER_PLAN_URL, { headers: oaHeaders });
  const data: any = await r.json();
  console.log(`[${label}] plan: tier=${data.plan_tier_name}, type=${data.user_type}`);
  return data;
}

async function probeWithFingerprint(pat: string, variantName: string, fp: { os_arch: string; os_version: string; ide_type: string; ide_version: string }): Promise<boolean> {
  console.log(`\n========================================`);
  console.log(`VARIANT: ${variantName}`);
  console.log(`  os_arch=${fp.os_arch} ide_type=${fp.ide_type}/${fp.ide_version}`);
  console.log(`========================================`);

  const { tokens, jobToken } = await activateQoderPat(pat);
  console.log(`  machineId=${tokens.machineId}`);
  console.log(`  jobToken: plan=${jobToken.plan} quota=${(jobToken as any).quota}`);

  const oaHeaders = openApiHeaders(tokens.securityOauthToken || "");
  const sigHeaders = signatureHeaders(tokens);

  await checkQuota(oaHeaders, `${variantName}-baseline`);

  const heartbeatBody = {
    event_time: Date.now(),
    event_type: "cosy_heartbeat",
    mid: tokens.machineId,
    os_arch: fp.os_arch,
    os_version: fp.os_version,
    ide_type: fp.ide_type,
    ide_version: fp.ide_version,
    extra_info: {
      cpu_count: 8,
      cpu_model: "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz",
      total_memory_gb: 16,
      hostname: "DESKTOP-" + Math.random().toString(36).substring(2, 9).toUpperCase(),
      timezone: "Asia/Singapore",
      locale: "en_US",
      first_run: true,
    },
  };
  const hbEncoded = encodeQoderPayload(JSON.stringify(heartbeatBody));
  const hbResp = await fetch(HEARTBEAT_URL, { method: "POST", headers: sigHeaders, body: hbEncoded });
  console.log(`  heartbeat: ${hbResp.status}`);

  const statusBody = { userId: tokens.userId, personalToken: "", securityOauthToken: "", refreshToken: "", needRefresh: false, authInfo: {} };
  const statusOuter = { payload: JSON.stringify(statusBody), encodeVersion: "1" };
  const stEncoded = encodeQoderPayload(JSON.stringify(statusOuter));
  const stResp = await fetch(USER_STATUS_URL, { method: "POST", headers: sigHeaders, body: stEncoded });
  const stData: any = await stResp.json();
  console.log(`  userStatus: plan=${stData.plan} quota=${stData.quota} userTag=${stData.userTag}`);

  const chatBody = {
    request_id: crypto.randomUUID(),
    request_set_id: crypto.randomUUID(),
    chat_record_id: crypto.randomUUID(),
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: { chatPrompt: "", extra: { context: [], modelConfig: { is_reasoning: false, key: "auto" }, originalContent: { type: "text", text: "hi" } }, features: [], imageUrls: null, text: { type: "text", text: "hi" } },
    image_urls: null, is_reply: true, is_retry: false,
    session_id: crypto.randomUUID(),
    code_language: "", source: 1, version: "3", chat_prompt: "",
    parameters: { max_tokens: 50 },
    aliyun_user_type: tokens.userType || "personal_standard",
    session_type: fp.ide_type === "qodercli" ? "qodercli" : "qoder",
    agent_id: "agent_common", task_id: "common",
    model_config: { key: "auto", display_name: "Auto", model: "", format: "openai", is_vl: true, is_reasoning: false, api_key: "", url: "", source: "system", max_input_tokens: 180000 },
    messages: [{ role: "user", content: "hi" }],
  };
  try {
    const r = await bearerFetch(tokens, { url: CHAT_URL, body: chatBody, stream: true });
    console.log(`  chat: ${r.status}`);
    await r.text();
  } catch (e: any) {
    console.log(`  chat error: ${e.message}`);
  }

  const finalQuota: any = await checkQuota(oaHeaders, `${variantName}-final`);
  if (finalQuota.userQuota?.total > 0) {
    console.log(`  *** TRIAL DETECTED with variant ${variantName}! ***`);
    return true;
  }
  return false;
}

async function main() {
  const pat = process.argv[2] || Bun.env.QODER_PAT;
  const variantArg = process.argv[3];
  if (!pat) {
    console.error("Usage: bun scripts/qoder-trial-probe.ts <PAT> [variant|all]");
    console.error("Variants:", Object.keys(FINGERPRINT_VARIANTS).join(", "));
    process.exit(1);
  }

  if (variantArg && variantArg !== "all" && !FINGERPRINT_VARIANTS[variantArg]) {
    console.error(`Unknown variant: ${variantArg}`);
    process.exit(1);
  }

  let trialFound = false;
  if (variantArg === "all" || !variantArg) {
    for (const [name, fp] of Object.entries(FINGERPRINT_VARIANTS)) {
      const ok = await probeWithFingerprint(pat, name, fp);
      if (ok) { trialFound = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } else {
    trialFound = await probeWithFingerprint(pat, variantArg, FINGERPRINT_VARIANTS[variantArg]!);
  }

  console.log("\n========================================");
  console.log(trialFound ? "RESULT: Trial activated!" : "RESULT: No trial activated by any variant.");
  console.log("========================================");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
