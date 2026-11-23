import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_WORK_TOOLS, type AskResult, ClaudeSession } from "../agent/claude-session";
import { restoreProtectedFiles, snapshotProtectedFiles } from "../evolution/edit-guard";
import { beginEvaluatorEdit, endEvaluatorEdit } from "../evolution/post-match-queue";
import { activePolicyPrompt } from "../agent/policy";
import { appendReview } from "../agent/harness-review";
import { OBJECTIVE_KEYS } from "../solver/models";
import { PARAM_SPACE } from "../solver/evaluator";
import { AGENT_DIR, AGENT_REVIEW_PATH, EVALUATOR_PATH, POLICY_STYLES_PATH, LAB_COACH_DIR, LAB_COACH_LOG_PATH, POLICY_TRAIN_LOG_PATH, PROJECT_ROOT, RUNS_DIR, SIM_MAPS_DIR, SIM_PROFILES_PATH, TRAIN_CONFIG_PATH } from "../paths";
import { getSetting, numSetting } from "../settings";
import { logger } from "../tools/logger";
import type { EpisodeResult } from "./episode";
import { getTileInfo } from "../memory/world-map";
import { isPortalTile } from "./engine";
import { loadRealMaps, makeScenario } from "./mapgen";
import { gateEvaluatorChange, type GateResult } from "./post-match";
import { type OracleGap, renderGap } from "./oracle";
import { makeRng } from "./rng";
import { loadTrainConfig, type TrainResult } from "./train";

/**
 * 学習の LLM（試合中の LLM とは別のセッション）。学習が終わるたびに lab.ts から呼ぶ。
 *
 * 1. 学習の結果・地図ごとの成績（足踏み・罠・方策の誤り）・本物の地図との違いを var/lab-coach/<日時>/ に書き出す。
 * 2. ツールありの Claude Code（agent/prompts/lab-coach.md）に読ませ、学習環境を直させる:
 *    評価関数 src/solver/evaluator.ts・地図の作り方 knowledge/sim-profiles.json・学習のやり方 knowledge/train-config.json。
 * 3. 直したものを確かめ、だめなら元に戻す:
 *    - 評価関数: 改修前と同じ地図で比べ、弱くなっていれば戻す（試合後の振り返りと同じ gateEvaluatorChange）。
 *    - 地図の作り方: 読めて地図が作れること。本物の地図があるルームでは、作った地図のタイルの割合が本物から遠ざかったら戻す
 *      （方策の得点では比べない。地図を易しくすれば得点は上がってしまうので）。
 *    - 学習のやり方: 読めて範囲の中であること（外なら戻す）。
 *    それ以外（ハーネス）を変えていたら元に戻す。
 */

export interface CoachChange {
  what: "evaluator" | "profiles" | "trainConfig" | "styles" | "review";
  accepted: boolean;
  detail: string;
}

export interface CoachResult {
  status: "ok" | "timeout" | "dead" | "stopped";
  /** LLM の報告（何を見て何を直したか） */
  summary: string;
  changes: CoachChange[];
  /** 範囲外で元に戻したファイル */
  reverted: string[];
  startedAt: string;
  finishedAt: string;
  trigger: string;
  dir: string;
  /** 学習したモデル・ルームと、理論値の目安との差（統計の推移に出す） */
  model?: string;
  room?: number | null;
  gap?: { policy: number; reference: number; ratio: number; knowledgeGap: number; searchGap: number } | null;
}

export interface CoachInput {
  trigger: string;
  room: number | null;
  train: TrainResult;
  /** 今の方策（学習の後）で打たせた地図の記録（再生用の trace つき） */
  runs: EpisodeResult[];
  /** 同じ地図を学習の前の方策で打たせた記録（あれば） */
  runsBefore?: EpisodeResult[] | null;
  /** 理論値の目安との差（src/sim/oracle.ts。測れなかったら null） */
  gap?: OracleGap | null;
  /** 学習したモデル */
  model?: string;
}

export interface CoachDeps {
  /** LLM に聞く（テストで差し替える）。既定はツールありの Claude Code セッション */
  ask?: (prompt: string, timeoutMs: number) => Promise<AskResult>;
  /** 止める（試合が始まった等）。true になったら LLM を止め、改修は全部戻す */
  shouldStop?: () => boolean;
  gateEvaluator?: (baselineCode: string, room: number | null) => Promise<GateResult>;
  paths?: { evaluator?: string; profiles?: string; trainConfig?: string; styles?: string; review?: string; dir?: string; log?: string };
  /** 守る範囲（src/ など）の変更を戻すか（テストでは戻さない） */
  guard?: boolean;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const perTurnOf = (r: EpisodeResult) => r.score / Math.max(1, r.totalTurns);

/** 最後に同じ2マス以内を行き来していたターン数（足踏み）。trace が無ければ 0 */
export function stuckTurns(run: EpisodeResult): number {
  const tr = run.trace;
  if (!tr) return 0;
  const me = tr.players.findIndex((p) => p.self);
  const seen = new Set<string>();
  let n = 0;
  for (let i = tr.frames.length - 1; i >= 0; i--) {
    seen.add(tr.frames[i]!.pos[me]!.join(","));
    if (seen.size > 2) break;
    n += 1;
  }
  return n >= 6 ? n : 0;
}

/** タイルの割合（地図の中の全マスに対する、番号ごとの割合） */
export function tileHistogram(grids: number[][][]): Map<number, number> {
  const h = new Map<number, number>();
  let total = 0;
  for (const g of grids) for (const row of g) for (const v of row) {
    h.set(v, (h.get(v) ?? 0) + 1);
    total += 1;
  }
  for (const [k, v] of h) h.set(k, v / Math.max(1, total));
  return h;
}

/**
 * 地図の形（タイルの割合では分からない所）: 歩いてつながる区画の数（罠・壁・ワープで区切られる）、
 * 一番大きい区画の外にある点の割合（ワープ・桂馬でしか取れない）、罠に囲まれた点（4近傍が全部罠・壁）の割合。
 */
export interface MapStructure {
  regions: number;
  outsideMain: number;
  enclosed: number;
}

export function mapStructure(grid: number[][]): MapStructure {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  const walk = (x: number, y: number) => {
    const v = grid[y]![x]!;
    const info = getTileInfo(v);
    return info.passable && !info.hazard && !isPortalTile(v);
  };
  const region = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (region[y * w + x]! >= 0 || !walk(x, y)) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [[x, y]];
    region[y * w + x] = id;
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      size += 1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx! + dx!, ny = cy! + dy!;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || region[ny * w + nx]! >= 0 || !walk(nx, ny)) continue;
        region[ny * w + nx] = id;
        stack.push([nx, ny]);
      }
    }
    sizes.push(size);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  let points = 0, outside = 0, enclosed = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = grid[y]![x]!;
    // 点 = 土（10）より高いアイテム（土・ワープは数えない）
    if (getTileInfo(v).score <= 10 || isPortalTile(v)) continue;
    points += 1;
    if (region[y * w + x] !== main) outside += 1;
    const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx!, ny = y + dy!;
      return nx >= 0 && ny >= 0 && nx < w && ny < h && walk(nx, ny);
    });
    if (!open) enclosed += 1;
  }
  // 区画は 4 マス以上だけ数える（小さな囲みは enclosed で見る）
  return { regions: sizes.filter((s) => s >= 4).length, outsideMain: points ? outside / points : 0, enclosed: points ? enclosed / points : 0 };
}

export function averageStructure(grids: number[][][]): MapStructure {
  const list = grids.map(mapStructure);
  const avg = (f: (s: MapStructure) => number) => list.reduce((a, s) => a + f(s), 0) / Math.max(1, list.length);
  return { regions: avg((s) => s.regions), outsideMain: avg((s) => s.outsideMain), enclosed: avg((s) => s.enclosed) };
}

export function fmtStructure(s: MapStructure): string {
  return `区画 ${s.regions.toFixed(1)}・大きい区画の外の点 ${(s.outsideMain * 100).toFixed(0)}%・囲まれた点 ${(s.enclosed * 100).toFixed(0)}%`;
}

/** 2つのタイルの割合の違い（L1 距離。0 = 同じ、2 = 全く違う） */
export function histogramDistance(a: Map<number, number>, b: Map<number, number>): number {
  let d = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) d += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  return d;
}

/** モデルの数の上限（学習の LLM が足せるのはここまで。学習の時間を分け合うので） */
export const MAX_STYLES = 8;

/** 学習の LLM が直したモデルの定義が使えるか（使えなければ理由）。前からあるモデルは消さない */
export function stylesProblem(text: string | null, beforeText: string | null): string | null {
  const ids = (t: string | null): string[] => {
    try {
      const raw = JSON.parse(t ?? "{}") as { styles?: { id?: unknown }[] };
      return Array.isArray(raw.styles) ? raw.styles.map((s) => String(s?.id)) : [];
    } catch {
      return [];
    }
  };
  let raw: { styles?: Record<string, unknown>[] };
  try {
    raw = JSON.parse(text ?? "") as typeof raw;
  } catch (err) {
    return `JSON が読めない: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!Array.isArray(raw.styles)) return "styles が配列でない";
  const now = ids(text);
  const missing = ids(beforeText).filter((id) => !now.includes(id));
  if (missing.length) return `前からあるモデルを消した（${missing.join(",")}）`;
  if (now.length > MAX_STYLES) return `モデルが ${MAX_STYLES} より多い`;
  if (new Set(now).size !== now.length) return "id が重なっている";
  for (const s of raw.styles) {
    if (typeof s.id !== "string" || !/^[a-z0-9_-]{1,32}$/.test(s.id) || typeof s.name !== "string" || !s.name) return `id・name が正しくない（${String(s.id)}）`;
    const obj = (s.objective ?? {}) as Record<string, unknown>;
    for (const [k, w] of Object.entries(obj)) {
      if (!OBJECTIVE_KEYS.includes(k as never)) return `${s.id}: 知らない目的 ${k}`;
      const lim = k === "hazard" ? 3000 : 5;
      if (typeof w !== "number" || !Number.isFinite(w) || Math.abs(w) > lim) return `${s.id}: 目的 ${k} の重みが範囲外（±${lim}）`;
    }
    for (const [k, v] of Object.entries((s.fixed ?? {}) as Record<string, unknown>)) {
      const spec = (PARAM_SPACE as Record<string, { min: number; max: number }>)[k];
      if (!spec) return `${s.id}: 知らないパラメータ ${k}`;
      if (typeof v !== "number" || v < spec.min || v > spec.max) return `${s.id}: ${k} が範囲外（${spec.min}〜${spec.max}）`;
    }
  }
  return null;
}

/** 報告の「## ハーネスへの要望」の節（無ければ null）。agent/REVIEW.md に足す */
export function harnessRequests(summary: string): string | null {
  const m = summary.match(/^##\s*ハーネスへの要望\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  const body = m?.[1]?.trim();
  return body && !/^(なし|特になし|-)$/.test(body) ? body : null;
}

/**
 * 地図の成績から、失っている点の見込みを種類ごとに出す（1ターンあたり。大きい順）。
 * どれも直し方の手がかりを添える（評価関数のどこ・どのパラメータ・地図・ハーネスへの要望）。
 */
export function weaknessLines(input: Pick<CoachInput, "runs" | "gap">): string[] {
  const turns = Math.max(1, input.runs.reduce((a, r) => a + r.totalTurns, 0));
  const hazardTile = (r: EpisodeResult) => r.hazardHits;
  const items: { label: string; loss: number; hint: string }[] = [
    {
      label: "相手に当てられた",
      loss: -input.runs.reduce((a, r) => a + (r.putDamage ?? 0), 0) / turns,
      hint: "評価関数の moveValue（敵からの歩数 enemyDist・追ってきているか chasing）と dangerCost・dangerDist・dangerUnsure。当て返す価値は attackGain。traces で当てられたターンの前の動きを見る",
    },
    {
      label: "罠を踏んだ",
      loss: input.runs.reduce((a, r) => a + hazardTile(r) * 800, 0) / turns,
      hint: "罠1回をおよそ -800 と見た目安。stepCost（罠のマスを通る手間）・knowledge/tiles.json の罠の点",
    },
    {
      label: "足踏み（最後に同じ所を行き来）",
      loss: input.runs.reduce((a, r) => a + stuckTurns(r) * 300, 0) / turns,
      hint: "ターンの +300 を取るだけで点が増えていない見込み。目標が無い（取り尽くした・区切られた）→ exitValue・unknownValue。直らなければハーネスへの要望",
    },
    {
      label: "方策の誤り（合法でない手）",
      loss: input.runs.reduce((a, r) => a + (r.policyErrors ?? 0) * 100, 0) / turns,
      hint: "評価関数の例外・NaN。bun run verify-policy",
    },
  ];
  if (input.gap) {
    items.push({ label: "知らないこと（理論値の目安との差）", loss: input.gap.knowledgeGap, hint: "見えない所・ワープの行き先を調べに行く価値（unknownValue・exitValue・portalValue）" });
    items.push({ label: "考えが浅いこと（理論値の目安との差）", loss: input.gap.searchGap, hint: "candidates・depth・beam の範囲（PARAM_SPACE）" });
  }
  return items
    .filter((x) => x.loss > 0.5)
    .sort((a, b) => b.loss - a.loss)
    .map((x, i) => `${i + 1}. ${x.label}: −${r1(x.loss)} 点/ターン — ${x.hint}`)
    .concat(items.every((x) => x.loss <= 0.5) ? ["- 目立って失っているものは無い"] : []);
}

/** 本物の地図が保存してあるルーム */
function roomsWithRealMaps(): number[] {
  if (!existsSync(SIM_MAPS_DIR)) return [];
  return readdirSync(SIM_MAPS_DIR)
    .filter((d) => /^room\d+$/.test(d))
    .map((d) => Number(d.slice(4)))
    .filter((r) => loadRealMaps(r).length > 0);
}

/** 作った地図（本物の地図は混ぜない）と本物の地図の違い。本物の地図が無ければ null */
export function generatedVsReal(room: number, n = 24): { distance: number; realMaps: number; gen: Map<number, number>; real: Map<number, number>; genShape: MapStructure; realShape: MapStructure } | null {
  const real = loadRealMaps(room);
  if (real.length === 0) return null;
  const gen = Array.from({ length: n }, (_, i) => makeScenario(makeRng(5_000_000 + i), { room, realMaps: [] }).grid);
  const hg = tileHistogram(gen);
  const hr = tileHistogram(real.map((m) => m.grid));
  return { distance: histogramDistance(hg, hr), realMaps: real.length, gen: hg, real: hr, genShape: averageStructure(gen), realShape: averageStructure(real.map((m) => m.grid)) };
}

/** 地図の作り方が読めて、地図が作れるか（作れなければ理由） */
function profilesProblem(rooms: (number | null)[]): string | null {
  try {
    for (const room of rooms) {
      for (let i = 0; i < 6; i++) {
        const s = makeScenario(makeRng(4_000_000 + i), { room, realMaps: [] });
        if (s.grid.length < 5 || (s.grid[0]?.length ?? 0) < 5) return `ルーム ${room ?? "いろいろ"} の地図が小さすぎる（${s.grid[0]?.length}×${s.grid.length}）`;
        if (s.starts.length === 0) return `ルーム ${room ?? "いろいろ"} の地図に立てる場所が無い`;
      }
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0]! : String(err);
  }
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf-8") : null);

function fmtHist(h: Map<number, number>, top = 10): string {
  return [...h.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([k, v]) => `${k}:${(v * 100).toFixed(1)}%`)
    .join(" ");
}

/** LLM に渡す統計（report.md）と再生の記録（traces.json）を書き出し、report の本文を返す */
/** シミュレータの1回の当ての大きさ（sim-profiles の putHit） */
function hitSize(room: number | null): number {
  try {
    const prof = JSON.parse(readFileSync(SIM_PROFILES_PATH, "utf-8")) as { default?: { putHit?: number }; rooms?: Record<string, { putHit?: number }> };
    return (room !== null ? prof.rooms?.[String(room)]?.putHit : undefined) ?? prof.default?.putHit ?? 0;
  } catch {
    return 0;
  }
}

/** 本物の試合の当てた・当てられた（直近 20 試合の summary.json の公式の結果と hits） */
export function realHitStats(limit = 20): { matches: number; turns: number; hits: number; put: number; putDamage: number; sizes: number[] } {
  const out = { matches: 0, turns: 0, hits: 0, put: 0, putDamage: 0, sizes: [] as number[] };
  let dirs: string[] = [];
  try {
    dirs = readdirSync(RUNS_DIR).sort().reverse();
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (out.matches >= limit) break;
    try {
      const s = JSON.parse(readFileSync(path.join(RUNS_DIR, d, "summary.json"), "utf-8")) as { turns?: number; officialResult?: { putPoint?: number; putDamage?: number } | null; hits?: { put: number; putDamage: number }[] };
      if (!s.officialResult || !s.turns || s.turns < 20) continue;
      out.matches += 1;
      out.turns += s.turns;
      out.put += s.officialResult.putPoint ?? 0;
      out.putDamage += s.officialResult.putDamage ?? 0;
      const hs = s.hits ?? [];
      if (hs.length) {
        out.hits += hs.length;
        for (const h of hs) out.sizes.push(Math.abs(h.putDamage || h.put));
      } else if (s.officialResult.putPoint || s.officialResult.putDamage) {
        out.hits += (s.officialResult.putPoint ? 1 : 0) + (s.officialResult.putDamage ? 1 : 0);
        for (const v of [s.officialResult.putPoint, s.officialResult.putDamage]) if (v) out.sizes.push(Math.abs(v));
      }
    } catch {
      // 読めない試合は数えない
    }
  }
  out.sizes = out.sizes.slice(0, 6);
  return out;
}

export function writeCoachReport(input: CoachInput, dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "traces.json"), JSON.stringify(input.runs.map((r, i) => ({ index: i, scenario: r.scenario, score: r.score, totalTurns: r.totalTurns, trace: r.trace ?? null }))));
  const t = input.train;
  const c = t.comparison;
  const lines: string[] = [
    `# 学習の結果（${input.trigger}${input.room !== null ? `・ルーム ${input.room} に似せた地図` : "・いろいろな地図"}）`,
    "",
    `- モデル: ${t.modelName}（${t.model}。knowledge/styles.json。標準以外は点/ターンではなく、そのモデルの目的の値/ターン）`,
    `- ${t.generations} 世代・${t.episodes} 試合・${Math.round(t.ms / 1000)} 秒`,
    `- 学習に使っていない地図 ${c.n} 枚で: 学習前 ${c.a} → 学習後 ${c.b} 点/ターン（差 ${c.diff}±${c.se}、勝ち ${c.wins}/${c.n}、罠 ${c.hazardsA}→${c.hazardsB}）→ ${t.accepted ? "保存した" : "保存しない（はっきり良くなっていない）"}`,
    `- 学習のやり方（knowledge/train-config.json）: ${JSON.stringify(loadTrainConfig().config)}`,
    "",
    `## 地図ごとの成績（今の方策${input.runsBefore ? "。前→後は同じ地図を学習前の方策で打たせたもの" : ""}）`,
    "",
    "| # | 地図 | 大きさ | ターン | 点/ターン | 罠 | 足踏み（最後に同じ所を行き来したターン） | 方策の誤り | 相手 | 当てた／当てられた | 勝ち |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  input.runs.forEach((r, i) => {
    const b = input.runsBefore?.[i];
    const size = r.trace ? `${r.trace.width}×${r.trace.height}` : "-";
    const vs = r.opponentKinds?.length ? `${r.opponentKinds.join("・")}` : "-";
    lines.push(`| ${i} | ${r.scenario} | ${size} | ${r.totalTurns} | ${b ? `${r1(perTurnOf(b))}→` : ""}${r1(perTurnOf(r))} | ${r.hazardHits} | ${stuckTurns(r) || "-"} | ${r.policyErrors || "-"} | ${vs} | ${r.put ?? 0}／${r.putDamage ?? 0} | ${r.won === null || r.won === undefined ? "-" : r.won ? "○" : "×"} |`);
  });
  const withOpp = input.runs.filter((r) => r.won !== null && r.won !== undefined);
  if (withOpp.length) {
    const won = withOpp.filter((r) => r.won).length;
    const pd = withOpp.reduce((a, r) => a + (r.putDamage ?? 0), 0);
    lines.push("", `相手のいる地図 ${withOpp.length} 枚: 勝ち ${won}、当てられた合計 ${pd}（相手の種類の重み oppGreedy/oppHunter/oppSelf と自己対戦の相手 var/policy/league.json。当てた時の得点は sim-profiles.json の putHit・仮の値）`);
    // 本物の試合と比べる（シミュレータで当て合いが本物より多すぎると、方策は本物では起きない当て合いを狙うように学習する）
    const turns = withOpp.reduce((a, r) => a + r.totalTurns, 0);
    const hitsSim = withOpp.reduce((a, r) => a + Math.round(((r.put ?? 0) - (r.putDamage ?? 0)) / Math.max(1, hitSize(input.room))), 0);
    const real = realHitStats();
    lines.push(
      `当て合いの多さ: シミュレータ ${r1((hitsSim / Math.max(1, turns)) * 100)} 回/100ターン（当てた＋当てられた。putHit で割った回数）／本物の試合 ${real.matches ? `${r1((real.hits / Math.max(1, real.turns)) * 100)} 回/100ターン（直近 ${real.matches} 試合・${real.turns} ターン、当てた ${real.put}・当てられた ${real.putDamage}。1回の大きさ ${real.sizes.join("・") || "-"}）` : "まだ記録が無い"}。シミュレータの方がずっと多ければ、相手の動き（train-config の opp*）・putHit（sim-profiles）を本物に近づける`,
    );
  }
  const weak = input.runs.map((r, i) => [perTurnOf(r), i] as const).sort((a, b) => a[0] - b[0]).slice(0, 3);
  lines.push("", `弱い地図: ${weak.map(([, i]) => `#${i}`).join(", ")}（traces.json の index。各ターンの位置・得点・自分の当てた／当てられた得点の累計 hits（同じターンの当て合いは得点の差では見えない）・手・方策の理由・変わったマス）`);

  // 弱点: 失っている点の見込み（1ターンあたり、大きい順）。どこから直すかの手がかり
  lines.push("", "## 弱点（失っている点の見込み、1ターンあたり・大きい順。上から直す）", "", ...weaknessLines(input));

  // 理論値の目安との差
  if (input.gap) {
    lines.push("", "## 理論値の目安との差（同じ地図・同じ相手。src/sim/oracle.ts。目標: 届いている割合を 100% に近づける）", "", ...renderGap(input.gap));
    const prev = readCoachLog(5).filter((c) => c.gap).map((c) => `${c.finishedAt.slice(5, 16)} ${c.model ?? "standard"} ${(c.gap!.ratio * 100).toFixed(0)}%`);
    if (prev.length) lines.push(`- これまで: ${prev.join("、")}`);
  }

  // 地図の作り方と本物の地図の違い。学習したルームを先に、ほかのルームは参考として分けて出す
  // （学習の LLM の要望 2026-11-23: ルーム 3 の学習なのに、ルーム 720 の本物と比べているように見えた）
  lines.push("", "## 作った地図と本物の地図の違い（タイルの割合と形。knowledge/sim-profiles.json を直す手がかり）", "");
  const show = (room: number, g: NonNullable<ReturnType<typeof generatedVsReal>>) =>
    lines.push(`- ルーム ${room}（本物 ${g.realMaps} 枚）: 違い ${g.distance.toFixed(3)}（0 = 同じ）`, `  - 本物: ${fmtHist(g.real)}`, `  - 作った: ${fmtHist(g.gen)}`, `  - 形 本物: ${fmtStructure(g.realShape)} / 作った: ${fmtStructure(g.genShape)}（partitions・enclosures で合わせる）`);
  if (input.room !== null) {
    lines.push(`### 学習したルーム ${input.room}`);
    const g = generatedVsReal(input.room);
    if (g) show(input.room, g);
    else lines.push(`- ルーム ${input.room} の本物の地図はまだ無い（試合で全体マップが取れると var/maps/room${input.room}/ に保存される）。このルームの地図の作り方は var/room-profiles.json の実測（大きさ・ターン数・人数）と sim-profiles.json の rooms.${input.room} に合わせる。下のほかのルームの本物は形の参考にだけ使う`);
  } else {
    lines.push("### いろいろな地図（ルームに似せていない）で学習した。下のルームの本物は sim-profiles.json の default の参考");
  }
  const others = roomsWithRealMaps().filter((r) => r !== input.room);
  if (others.length) {
    lines.push("", "### ほかのルーム（参考。地図の作り方を変えると、本物から遠ざかっていないかはこれらのルームでも確かめる）");
    for (const room of others) {
      const g = generatedVsReal(room);
      if (g) show(room, g);
    }
  } else if (input.room === null || !generatedVsReal(input.room)) {
    lines.push("- 本物の地図はまだどのルームにも無い。地図の作り方は var/room-profiles.json の実測（大きさ・ターン数）と knowledge/tiles.json に合わせる");
  }

  // 最近の学習の記録
  const log = read(POLICY_TRAIN_LOG_PATH);
  if (log) {
    const recent = log.trim().split("\n").slice(-8).map((l) => {
      try {
        const o = JSON.parse(l) as { at: string; trigger: string | null; model?: string; generations: number; accepted: boolean; continued?: boolean; comparison: { a: number; b: number; diff: number; se: number; hazardsA: number; hazardsB: number } };
        const c = o.comparison;
        const z = c.se > 0 ? (c.diff / c.se).toFixed(1) : "-";
        return `- ${o.at.slice(5, 16)} ${o.trigger ?? "-"} ${o.model ?? "standard"}: ${o.generations} 世代${o.continued ? "（前の続きから）" : ""}、${c.a}→${c.b}（差 ${c.diff}±${c.se}、標準誤差の ${z} 倍、罠 ${c.hazardsA}→${c.hazardsB}）${o.accepted ? " 保存" : " 保存しない"}`;
      } catch {
        return null;
      }
    }).filter(Boolean);
    lines.push("", "## 最近の学習（var/policy/train-log.jsonl）", "", ...(recent as string[]));
  }
  const text = lines.join("\n");
  writeFileSync(path.join(dir, "report.md"), text);
  return text;
}

function defaultAsk(prompt: string, timeoutMs: number, stop: () => boolean): Promise<AskResult> {
  const promptFile = path.join(AGENT_DIR, "prompts", "lab-coach.md");
  const session = new ClaudeSession({
    model: getSetting("LAB_COACH_MODEL") || getSetting("LLM_MODEL_NAME") || undefined,
    effort: getSetting("LAB_COACH_EFFORT") || getSetting("LLM_MODEL_EFFORT") || undefined,
    context: "evolution",
    label: "lab",
    tools: AGENT_WORK_TOOLS,
    appendSystemPrompt: existsSync(promptFile) ? readFileSync(promptFile, "utf-8") : "あなたは学習の LLM。学習環境を直す。",
  });
  session.start();
  const watch = setInterval(() => {
    if (stop()) session.kill();
  }, 1000);
  return session.ask(prompt, timeoutMs).finally(async () => {
    clearInterval(watch);
    await session.stop().catch(() => {});
  });
}

/** 学習の LLM を1回動かす（lab.ts から。学習の仕事の続きとして同じ枠で動く） */
export async function runLabCoach(input: CoachInput, deps: CoachDeps = {}): Promise<CoachResult> {
  // 評価関数を書き換えている間に始まった試合は、書き換える前の評価関数を使う（post-match-queue.ts）
  const real = !deps.paths?.evaluator || deps.paths.evaluator === EVALUATOR_PATH;
  if (real) beginEvaluatorEdit();
  try {
    return await runLabCoachInner(input, deps);
  } finally {
    if (real) endEvaluatorEdit();
  }
}

async function runLabCoachInner(input: CoachInput, deps: CoachDeps): Promise<CoachResult> {
  const startedAt = new Date().toISOString();
  const files = {
    evaluator: deps.paths?.evaluator ?? EVALUATOR_PATH,
    profiles: deps.paths?.profiles ?? SIM_PROFILES_PATH,
    trainConfig: deps.paths?.trainConfig ?? TRAIN_CONFIG_PATH,
    styles: deps.paths?.styles ?? POLICY_STYLES_PATH,
    review: deps.paths?.review ?? AGENT_REVIEW_PATH,
  };
  const dir = deps.paths?.dir ?? path.join(LAB_COACH_DIR, startedAt.replace(/[:.]/g, "-"));
  const report = writeCoachReport(input, dir);
  const before = { evaluator: read(files.evaluator), profiles: read(files.profiles), trainConfig: read(files.trainConfig), styles: read(files.styles) };
  const stop = deps.shouldStop ?? (() => false);
  const guard = deps.guard === false ? null : snapshotProtectedFiles();
  const rel = (f: string) => path.relative(PROJECT_ROOT, f);

  const policy = activePolicyPrompt();
  const prompt = [
    "[LAB] 方策の学習が終わった。あなたは学習の LLM（試合中の LLM とは別）。学習の結果を読み、学習環境を直せ。",
    `統計: ${rel(path.join(dir, "report.md"))}（下に同じ内容）/ 再生の記録: ${rel(path.join(dir, "traces.json"))}`,
    "",
    report,
    "",
    "## 直してよいもの",
    `- 評価関数 \`${rel(files.evaluator)}\`（方策が何を狙い、どれだけ遠回りするか。新しい特徴は PARAM_SPACE に重みを足す）。比べ方: \`bun src/cli.ts bench --room <n> --evaluator <改修前の写し>\`（両方とも学習したパラメータで打つので、init だけの改修は差が出ない。init を比べるなら --init）`,
    `- 地図の作り方 \`${rel(files.profiles)}\`（本物の地図・実測に似せる。易しくするための変更はしない）`,
    `- 学習のやり方 \`${rel(files.trainConfig)}\`（候補・地図・確かめの数、探す幅）`,
    `- モデル \`${rel(files.styles)}\`（特性ごとのモデルを足す・目的を直す。前からあるモデルは消さない。${MAX_STYLES} 個まで）`,
    ...(policy ? ["", policy, "モデル（styles.json の目的・動かさないパラメータ）と学習のやり方は、この方針で試合が良くなる向きに直す（例: 敵に当てに行く方針なら、ハンターが寄って当てられるか・当てられすぎないかを見る）。", ""] : []),
    "ほか（src/ のハーネス）を変えても元に戻される。ハーネスの不具合・ハーネスでしか直らないことに気づいたら、直さずに報告の「## ハーネスへの要望」に書く（agent/REVIEW.md に載り、開発者が直す）。",
    "",
    "## 最後に",
    "何を見て、何を直したか（直さなかったならその理由）を5行以内で報告する。ハーネスへの要望があれば、その後に「## ハーネスへの要望」の節を付ける（無ければ付けない）。",
  ].join("\n");

  const timeoutMs = numSetting("LAB_COACH_TIMEOUT_MIN", { min: 1 }) * 60_000;
  let res: AskResult;
  try {
    res = await (deps.ask ? deps.ask(prompt, timeoutMs) : defaultAsk(prompt, timeoutMs, stop));
  } catch (err) {
    res = { status: "dead", error: err instanceof Error ? err.message : String(err) };
  }
  const reverted = guard ? restoreProtectedFiles(guard) : [];
  const restore = (file: string, content: string | null) => {
    if (content !== null) writeFileSync(file, content);
  };
  const changes: CoachChange[] = [];
  const stopped = stop();

  if (stopped) {
    // 試合が始まった等: 確かめていない改修は全部戻す
    for (const k of ["evaluator", "profiles", "trainConfig", "styles"] as const) if (read(files[k]) !== before[k]) restore(files[k], before[k]);
  } else {
    // モデル（特性）: 足す・目的を直す。前からあるモデルは消さない。新しいモデルは次の学習（合間の学習が順に育てる）から
    if (read(files.styles) !== before.styles) {
      const problem = stylesProblem(read(files.styles), before.styles);
      if (problem) {
        restore(files.styles, before.styles);
        changes.push({ what: "styles", accepted: false, detail: `戻した（${problem}）` });
      } else {
        const ids = (t: string | null) => ((JSON.parse(t ?? '{"styles":[]}') as { styles: { id: string }[] }).styles ?? []).map((s) => s.id);
        const added = ids(read(files.styles)).filter((id) => !ids(before.styles).includes(id));
        changes.push({ what: "styles", accepted: true, detail: added.length ? `モデルを足した: ${added.join(", ")}` : "モデルの定義を直した" });
      }
    }
    // 学習のやり方
    if (read(files.trainConfig) !== before.trainConfig) {
      const { config, problems } = loadTrainConfig(files.trainConfig);
      if (problems.length > 0) {
        restore(files.trainConfig, before.trainConfig);
        changes.push({ what: "trainConfig", accepted: false, detail: `戻した（${problems.join("、")}）` });
      } else {
        const prev = before.trainConfig ? loadTrainConfigFromText(before.trainConfig) : null;
        const diff = prev ? (Object.keys(config) as (keyof typeof config)[]).filter((k) => prev[k] !== config[k]).map((k) => `${k} ${prev[k]}→${config[k]}`).join("、") : JSON.stringify(config);
        changes.push({ what: "trainConfig", accepted: true, detail: diff || "値は同じ" });
      }
    }
    // 地図の作り方
    if (read(files.profiles) !== before.profiles) {
      const rooms = [...new Set([null, input.room, ...roomsWithRealMaps()])];
      const problem = profilesProblem(rooms);
      if (problem) {
        restore(files.profiles, before.profiles);
        changes.push({ what: "profiles", accepted: false, detail: `戻した（地図が作れない: ${problem}）` });
      } else {
        // 本物の地図があるルームで、作った地図が本物から遠ざかっていないか
        const afterDist = new Map(roomsWithRealMaps().map((r) => [r, generatedVsReal(r)?.distance ?? 0]));
        const now = read(files.profiles);
        restore(files.profiles, before.profiles);
        const beforeDist = new Map(roomsWithRealMaps().map((r) => [r, generatedVsReal(r)?.distance ?? 0]));
        if (now !== null) writeFileSync(files.profiles, now);
        const worse = [...afterDist].filter(([r, d]) => d > (beforeDist.get(r) ?? 0) + 0.02);
        const detail = [...afterDist].map(([r, d]) => `ルーム ${r}: ${(beforeDist.get(r) ?? 0).toFixed(3)}→${d.toFixed(3)}`).join("、");
        if (worse.length > 0) {
          restore(files.profiles, before.profiles);
          changes.push({ what: "profiles", accepted: false, detail: `戻した（本物の地図から遠ざかった: ${detail}）` });
        } else {
          changes.push({ what: "profiles", accepted: true, detail: detail ? `本物との違い ${detail}` : "地図が作れることを確かめた（比べる本物の地図はまだ無い）" });
        }
      }
    }
    // 評価関数
    if (before.evaluator !== null && read(files.evaluator) !== before.evaluator) {
      const gate = await (deps.gateEvaluator ?? gateEvaluatorChange)(before.evaluator, input.room);
      const c = gate.comparison;
      const detail = c ? `改修前 ${c.a} → 改修後 ${c.b} 点/ターン（差 ${c.diff}±${c.se}、勝ち ${c.wins}/${c.n}、罠 ${c.hazardsA}→${c.hazardsB}）` : `比べられなかった: ${gate.error}`;
      if (!gate.ok) restore(files.evaluator, before.evaluator);
      changes.push({ what: "evaluator", accepted: gate.ok, detail: gate.ok ? `採用: ${detail}` : `戻した: ${detail}` });
    }
  }

  // ハーネスへの要望（評価関数・地図・学習のやり方では直らないこと）→ agent/REVIEW.md（開発者が読む）
  const requests = res.status === "ok" ? harnessRequests(res.text) : null;
  if (requests && !stopped) {
    try {
      appendReview({ runId: `学習の LLM ${rel(dir)}`, room: input.room ?? 0, model: input.model ?? null, text: `### 学習の LLM からの要望\n${requests}` }, files.review);
      changes.push({ what: "review", accepted: true, detail: "ハーネスへの要望を agent/REVIEW.md に書いた" });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ハーネスへの要望を書けなかった");
    }
  }

  const result: CoachResult = {
    status: stopped ? "stopped" : res.status === "ok" ? "ok" : res.status === "timeout" ? "timeout" : "dead",
    summary: res.status === "ok" ? res.text.trim().slice(0, 2000) : res.status === "dead" ? `止まった: ${res.error}` : res.status === "timeout" ? "時間切れ（それまでの改修を確かめた）" : "",
    changes,
    reverted,
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger: input.trigger,
    dir: rel(dir),
    ...(input.model ? { model: input.model } : {}),
    room: input.room,
    gap: input.gap ? { policy: input.gap.policy, reference: input.gap.reference, ratio: input.gap.ratio, knowledgeGap: input.gap.knowledgeGap, searchGap: input.gap.searchGap } : null,
  };
  try {
    const logFile = deps.paths?.log ?? LAB_COACH_LOG_PATH;
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(result)}\n`);
    writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "学習の LLM の記録に失敗");
  }
  return result;
}

function loadTrainConfigFromText(text: string): Record<string, number> | null {
  try {
    return JSON.parse(text) as Record<string, number>;
  } catch {
    return null;
  }
}

/** 最近の学習の LLM の結果（新しい順） */
export function readCoachLog(limit = 10, file = LAB_COACH_LOG_PATH): CoachResult[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l) as CoachResult;
      } catch {
        return null;
      }
    })
    .filter((x): x is CoachResult => x !== null)
    .reverse();
}
