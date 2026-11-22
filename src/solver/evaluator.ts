import { getTileInfo } from "../memory/world-map";

/**
 * 経路探索（src/solver/planner.ts）の評価関数。**エージェントが試合後に改修してよい**（ソルバーと同じ扱い）。
 *
 * - 探索の仕組み（ダイクストラ・ビームサーチ・手の選び方）は planner.ts（ハーネス側）。ここは「マスの価値」「通る手間」と、その重みだけを決める。
 * - PARAM_SPACE の数値は学習（`bun src/cli.ts train`、試合後にも自動）で調整され、var/policy/params.json に入る。ここに書くのは初期値と範囲。
 * - 新しい特徴を足す時は、PARAM_SPACE に重みを足し、targetValue / stepCost でそれを使う（学習が自動で重みを合わせる）。
 * - 採否はシミュレータの成績（`bun src/cli.ts bench`）で決まる。弱くなった改修は元に戻される。
 */

export interface ParamSpec {
  init: number;
  min: number;
  max: number;
  integer?: boolean;
  doc: string;
}

export const PARAM_SPACE = {
  distWeight: { init: 1, min: 0.3, max: 3, doc: "経路の手間（1歩=10）をどれだけ重く見るか" },
  unknownValue: { init: 12, min: 0, max: 120, doc: "見えていないマス1つの見込みの価値（フロンティアの価値 = これ × 周りの未知マス数）" },
  holeCost: { init: 20, min: 0, max: 80, doc: "穴(0)を通る追加の手間（実際の失点は -20）" },
  revisitCost: { init: 8, min: 0, max: 60, doc: "何度も通った穴を通る追加の手間（通った回数ごと、3回まで）" },
  portalValue: { init: -40, min: -400, max: 400, doc: "行き先の分からないワープ・ブラックスターを目標にする価値（正なら行き先が読めなくても使う。行き先の分かっているワープは道として使う）" },
  exitValue: { init: 300, min: 0, max: 3000, doc: "取り尽くした（ワープ以外に得になる目標が無い）時に、行き先の分からないワープを出口として目標にする価値（0 なら使わずにその場で待つ）" },
  enemyRadius: { init: 1, min: 0, max: 3, integer: true, doc: "最近見た敵のまわり何マスを通らないか" },
  directiveBonus: { init: 300, min: 0, max: 2000, doc: "メイン（LLM）が指定した目標に足す価値" },
  clusterWeight: { init: 0.25, min: 0, max: 1.5, doc: "目標のまわり（2マス以内）の点の合計を価値に足す割合" },
  candidates: { init: 10, min: 4, max: 20, integer: true, doc: "順番を考える目標の数" },
  depth: { init: 3, min: 1, max: 5, integer: true, doc: "何個先の目標まで順番を考えるか" },
  beam: { init: 6, min: 1, max: 16, integer: true, doc: "ビーム幅" },
  discount: { init: 0.985, min: 0.85, max: 1, doc: "先の目標ほど価値を割り引く率（1歩あたり）" },
  scanValue: { init: 4, min: 0, max: 40, doc: "観測で新しく見えるマス1つの価値（gr・dig を選ぶ判断）" },
  knightWeight: { init: 1, min: 0, max: 1, doc: "桂馬（CMD2、-20で2マス先）を使うか（0.5未満なら使わない）" },
  attackGain: { init: 2000, min: 0, max: 10000, doc: "隣（上下左右）の敵にアイテムを置いて当てる価値の見込み（CMD2。予定の一歩の得点＋30 より大きければ当てる。0 なら当てない）" },
} satisfies Record<string, ParamSpec>;

export type ParamName = keyof typeof PARAM_SPACE;
export type Params = Record<ParamName, number>;

export function defaultParams(): Params {
  return Object.fromEntries(Object.entries(PARAM_SPACE).map(([k, s]) => [k, s.init])) as Params;
}

/** 範囲の外・整数でない値を直す（学習・読み込みの後に必ず通す） */
export function clampParams(p: Partial<Record<string, number>>): Params {
  const out = defaultParams();
  for (const [k, spec] of Object.entries(PARAM_SPACE) as [ParamName, ParamSpec][]) {
    const v = p[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const c = Math.min(spec.max, Math.max(spec.min, v));
    out[k] = spec.integer ? Math.round(c) : c;
  }
  return out;
}

export const isPortalValue = (v: number) => (v >= 20 && v <= 23) || (v >= 30 && v <= 33) || (v >= 40 && v <= 43) || (v >= 50 && v <= 53) || (v >= 60 && v <= 63);

/** そのマスへ入った時に入る得点（実際の得点。罠は大きな負） */
export function tileGain(value: number): number {
  return getTileInfo(value).score;
}

/**
 * 経路でそのマスへ入る手間（0 以上）。null = 通らない（罠・岩盤・未知の種類・ワープ）。
 * 1歩の動作得点 -10 と、穴の -20（＋何度も通った穴の追加）を手間にする。点のあるマスは目標の価値の方で数える。
 */
export function stepCost(value: number, visitedCount: number, p: Params): number | null {
  const info = getTileInfo(value);
  if (!info.known || !info.passable || info.hazard || value >= 1000 || isPortalValue(value)) return null;
  let cost = 10;
  if (value === 0) cost += p.holeCost + p.revisitCost * Math.min(visitedCount, 3);
  else if (info.score < 0) cost += -info.score;
  return cost;
}

/**
 * 目標としての価値。gain = そのマスの得点、cluster = まわり2マス以内の正の得点の合計（自分を除く）、unknownAround = まわり3×3の未知マス数。
 * exhausted = 取り尽くした（ワープ以外に得になる目標が無い）時のワープ。0 以下なら目標にしない。
 */
export function targetValue(cell: { value: number; gain: number; cluster: number; unknownAround: number; portal: boolean; exhausted?: boolean }, p: Params): number {
  if (cell.portal) return cell.exhausted ? p.exitValue : p.portalValue;
  let v = cell.gain > 0 ? cell.gain + p.clusterWeight * cell.cluster : 0;
  if (cell.unknownAround > 0) v += p.unknownValue * cell.unknownAround;
  return v;
}
