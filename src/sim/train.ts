import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { POLICY_CANDIDATES_DIR, POLICY_TRAIN_LOG_PATH } from "../paths";
import { clampParams, PARAM_SPACE, type ParamName, type Params, type ParamSpec } from "../solver/evaluator";
import { applyFixed, getStyle, loadModelParams, loadModelParamsFile, saveModelParams, STANDARD_MODEL, type StyleDef } from "../solver/models";
import type { EpisodeResult } from "./episode";
import type { EpisodeJob, SimPool } from "./pool";
import { addToLeague, loadOpponentPlan, type OpponentPlan } from "./opponents";
import { gaussian, makeRng } from "./rng";
import { loadTrainConfig } from "./train-config";

export { loadTrainConfig, TRAIN_CONFIG_BOUNDS, TRAIN_CONFIG_DEFAULT, type TrainConfig } from "./train-config";

/**
 * 方策の学習と比較。
 * - 目的: シミュレータでの「1ターンあたりの得点」の平均（試合の長さが違っても比べられる）。
 * - 学習: 進化戦略（パラメータを少しずつずらした候補を同じ地図で戦わせ、良い方へ平均を動かす）。最後に、学習に使っていない地図で
 *   今のパラメータと対で比べ、はっきり良い時だけ var/policy/params.json に保存する。
 */

export type PolicySpec = EpisodeJob["policy"];

export interface EvalSet {
  seeds: number[];
  /** 各 seed の地図をどのルームに似せるか（null = 一般の地図） */
  rooms: (number | null)[];
  maxTurns: number | null;
}

/** 学習用の地図の組（room があれば半分はそのルームに似せる） */
export function makeEvalSet(base: number, n: number, room: number | null, maxTurns: number | null): EvalSet {
  const seeds = Array.from({ length: n }, (_, i) => base + i);
  const rooms = seeds.map((_, i) => (room !== null && i % 2 === 0 ? room : null));
  return { seeds, rooms, maxTurns };
}

/** 地図の組から n 枚を選ぶ（組が n 枚以下なら全部） */
function sampleSet(set: EvalSet, n: number, rng: () => number, maxTurns: number | null): EvalSet {
  const idx = set.seeds.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const pick = idx.slice(0, Math.min(n, idx.length));
  return { seeds: pick.map((i) => set.seeds[i]!), rooms: pick.map((i) => set.rooms[i] ?? null), maxTurns };
}

export const perTurn = (r: EpisodeResult) => r.score / Math.max(1, r.totalTurns);

/** モデルの学習の目的（1ターンあたり）: 自分の得点 + Σ 重み × 値（knowledge/styles.json の objective）。標準は perTurn と同じ */
export function objectiveOf(style: StyleDef | null | undefined): (r: EpisodeResult) => number {
  const o = style?.objective ?? {};
  if (!Object.values(o).some((w) => w)) return perTurn;
  return (r) => (r.score + (o.item ?? 0) * r.item + (o.put ?? 0) * (r.put ?? 0) + (o.putDamage ?? 0) * (r.putDamage ?? 0) + (o.hazard ?? 0) * r.hazardHits) / Math.max(1, r.totalTurns);
}

export async function evaluatePolicy(pool: SimPool, policy: PolicySpec, set: EvalSet, opponents?: OpponentPlan): Promise<EpisodeResult[]> {
  return pool.runAll(set.seeds.map((seed, i) => ({ seed, room: set.rooms[i] ?? null, maxTurns: set.maxTurns, policy, ...(opponents ? { opponents } : {}) })));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface Comparison {
  /** 1ターンあたりの得点の平均 */
  a: number;
  b: number;
  /**
   * b − a の差（同じ地図どうし）と標準誤差。外れ値に強いよう、地図ごとの差の上下 TRIM ずつを除いた平均（刈り込み平均）と、
   * その標準誤差（ウィンザー化した標準偏差から）。相手に当てる・当てられる得点（putHit）は1回で数十ターン分の点になり、
   * 数枚の地図の当て合いで平均が大きく揺れて、良くなったかが分からなくなるため。
   */
  diff: number;
  se: number;
  /** 除かない、ふつうの平均の差（参考） */
  meanDiff?: number;
  /** b が勝った地図の数 / 全体 */
  wins: number;
  n: number;
  hazardsA: number;
  hazardsB: number;
}

/** 地図ごとの差の上下から除く割合（刈り込み平均） */
export const TRIM = 0.1;

/** 刈り込み平均と、その標準誤差（ウィンザー化した標準偏差 / ((1 − 2g)√n)） */
export function trimmedStats(d: number[], g = TRIM): { mean: number; se: number } {
  const n = d.length;
  if (n === 0) return { mean: 0, se: 0 };
  const s = [...d].sort((a, b) => a - b);
  const k = Math.floor(n * g);
  const kept = s.slice(k, n - k);
  const tm = mean(kept);
  const lo = s[k]!;
  const hi = s[n - 1 - k]!;
  const w = s.map((x) => Math.min(hi, Math.max(lo, x)));
  const wm = mean(w);
  const sw = Math.sqrt(mean(w.map((x) => (x - wm) ** 2)) * (n / Math.max(1, n - 1)));
  return { mean: tm, se: sw / ((1 - (2 * k) / n) * Math.sqrt(n)) };
}

export function compareResults(ra: EpisodeResult[], rb: EpisodeResult[], fit: (r: EpisodeResult) => number = perTurn): Comparison {
  const d = ra.map((r, i) => fit(rb[i]!) - fit(r));
  const t = trimmedStats(d);
  return {
    a: Math.round(mean(ra.map(fit)) * 10) / 10,
    b: Math.round(mean(rb.map(fit)) * 10) / 10,
    diff: Math.round(t.mean * 10) / 10,
    se: Math.round(t.se * 10) / 10,
    meanDiff: Math.round(mean(d) * 10) / 10,
    wins: d.filter((x) => x > 0).length,
    n: d.length,
    hazardsA: ra.reduce((s, r) => s + r.hazardHits, 0),
    hazardsB: rb.reduce((s, r) => s + r.hazardHits, 0),
  };
}

export async function comparePolicies(
  pool: SimPool,
  a: PolicySpec,
  b: PolicySpec,
  set: EvalSet,
  opponents: OpponentPlan = loadOpponentPlan(),
  fit: (r: EpisodeResult) => number = perTurn,
): Promise<Comparison> {
  // 比べる両方が同じ相手と戦う（相手の決め方を1回だけ読む）
  const [ra, rb] = await Promise.all([evaluatePolicy(pool, a, set, opponents), evaluatePolicy(pool, b, set, opponents)]);
  return compareResults(ra, rb, fit);
}

/** 候補ごとの、地図ごとの順位（0〜1、高いほど良い。同点は平均の順位）の平均。scores[候補][地図] */
export function rankFitness(scores: number[][]): number[] {
  const n = scores.length;
  const maps = scores[0]?.length ?? 0;
  const out = new Array<number>(n).fill(0);
  for (let j = 0; j < maps; j++) {
    const col = scores.map((s, i) => [s[j]!, i] as const).sort((a, b) => a[0] - b[0]);
    for (let r = 0; r < n; ) {
      let e = r;
      while (e + 1 < n && col[e + 1]![0] === col[r]![0]) e++;
      const rank = (r + e) / 2 / Math.max(1, n - 1);
      for (let k = r; k <= e; k++) out[col[k]![1]]! += rank / Math.max(1, maps);
      r = e + 1;
    }
  }
  return out;
}

/** b が a よりはっきり良いか（差が標準誤差の z 倍より大きく、罠を踏む回数が増えていない） */
export const clearlyBetter = (c: Comparison, z = 1.5, hazardRatio = 0, hazardSlack = 0) =>
  c.diff > 0 && c.diff > z * c.se && c.hazardsB <= c.hazardsA * (1 + hazardRatio) + hazardSlack;
/** b が a より弱くないか（差が −z×標準誤差 より上、罠も増えていない）。エージェントの改修の採否に使う */
export const notWorse = (c: Comparison, z = 1) => c.diff > -z * Math.max(c.se, 0.5) && c.hazardsB <= c.hazardsA + Math.max(2, Math.ceil(c.hazardsA * 0.1));

// --- パラメータ ⇔ 0〜1 の空間 ---
const names = Object.keys(PARAM_SPACE) as ParamName[];
const specOf = (k: ParamName) => PARAM_SPACE[k] as ParamSpec;
const toUnit = (p: Params) => names.map((k) => (p[k] - specOf(k).min) / (specOf(k).max - specOf(k).min || 1));
const fromUnit = (u: number[]) =>
  clampParams(Object.fromEntries(names.map((k, i) => [k, specOf(k).min + Math.min(1, Math.max(0, u[i]!)) * (specOf(k).max - specOf(k).min)])));

export interface TrainOptions {
  pool: SimPool;
  room: number | null;
  /** 学習に使う時間（検証を含む） */
  budgetMs: number;
  popSize?: number;
  batch?: number;
  validation?: number;
  maxTurns?: number | null;
  seed?: number;
  /** 保存しない（試すだけ） */
  dryRun?: boolean;
  /** 記録用: 何がきっかけの学習か（manual / idle / post-match / cli） */
  trigger?: string;
  /** 学習するモデル（knowledge/styles.json の id。既定は標準 standard） */
  model?: string;
  /** この地図の組で学習する（毎世代ここから batch 枚を選ぶ）。無ければ毎世代新しい地図を作る */
  trainSet?: EvalSet;
  log?: (msg: string) => void;
  /** 世代ごとの成績（WebUI の学習曲線） */
  onGeneration?: (g: GenerationStat) => void;
  shouldStop?: () => boolean;
}

export interface GenerationStat {
  gen: number;
  /** 候補のうち最良・平均の 1ターンあたりの得点 */
  best: number;
  mean: number;
  sigma: number;
  ms: number;
  episodes: number;
}

export interface TrainResult {
  /** 学習したモデル */
  model: string;
  modelName: string;
  generations: number;
  episodes: number;
  before: Params;
  after: Params;
  comparison: Comparison;
  accepted: boolean;
  /** 前に保存しなかった学習の続きから始めたか */
  continued?: boolean;
  ms: number;
}

/** 保存しなかった学習の続き。base（その時の保存してあったパラメータ）が今と同じ時だけ続ける */
interface Candidate {
  at: string;
  base: Params;
  params: Params;
  diff: number;
  runs: number;
}
const candidatePath = (id: string) => path.join(POLICY_CANDIDATES_DIR, `${id}.json`);
export function loadCandidate(id: string, base: Params): Candidate | null {
  try {
    const c = JSON.parse(readFileSync(candidatePath(id), "utf-8")) as Candidate;
    return JSON.stringify(c.base) === JSON.stringify(base) ? c : null;
  } catch {
    return null;
  }
}
function saveCandidate(id: string, c: Candidate | null): void {
  try {
    if (!c) {
      rmSync(candidatePath(id), { force: true });
      return;
    }
    mkdirSync(POLICY_CANDIDATES_DIR, { recursive: true });
    writeFileSync(candidatePath(id), `${JSON.stringify(c, null, 2)}\n`);
  } catch {
    // 続きを残せなくても学習の結果は返す
  }
}

export async function trainPolicy(opts: TrainOptions): Promise<TrainResult> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const cfg = loadTrainConfig().config;
  const popSize = Math.max(4, opts.popSize ?? cfg.popSize);
  const batch = Math.max(2, opts.batch ?? cfg.batch);
  const valN = Math.max(4, opts.validation ?? cfg.validation);
  const maxTurns = opts.maxTurns === undefined ? 200 : opts.maxTurns;
  const rng = makeRng(opts.seed ?? Date.now());
  const style = getStyle(opts.model ?? STANDARD_MODEL);
  const fit = objectiveOf(style);
  const fixed = (p: Params) => applyFixed(p, style);
  // 標準以外のモデルは目的が得点と違う（例: ハンターは当てた得点を2倍に数える）
  const unit = style.id === STANDARD_MODEL ? "点/ターン" : `（${style.name}の目的）/ターン`;
  const before = loadModelParams(style.id);
  // 相手（自己対戦の「自分」は学習を始めた時のパラメータ＝before と、前に採用したもの）。学習の間は変えない
  const opponents = loadOpponentPlan(style.id);
  // 前に保存しなかった学習の続きがあれば、そこから続ける（少しずつの良さを捨てずに積み上げる。比べる相手は保存してある before のまま）
  const cand = opts.dryRun ? null : loadCandidate(style.id, before);
  let m = toUnit(cand ? fixed(cand.params) : before);
  if (cand) log(`前に保存しなかった学習の続きから始める（${cand.runs} 回目の続き、前の確かめの差 ${cand.diff}）`);
  let sigma = cfg.sigmaStart;
  const d = m.length;
  const mu = Math.floor(popSize / 2);
  const w = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
  const wsum = w.reduce((a, b) => a + b, 0);
  let gen = 0;
  let episodes = 0;
  // 検証にかかる時間の見込み（最初の世代の時間から）
  let genMs = 0;
  const seedBase = Math.floor(rng() * 1e9);

  while (!opts.shouldStop?.()) {
    const elapsed = Date.now() - t0;
    const valCost = genMs * ((valN * 2) / (popSize * batch)) + 2000;
    if (gen > 0 && elapsed + genMs + valCost > opts.budgetMs) break;
    const g0 = Date.now();
    const set = opts.trainSet ? sampleSet(opts.trainSet, batch, rng, maxTurns) : makeEvalSet(seedBase + gen * 1000, batch, opts.room, maxTurns);
    // 対称な候補（+ε と −ε）で雑音を減らす
    const eps: number[][] = [];
    for (let i = 0; i < popSize / 2; i++) {
      const e = Array.from({ length: d }, () => gaussian(rng));
      eps.push(e, e.map((x) => -x));
    }
    const cands = eps.map((e) => fixed(fromUnit(m.map((v, i) => v + sigma * e[i]!))));
    const results = await Promise.all(cands.map((params) => evaluatePolicy(opts.pool, { kind: "planner", params }, set, opponents)));
    episodes += popSize * batch;
    const fitness = results.map((rs) => mean(rs.map(fit)));
    // 候補の順位は、地図ごとの順位の平均で決める（1枚の当て合いの大きな点で順位が決まらないように）
    const rankFit = rankFitness(results.map((rs) => rs.map(fit)));
    const order = rankFit.map((f, i) => [f, i] as const).sort((a, b) => b[0] - a[0]);
    const next = m.map((v, j) => v + sigma * order.slice(0, mu).reduce((s, [, i], r) => s + (w[r]! / wsum) * eps[i]![j]!, 0));
    m = next.map((v) => Math.min(1, Math.max(0, v)));
    // 探す幅は時間とともに狭める（最初は広く、最後は細かく）
    sigma = cfg.sigmaStart - (cfg.sigmaStart - cfg.sigmaEnd) * Math.min(1, (Date.now() - t0) / Math.max(1, opts.budgetMs));
    genMs = Date.now() - g0;
    gen += 1;
    const bestRaw = fitness[order[0]![1]]!;
    opts.onGeneration?.({ gen, best: Math.round(bestRaw * 10) / 10, mean: Math.round(mean(fitness) * 10) / 10, sigma, ms: genMs, episodes });
    log(`世代${gen}: 順位が一番の候補 ${bestRaw.toFixed(1)} / 平均 ${mean(fitness).toFixed(1)} ${unit}（σ=${sigma.toFixed(3)}、${(genMs / 1000).toFixed(1)}秒）`);
  }

  const after = fixed(fromUnit(m));
  let comparison: Comparison = { a: 0, b: 0, diff: 0, se: 0, wins: 0, n: 0, hazardsA: 0, hazardsB: 0 };
  // 1世代も回らなかった（すぐ止めた）時は確かめない
  if (gen > 0) {
    const val = makeEvalSet(900_000 + Math.floor(rng() * 1e6), valN, opts.room, maxTurns);
    comparison = await comparePolicies(opts.pool, { kind: "planner", params: before }, { kind: "planner", params: after }, val, opponents, fit);
    episodes += valN * 2;
  }
  const accepted = gen > 0 && clearlyBetter(comparison, cfg.acceptZ, cfg.hazardRatio, cfg.hazardSlack);
  // 保存しなかったが前より良さそうなら、続きとして残す。保存した・悪くなった時は消す
  if (gen > 0 && !opts.dryRun) {
    saveCandidate(style.id, !accepted && comparison.diff > 0 ? { at: new Date().toISOString(), base: before, params: after, diff: comparison.diff, runs: (cand?.runs ?? 0) + 1 } : null);
  }
  if (gen > 0) log(`検証（学習に使っていない ${valN} 地図）: ${style.name}: 前 ${comparison.a} → 後 ${comparison.b} ${unit}（差 ${comparison.diff}±${comparison.se}、勝ち ${comparison.wins}/${comparison.n}）→ ${accepted ? "採用" : "見送り"}`);
  if (accepted && !opts.dryRun) {
    const prev = loadModelParamsFile(style.id);
    // 自己対戦: 置き換わる前のパラメータを相手の控え（リーグ）に残す。次からの学習で「前の自分」として戦う
    addToLeague(before, `${style.name}: ${new Date().toISOString().slice(0, 16)} まで使っていたパラメータ（${prev?.source ?? "default"}）`, cfg.leagueSize);
    saveModelParams(style.id, after, "train", {
      perTurn: comparison.b,
      previousPerTurn: comparison.a,
      room: opts.room ?? "all",
      generations: gen,
      previousSource: prev?.source ?? "default",
    });
  }
  const result: TrainResult = { model: style.id, modelName: style.name, generations: gen, episodes, before, after, comparison, accepted, continued: !!cand, ms: Date.now() - t0 };
  try {
    mkdirSync(path.dirname(POLICY_TRAIN_LOG_PATH), { recursive: true });
    appendFileSync(
      POLICY_TRAIN_LOG_PATH,
      `${JSON.stringify({ at: new Date().toISOString(), room: opts.room, generations: gen, episodes, accepted, continued: !!cand, dryRun: !!opts.dryRun, trigger: opts.trigger ?? null, model: style.id, ms: Date.now() - t0, comparison, before, after })}\n`,
    );
  } catch {
    // 記録に失敗しても学習の結果は返す
  }
  return result;
}
