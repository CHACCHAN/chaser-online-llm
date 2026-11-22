import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { POLICY_TRAIN_LOG_PATH, TRAIN_CONFIG_PATH } from "../paths";
import { clampParams, PARAM_SPACE, type ParamName, type Params, type ParamSpec } from "../solver/evaluator";
import { loadPolicyParams, loadPolicyParamsFile, savePolicyParams } from "../solver/policy";
import type { EpisodeResult } from "./episode";
import type { EpisodeJob, SimPool } from "./pool";
import { gaussian, makeRng } from "./rng";

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

export async function evaluatePolicy(pool: SimPool, policy: PolicySpec, set: EvalSet): Promise<EpisodeResult[]> {
  return pool.runAll(set.seeds.map((seed, i) => ({ seed, room: set.rooms[i] ?? null, maxTurns: set.maxTurns, policy })));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface Comparison {
  /** 1ターンあたりの得点の平均 */
  a: number;
  b: number;
  /** b − a の平均と標準誤差（同じ地図どうしの差） */
  diff: number;
  se: number;
  /** b が勝った地図の数 / 全体 */
  wins: number;
  n: number;
  hazardsA: number;
  hazardsB: number;
}

export function compareResults(ra: EpisodeResult[], rb: EpisodeResult[]): Comparison {
  const d = ra.map((r, i) => perTurn(rb[i]!) - perTurn(r));
  const m = mean(d);
  const sd = Math.sqrt(mean(d.map((x) => (x - m) ** 2)) * (d.length / Math.max(1, d.length - 1)));
  return {
    a: Math.round(mean(ra.map(perTurn)) * 10) / 10,
    b: Math.round(mean(rb.map(perTurn)) * 10) / 10,
    diff: Math.round(m * 10) / 10,
    se: Math.round((sd / Math.sqrt(Math.max(1, d.length))) * 10) / 10,
    wins: d.filter((x) => x > 0).length,
    n: d.length,
    hazardsA: ra.reduce((s, r) => s + r.hazardHits, 0),
    hazardsB: rb.reduce((s, r) => s + r.hazardHits, 0),
  };
}

export async function comparePolicies(pool: SimPool, a: PolicySpec, b: PolicySpec, set: EvalSet): Promise<Comparison> {
  const [ra, rb] = await Promise.all([evaluatePolicy(pool, a, set), evaluatePolicy(pool, b, set)]);
  return compareResults(ra, rb);
}

/** b が a よりはっきり良いか（差が標準誤差の z 倍より大きく、罠を踏む回数が増えていない） */
export const clearlyBetter = (c: Comparison, z = 1.5) => c.diff > 0 && c.diff > z * c.se && c.hazardsB <= c.hazardsA;
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
  generations: number;
  episodes: number;
  before: Params;
  after: Params;
  comparison: Comparison;
  accepted: boolean;
  ms: number;
}

/** 学習のやり方（knowledge/train-config.json）。読めない・範囲外の値は既定・範囲に収める */
export interface TrainConfig {
  popSize: number;
  batch: number;
  validation: number;
  sigmaStart: number;
  sigmaEnd: number;
}
export const TRAIN_CONFIG_DEFAULT: TrainConfig = { popSize: 16, batch: 12, validation: 24, sigmaStart: 0.15, sigmaEnd: 0.04 };
export const TRAIN_CONFIG_BOUNDS: Record<keyof TrainConfig, [number, number]> = {
  popSize: [4, 64],
  batch: [2, 48],
  validation: [8, 96],
  sigmaStart: [0.01, 0.5],
  sigmaEnd: [0.005, 0.5],
};

/** 学習のやり方を読む。problems に範囲外・読めなかった項目を返す（学習の LLM の改修の確かめに使う） */
export function loadTrainConfig(file = TRAIN_CONFIG_PATH): { config: TrainConfig; problems: string[] } {
  const problems: string[] = [];
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(file)) raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    problems.push(`読めない: ${err instanceof Error ? err.message : String(err)}`);
  }
  const config = { ...TRAIN_CONFIG_DEFAULT };
  for (const k of Object.keys(TRAIN_CONFIG_DEFAULT) as (keyof TrainConfig)[]) {
    const v = raw[k];
    if (v === undefined) continue;
    const [lo, hi] = TRAIN_CONFIG_BOUNDS[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      problems.push(`${k} が数でない`);
      continue;
    }
    if (v < lo || v > hi) problems.push(`${k}=${v} は範囲 ${lo}〜${hi} の外`);
    config[k] = Math.min(hi, Math.max(lo, v));
  }
  config.popSize = Math.max(4, Math.round(config.popSize / 2) * 2);
  config.batch = Math.round(config.batch);
  config.validation = Math.round(config.validation);
  if (config.sigmaEnd > config.sigmaStart) {
    problems.push("sigmaEnd が sigmaStart より大きい");
    config.sigmaEnd = config.sigmaStart;
  }
  return { config, problems };
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
  const before = loadPolicyParams();
  let m = toUnit(before);
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
    const cands = eps.map((e) => fromUnit(m.map((v, i) => v + sigma * e[i]!)));
    const results = await Promise.all(cands.map((params) => evaluatePolicy(opts.pool, { kind: "planner", params }, set)));
    episodes += popSize * batch;
    const fit = results.map((rs) => mean(rs.map(perTurn)));
    const order = fit.map((f, i) => [f, i] as const).sort((a, b) => b[0] - a[0]);
    const next = m.map((v, j) => v + sigma * order.slice(0, mu).reduce((s, [, i], r) => s + (w[r]! / wsum) * eps[i]![j]!, 0));
    m = next.map((v) => Math.min(1, Math.max(0, v)));
    // 探す幅は時間とともに狭める（最初は広く、最後は細かく）
    sigma = cfg.sigmaStart - (cfg.sigmaStart - cfg.sigmaEnd) * Math.min(1, (Date.now() - t0) / Math.max(1, opts.budgetMs));
    genMs = Date.now() - g0;
    gen += 1;
    opts.onGeneration?.({ gen, best: Math.round(order[0]![0] * 10) / 10, mean: Math.round(mean(fit) * 10) / 10, sigma, ms: genMs, episodes });
    log(`世代${gen}: 最良 ${order[0]![0].toFixed(1)} / 平均 ${mean(fit).toFixed(1)} 点/ターン（σ=${sigma.toFixed(3)}、${(genMs / 1000).toFixed(1)}秒）`);
  }

  const after = fromUnit(m);
  let comparison: Comparison = { a: 0, b: 0, diff: 0, se: 0, wins: 0, n: 0, hazardsA: 0, hazardsB: 0 };
  // 1世代も回らなかった（すぐ止めた）時は確かめない
  if (gen > 0) {
    const val = makeEvalSet(900_000 + Math.floor(rng() * 1e6), valN, opts.room, maxTurns);
    comparison = await comparePolicies(opts.pool, { kind: "planner", params: before }, { kind: "planner", params: after }, val);
    episodes += valN * 2;
  }
  const accepted = gen > 0 && clearlyBetter(comparison);
  if (gen > 0) log(`検証（学習に使っていない ${valN} 地図）: 前 ${comparison.a} → 後 ${comparison.b} 点/ターン（差 ${comparison.diff}±${comparison.se}、勝ち ${comparison.wins}/${comparison.n}）→ ${accepted ? "採用" : "見送り"}`);
  if (accepted && !opts.dryRun) {
    const prev = loadPolicyParamsFile();
    savePolicyParams(after, "train", {
      perTurn: comparison.b,
      previousPerTurn: comparison.a,
      room: opts.room ?? "all",
      generations: gen,
      previousSource: prev?.source ?? "default",
    });
  }
  const result: TrainResult = { generations: gen, episodes, before, after, comparison, accepted, ms: Date.now() - t0 };
  try {
    mkdirSync(path.dirname(POLICY_TRAIN_LOG_PATH), { recursive: true });
    appendFileSync(
      POLICY_TRAIN_LOG_PATH,
      `${JSON.stringify({ at: new Date().toISOString(), room: opts.room, generations: gen, episodes, accepted, dryRun: !!opts.dryRun, trigger: opts.trigger ?? null, ms: Date.now() - t0, comparison, after })}\n`,
    );
  } catch {
    // 記録に失敗しても学習の結果は返す
  }
  return result;
}
