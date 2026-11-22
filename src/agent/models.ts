import { numSetting } from "../settings";
import { CLAUDE_BINARY, buildClaudeEnv, llmLimitsEnv } from "./claude-env";
import { resolveLlmAuth, SUBSCRIPTION_MODELS } from "./llm-auth";

/** サブスクリプション: ハーネスの Claude Code（var/claude-home）がログイン済みか。トークンを入れていれば確かめない */
export async function subscriptionLoginProblem(): Promise<string | null> {
  if (Object.keys(resolveLlmAuth().claudeEnv).length > 0) return null;
  try {
    const p = Bun.spawn([CLAUDE_BINARY, "auth", "status", "--json"], { env: buildClaudeEnv({}), stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => p.kill(), 20_000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    const st = JSON.parse(out) as { loggedIn?: boolean };
    return st.loggedIn ? null : "サブスクリプションにログインしていない。LLM_OAUTH_TOKEN に `claude setup-token` のトークンを入れるか、`bun run claude-login` でログインする";
  } catch (err) {
    return `ログインの状態を確かめられない（${err instanceof Error ? err.message : String(err)}）`;
  }
}

/**
 * モデルの一覧。api は LLM_API_URL の /models から取る（OpenAI 互換 / Anthropic 互換の両方に対応）。
 * subscription は Claude Code の別名（opus / sonnet / haiku）。ほかのモデル ID も入力すれば使える。
 */
export async function listGatewayModels(): Promise<{ models: string[]; error: string | null }> {
  const r = await listModelsInner();
  // コンテキストの大きさなどの書き方の誤りも、ここで知らせる（WebUI のモデル欄に出る）
  const limitErrors = llmLimitsEnv().errors;
  return limitErrors.length > 0 ? { models: r.models, error: [r.error, ...limitErrors].filter(Boolean).join("。") } : r;
}

async function listModelsInner(): Promise<{ models: string[]; error: string | null }> {
  const auth = resolveLlmAuth();
  if (auth.problem) return { models: auth.mode === "subscription" ? [...SUBSCRIPTION_MODELS] : [], error: auth.problem };
  if (auth.mode === "subscription") return { models: [...SUBSCRIPTION_MODELS], error: await subscriptionLoginProblem() };
  // 空なら Anthropic API に直接（Claude Code の既定と同じ）
  const raw = (Bun.env.LLM_API_URL ?? "").trim() || "https://api.anthropic.com";
  const base = raw.replace(/\/+$/, "");
  const urls = base.endsWith("/v1") ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];

  let lastError = "unknown";
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { ...auth.headers, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(numSetting("LLM_MODELS_TIMEOUT_SEC", { min: 1 }) * 1000),
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status} (${url})`;
        continue;
      }
      const body = (await res.json()) as { data?: { id?: string }[] };
      const models = (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string")
        .sort();
      return { models, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { models: [], error: lastError };
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
