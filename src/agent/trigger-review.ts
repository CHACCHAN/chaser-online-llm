import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isRunDirName, RUNS_DIR } from "../paths";
import { getStyle } from "../solver/models";
import { TRIGGER_DEFS, type TriggerId } from "./triggers";

/**
 * 試合後に、試合中の LLM を呼ぶきっかけを評価する（var/runs/<runId>/trigger-review.json と diagnosis.md の節）。
 * きっかけごとに、鳴った回数・LLM を呼んだ回数・LLM の選択（目標・モデルの切り替え）と、その後 AFTER_TURNS ターンの得点を、
 * 「鳴ったが呼ばなかった時」と試合全体と比べる。次の準備の LLM が、きっかけ・しきい値・目安を選ぶ材料にする（roomTriggerHistory）。
 * 得点はハーネスの推定（当てられた得点は入らない）。当てられたかは Webマップのプットダメージ（PD）が下がったかで見る。
 */

export const AFTER_TURNS = 10;

/** turns.jsonl の1行のうち、ここで使うもの */
export interface ReviewTurn {
  turn: number;
  estimatedScoreAfter: number;
  triggers?: { id: string; phase?: string }[];
  calledBy?: Partial<Record<"CMD1" | "CMD2", string[]>>;
  llmReplies?: LlmReply[];
  model?: string;
  webScore?: { putDamage?: number };
}

/** 試合中の LLM の返答（聞いたターン・きっかけ・返答の中身） */
export interface LlmReply {
  asked: number;
  phase: string;
  by: string[];
  /** continue / plan / null（返答なし・時間切れ） */
  action: string | null;
  model?: string;
  target?: [number, number];
  ms?: number | null;
}

export interface AfterStat {
  /** 数えた回数（試合の終わりまで AFTER_TURNS ターン無いものも、残りのターンで数える） */
  n: number;
  /** その後の1ターンあたりの推定得点の平均 */
  perTurn: number | null;
  /** その後に当てられた（PD が下がった）回数 */
  hitAfter: number;
}

export interface TriggerStat {
  id: string;
  label: string;
  fired: number;
  /** LLM を呼んだ回数（このきっかけで呼んだ問い合わせ） */
  called: number;
  /** 呼んだ問い合わせへの返答: 目標を出した・そのまま・モデルを切り替えた・返答なし */
  plan: number;
  cont: number;
  switched: number;
  noReply: number;
  /** 切り替えた先のモデル（id → 回数） */
  switchTo: Record<string, number>;
  /** 呼んだ後と、鳴ったが呼ばなかった後（考え中・持ち越しで捨てた） */
  afterCalled: AfterStat;
  afterNotCalled: AfterStat;
}

export interface TriggerReview {
  runId: string;
  room: number | null;
  turns: number;
  callMode: string | null;
  /** 試合全体の1ターンあたりの推定得点 */
  perTurn: number | null;
  calls: number;
  triggers: TriggerStat[];
  /** モデルごとの、使ったターン数と1ターンあたりの推定得点 */
  models: { id: string; name: string; turns: number; perTurn: number | null }[];
  startModel: string | null;
  matchPlan: { model: string | null; guide: Record<string, string>; off: string[]; thresholds: Record<string, number> } | null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function afterStat(turns: ReviewTurn[], index: Map<number, number>, at: number[]): AfterStat {
  let n = 0;
  let sum = 0;
  let hits = 0;
  for (const t of at) {
    const i = index.get(t);
    if (i === undefined) continue;
    const before = i > 0 ? turns[i - 1]!.estimatedScoreAfter : 0;
    const end = Math.min(turns.length - 1, i + AFTER_TURNS - 1);
    const span = end - i + 1;
    if (span <= 0) continue;
    n += 1;
    sum += (turns[end]!.estimatedScoreAfter - before) / span;
    // 当てられた: その間に PD が前に分かっていた値より下がった
    let pd: number | null = null;
    for (let k = i - 1; k >= 0 && pd === null; k--) pd = turns[k]!.webScore?.putDamage ?? null;
    for (let k = i; k <= end; k++) {
      const v = turns[k]!.webScore?.putDamage;
      if (v === undefined) continue;
      if (pd !== null && v < pd) {
        hits += 1;
        break;
      }
      pd = v;
    }
  }
  return { n, perTurn: n ? r1(sum / n) : null, hitAfter: hits };
}

export function reviewRun(turns: ReviewTurn[], summary: Record<string, any>): TriggerReview {
  const index = new Map(turns.map((t, i) => [t.turn, i]));
  const startModel: string | null = typeof summary.policyModel === "string" ? summary.policyModel : null;
  const replies = turns.flatMap((t) => t.llmReplies ?? []);
  const stats: TriggerStat[] = [];
  for (const d of TRIGGER_DEFS) {
    const firedAt: number[] = [];
    for (const t of turns) if (t.triggers?.some((f) => f.id === d.id)) firedAt.push(t.turn);
    const calledAt: number[] = [];
    for (const t of turns) for (const ids of Object.values(t.calledBy ?? {})) if (ids?.includes(d.id)) calledAt.push(t.turn);
    const called = new Set(calledAt);
    // 呼ばなかった: 鳴ってから 5 ターンの間（持ち越しを捨てるまで）にこのきっかけで呼んでいないもの
    // 知らないタイル・終盤は持ち越しを捨てないので、後で呼んだら呼んだことにする
    const keep = d.id === "unknownTile" || d.id === "endgame" ? Infinity : 5;
    const notCalled = firedAt.filter((f) => !calledAt.some((c) => c >= f && c - f <= keep));
    const mine = replies.filter((r) => r.by.includes(d.id));
    const switchTo: Record<string, number> = {};
    for (const r of mine) if (r.model) switchTo[r.model] = (switchTo[r.model] ?? 0) + 1;
    if (firedAt.length === 0 && calledAt.length === 0) continue;
    stats.push({
      id: d.id,
      label: d.label,
      fired: firedAt.length,
      called: called.size,
      plan: mine.filter((r) => r.action === "plan").length,
      cont: mine.filter((r) => r.action === "continue").length,
      switched: mine.filter((r) => r.model).length,
      noReply: mine.filter((r) => r.action === null).length,
      switchTo,
      afterCalled: afterStat(turns, index, [...called]),
      afterNotCalled: afterStat(turns, index, notCalled),
    });
  }
  // モデルごと: そのターンの終わりのモデル（記録が無いターンは最初のモデル）
  const byModel = new Map<string, { turns: number; gain: number }>();
  for (let i = 0; i < turns.length; i++) {
    const id = turns[i]!.model ?? startModel ?? "standard";
    const gain = turns[i]!.estimatedScoreAfter - (i > 0 ? turns[i - 1]!.estimatedScoreAfter : 0);
    const m = byModel.get(id) ?? { turns: 0, gain: 0 };
    m.turns += 1;
    m.gain += gain;
    byModel.set(id, m);
  }
  const last = turns[turns.length - 1];
  const mp = summary.matchPlan;
  return {
    runId: String(summary.runId ?? ""),
    room: typeof summary.room === "number" ? summary.room : null,
    turns: turns.length,
    callMode: typeof summary.callMode === "string" ? summary.callMode : null,
    perTurn: last && turns.length ? r1(last.estimatedScoreAfter / turns.length) : null,
    calls: replies.length,
    triggers: stats,
    models: [...byModel].map(([id, m]) => ({ id, name: getStyle(id).name, turns: m.turns, perTurn: m.turns ? r1(m.gain / m.turns) : null })),
    startModel,
    matchPlan: mp
      ? {
          model: mp.model ?? null,
          guide: mp.guide ?? {},
          off: Object.entries(mp.triggers?.enabled ?? {}).filter(([, v]) => v === false).map(([k]) => k),
          thresholds: mp.triggers?.thresholds ?? {},
        }
      : null,
  };
}

const fmtAfter = (a: AfterStat) => (a.n ? `${a.perTurn}点/ターン（${a.n}回${a.hitAfter ? `・当てられた ${a.hitAfter}` : ""}）` : "-");

export function renderTriggerReview(r: TriggerReview): string {
  const lines = [
    "## 試合中の LLM を呼ぶきっかけの評価",
    "",
    `呼んだ時: ${r.callMode === "trigger" ? "きっかけが鳴った時だけ" : r.callMode === "every" ? "毎回" : "LLM なし"} / LLM の返答 ${r.calls} 回 / 試合全体 ${r.perTurn ?? "-"} 点/ターン（推定）。「その後」は鳴った・呼んだターンから ${AFTER_TURNS} ターンの推定得点。`,
  ];
  if (r.matchPlan) {
    const g = Object.entries(r.matchPlan.guide).map(([k, v]) => `${TRIGGER_DEFS.find((d) => d.id === k)?.label ?? k}「${v}」`);
    lines.push(`準備の設定: 最初のモデル ${r.matchPlan.model ? getStyle(r.matchPlan.model).name : "設定のまま"}${r.matchPlan.off.length ? ` / 使わない ${r.matchPlan.off.map((k) => TRIGGER_DEFS.find((d) => d.id === k)?.label ?? k).join("・")}` : ""}${g.length ? ` / 目安 ${g.join("・")}` : ""}`);
  }
  if (r.triggers.length === 0) {
    lines.push("", "鳴ったきっかけは無かった。");
  } else {
    lines.push("", "| きっかけ | 鳴った | 呼んだ | 目標 | そのまま | モデル切替 | 返答なし | 呼んだ後 | 呼ばなかった後 |", "| :--- | ---: | ---: | ---: | ---: | :--- | ---: | :--- | :--- |");
    for (const t of r.triggers) {
      const sw = Object.entries(t.switchTo).map(([k, v]) => `${getStyle(k).name} ${v}`).join("・");
      lines.push(`| ${t.label} | ${t.fired} | ${t.called} | ${t.plan} | ${t.cont} | ${sw || "-"} | ${t.noReply} | ${fmtAfter(t.afterCalled)} | ${fmtAfter(t.afterNotCalled)} |`);
    }
  }
  if (r.models.length > 0) {
    lines.push("", `モデル: ${r.models.map((m) => `${m.name} ${m.turns}ターン ${m.perTurn ?? "-"}点/ターン`).join(" / ")}`);
  }
  return lines.join("\n");
}

export function readTurns(runDir: string): ReviewTurn[] {
  const file = path.join(runDir, "turns.jsonl");
  if (!existsSync(file)) return [];
  const out: ReviewTurn[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as ReviewTurn;
      if (typeof o.turn === "number" && typeof o.estimatedScoreAfter === "number") out.push(o);
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return out;
}

/** 試合の記録フォルダの評価（trigger-review.json。無ければ turns.jsonl から作る。きっかけの記録が無い古い試合は null） */
export function loadRunReview(runDir: string): TriggerReview | null {
  const file = path.join(runDir, "trigger-review.json");
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8")) as TriggerReview;
    const sf = path.join(runDir, "summary.json");
    if (!existsSync(sf)) return null;
    const summary = JSON.parse(readFileSync(sf, "utf-8")) as Record<string, any>;
    if (!summary.triggers) return null;
    return reviewRun(readTurns(runDir), summary);
  } catch {
    return null;
  }
}

/** 複数の試合をきっかけごとに合わせる（統計の画面・準備） */
export interface TriggerAggregate {
  id: string;
  label: string;
  runs: number;
  fired: number;
  called: number;
  plan: number;
  cont: number;
  switched: number;
  noReply: number;
  switchTo: Record<string, number>;
  afterCalled: AfterStat;
  afterNotCalled: AfterStat;
  /** 鳴った試合の、試合全体の1ターンあたりの平均（呼んだ後と比べる） */
  matchPerTurn: number | null;
  turns: number;
}

const mergeAfter = (a: AfterStat, b: AfterStat): AfterStat => {
  const n = a.n + b.n;
  return { n, perTurn: n ? r1(((a.perTurn ?? 0) * a.n + (b.perTurn ?? 0) * b.n) / n) : null, hitAfter: a.hitAfter + b.hitAfter };
};

export function aggregateReviews(reviews: TriggerReview[]): TriggerAggregate[] {
  const out = new Map<string, TriggerAggregate & { mpSum: number; mpN: number }>();
  for (const r of reviews) {
    for (const t of r.triggers) {
      const a = out.get(t.id) ?? {
        id: t.id, label: t.label, runs: 0, fired: 0, called: 0, plan: 0, cont: 0, switched: 0, noReply: 0, switchTo: {},
        afterCalled: { n: 0, perTurn: null, hitAfter: 0 }, afterNotCalled: { n: 0, perTurn: null, hitAfter: 0 }, matchPerTurn: null, turns: 0, mpSum: 0, mpN: 0,
      };
      a.runs += 1;
      a.turns += r.turns;
      for (const k of ["fired", "called", "plan", "cont", "switched", "noReply"] as const) a[k] += t[k];
      for (const [m, v] of Object.entries(t.switchTo)) a.switchTo[m] = (a.switchTo[m] ?? 0) + v;
      a.afterCalled = mergeAfter(a.afterCalled, t.afterCalled);
      a.afterNotCalled = mergeAfter(a.afterNotCalled, t.afterNotCalled);
      if (r.perTurn !== null) {
        a.mpSum += r.perTurn;
        a.mpN += 1;
      }
      out.set(t.id, a);
    }
  }
  return TRIGGER_DEFS.filter((d) => out.has(d.id)).map((d) => {
    const { mpSum, mpN, ...a } = out.get(d.id)!;
    return { ...a, matchPerTurn: mpN ? r1(mpSum / mpN) : null };
  });
}

/** このルームの過去の試合の評価（新しい順に limit 試合）。準備に見せる */
export function roomReviews(room: number, limit = 10): TriggerReview[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((n) => isRunDirName(n) && n.endsWith(`_room${room}`))
    .sort()
    .reverse()
    .map((n) => loadRunReview(path.join(RUNS_DIR, n)))
    .filter((r): r is TriggerReview => r !== null)
    .slice(0, limit);
}

/** 準備の LLM に見せる、このルームのきっかけの成績（無ければ空文字） */
export function roomTriggerHistoryText(room: number, limit = 10): string {
  const reviews = roomReviews(room, limit);
  if (reviews.length === 0) return "";
  const agg = aggregateReviews(reviews);
  const lines = [
    `## このルームのきっかけの成績（きっかけを記録した過去 ${reviews.length} 試合。各試合の trigger-review.json）`,
    `「その後」は ${AFTER_TURNS} ターンの推定得点/ターン（当てられた得点は入らない。当てられた回数は Webマップの PD から）。呼んだ後が呼ばなかった後・試合平均より低いきっかけは、呼んでも役に立っていない（しきい値を変える・切る・目安を変える）。`,
    "| きっかけ | 試合 | 鳴った(100ターンあたり) | 呼んだ | 目標/そのまま/モデル切替 | 呼んだ後 | 呼ばなかった後 | 試合平均 |",
    "| :--- | ---: | ---: | ---: | :--- | :--- | :--- | ---: |",
    ...agg.map((a) => {
      const sw = Object.entries(a.switchTo).map(([k, v]) => `${getStyle(k).name}${v}`).join("・");
      return `| ${a.label} \`${a.id}\` | ${a.runs} | ${a.fired} (${a.turns ? r1((a.fired / a.turns) * 100) : "-"}) | ${a.called} | ${a.plan}/${a.cont}/${a.switched}${sw ? `（${sw}）` : ""} | ${fmtAfter(a.afterCalled)} | ${fmtAfter(a.afterNotCalled)} | ${a.matchPerTurn ?? "-"} |`;
    }),
  ];
  const models = new Map<string, { turns: number; gain: number }>();
  for (const r of reviews) for (const m of r.models) {
    const x = models.get(m.id) ?? { turns: 0, gain: 0 };
    x.turns += m.turns;
    x.gain += (m.perTurn ?? 0) * m.turns;
    models.set(m.id, x);
  }
  if (models.size > 0) lines.push("", `モデルを使ったターンと推定得点/ターン: ${[...models].map(([id, m]) => `${getStyle(id).name} ${m.turns}ターン ${m.turns ? r1(m.gain / m.turns) : "-"}`).join(" / ")}`);
  const plans = reviews.filter((r) => r.matchPlan).slice(0, 3);
  if (plans.length > 0) {
    lines.push("", "最近の準備の設定と結果:");
    for (const r of plans) lines.push(`- ${r.runId}: 最初のモデル ${r.matchPlan!.model ? getStyle(r.matchPlan!.model).name : "設定のまま"}${r.matchPlan!.off.length ? `・使わない ${r.matchPlan!.off.join(",")}` : ""}・呼んだ ${r.calls} 回 → ${r.perTurn ?? "-"} 点/ターン`);
  }
  return lines.join("\n");
}
