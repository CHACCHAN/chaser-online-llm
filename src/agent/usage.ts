/** Claude Code が返すトークン使用量の集計 */
export interface UsageTotals {
  /** 問い合わせ（result イベント）の回数 */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export function emptyUsage(): UsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

export function diffUsage(after: UsageTotals, before: UsageTotals): UsageTotals {
  return {
    calls: after.calls - before.calls,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
    cacheCreationTokens: after.cacheCreationTokens - before.cacheCreationTokens,
    costUsd: after.costUsd - before.costUsd,
  };
}

/** クォータ判定に使う総トークン（キャッシュ読み書きも含めてモデルが処理した量） */
export function totalTokens(u: UsageTotals): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function usageFromRaw(raw: RawUsage | undefined, costUsd?: number): UsageTotals {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    calls: 1,
    inputTokens: n(raw?.input_tokens),
    outputTokens: n(raw?.output_tokens),
    cacheReadTokens: n(raw?.cache_read_input_tokens),
    cacheCreationTokens: n(raw?.cache_creation_input_tokens),
    costUsd: n(costUsd),
  };
}

/** API 1回ぶんの usage から「今の会話の大きさ」を求める */
export function contextSizeFromRaw(raw: RawUsage | undefined): number | null {
  if (!raw) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const size = n(raw.input_tokens) + n(raw.cache_read_input_tokens) + n(raw.cache_creation_input_tokens);
  return size > 0 ? size : null;
}
