/**
 * 行動ログ: 1ターン1行の、人が読むための記録（var/runs/<runId>/actions.log。試合中に1ターンずつ書き足す）。
 * 何をしたか（CMD1→CMD2）・得点の増減・誰が決めたか・理由・鳴ったきっかけ・届いた LLM の返答・モデルの切り替え。
 * 中身は turns.jsonl と同じ（そちらが正）。画面の「行動ログ」も同じ項目を出す（src/ui/public/index.html の renderActLog）。
 */

export interface ActionLogTurn {
  turn: number;
  cmd1: string | null;
  cmd2: string | null;
  cmd1Reason?: string | null;
  cmd2Reason?: string | null;
  cmd1Source?: "main" | "solver" | null;
  cmd2Source?: "main" | "solver" | null;
  usedFallback?: boolean;
  estimatedScoreAfter: number;
  triggers?: { id: string; label?: string; phase?: string }[];
  llmReplies?: { asked: number; phase: string; by: string[]; action: string | null; model?: string; target?: [number, number] }[];
  model?: string;
  gameOverReason?: string | null;
}

const short = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 1ターンを1行に。prevEst は前のターンの推定得点、modelName は id → 名前 */
export function formatActionLine(t: ActionLogTurn, prevEst: number, modelName: (id: string) => string = (id) => id): string {
  const delta = t.estimatedScoreAfter - prevEst;
  const who = (src: string | null | undefined, reason: string | null | undefined) =>
    src === "main" ? "LLM" : reason?.includes("指定の目標") ? "LLMの目標" : "方策";
  const parts = [
    `T${t.turn}`,
    `${t.cmd1 ?? "-"}→${t.cmd2 ?? "-"}`,
    `${delta >= 0 ? "+" : ""}${delta}`,
    `(${t.estimatedScoreAfter})`,
    `[${who(t.cmd2Source ?? t.cmd1Source, t.cmd2Reason ?? t.cmd1Reason)}${t.model ? `・${modelName(t.model)}` : ""}${t.usedFallback ? "・安全手" : ""}]`,
    short(t.cmd2Reason ?? t.cmd1Reason, 70),
  ];
  const extra: string[] = [];
  if (t.triggers?.length) extra.push(`きっかけ: ${t.triggers.map((f) => f.label ?? f.id).join("・")}`);
  for (const r of t.llmReplies ?? []) {
    const what = r.action === null ? "返答なし" : r.action === "plan" ? `目標${r.target ? ` (${r.target.join(",")})` : ""}` : "そのまま";
    extra.push(`LLM（T${r.asked} ${r.phase} に聞いた分${r.by.length ? `・${r.by.join(",")}` : ""}）: ${what}${r.model ? `・モデル→${modelName(r.model)}` : ""}`);
  }
  if (t.gameOverReason) extra.push(`終了: ${short(t.gameOverReason, 60)}`);
  return [parts.join(" "), ...extra].join(" | ");
}
