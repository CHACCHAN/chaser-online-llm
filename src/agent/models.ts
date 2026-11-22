import { numSetting } from "../settings";
import { resolveLlmAuth } from "./llm-auth";
/**
 * LLM_API_URL のゲートウェイからモデル一覧を取得する (OpenAI 互換 / Anthropic 互換 /models の両方に対応)。
 */
export async function listGatewayModels(): Promise<{ models: string[]; error: string | null }> {
  // 空なら Anthropic API に直接（Claude Code の既定と同じ）
  const raw = (Bun.env.LLM_API_URL ?? "").trim() || "https://api.anthropic.com";
  const auth = resolveLlmAuth();
  if (auth.problem) return { models: [], error: auth.problem };
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
