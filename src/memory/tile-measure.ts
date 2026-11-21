/**
 * Webマップに出る公式のアイテム得点（I:）の変化から、タイルを踏んだ時の本当の得点を測る。
 *
 * - Webマップの `turn=` は残りターン数（このターンを含む）。全ターン数 N のとき、その画面はサーバの T = N + 1 − turn の
 *   手を打つ前の状態とみなす（N は「取りに行ったハーネスのターン + turn − 1」の最頻値）。
 * - 隣り合う2つの画面 a・b の得点の差 = a のターンから b の前のターンまでに踏んだタイルの得点の合計。
 *   これを「踏んだ数 × 得点」の式として並べ、未知が1種類だけの式から順に解く（解けた値は次の式で既知として使う）。
 * - 取得の途中でターンが進むなど境目がずれることがあるので、ずれ（−1・0・+1 ターン）ごとに解いて、式が一番よく揃うずれを採る。
 *   1つのタイルの推定は多数決（最頻値）で決め、推定の数が少ない・揃わないものは出さない。
 */

export interface ScoreSample {
  /** 取りに行った時のハーネスのターン */
  ourTurn: number;
  /** Webマップの `turn=`（残りターン数） */
  webTurn: number;
  /** 公式のアイテム得点（I:） */
  itemPoint: number;
}

export interface MeasureTurn {
  turn: number;
  /** このターンに踏んだタイル（番号 → 回数） */
  landed?: Record<string, number>;
  /** このターンの間に届いた Webマップの得点 */
  webScore?: ScoreSample | null;
}

export interface TileMeasurement {
  value: number;
  score: number;
  /** この値になった推定の数 */
  agree: number;
  /** 推定の総数 */
  samples: number;
}

export interface MeasureResult {
  /** 採ったずれ（ターン） */
  offset: number;
  tiles: TileMeasurement[];
  /** 使った式の数 */
  equations: number;
}

/** 1つの式に入れるターンの幅の上限（離れた画面どうしは未知が増えて解けないので使わない） */
const MAX_SPAN = 6;
/** 推定の数・揃い方の下限 */
const MIN_AGREE = 3;
const MIN_AGREE_RATIO = 0.7;

interface Equation {
  counts: Map<number, number>;
  delta: number;
}

function mode(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function buildEquations(turns: MeasureTurn[], offset: number): Equation[] {
  const samples = turns.map((t) => t.webScore).filter((s): s is ScoreSample => !!s && s.webTurn > 0);
  if (samples.length < 2) return [];
  const total = mode(samples.map((s) => s.ourTurn + s.webTurn - 1));
  if (total === null) return [];
  // 同じ画面（同じ残りターン）は最初の1つだけ使う
  const byServerTurn = new Map<number, number>();
  for (const s of samples) {
    const serverTurn = total + 1 - s.webTurn;
    if (!byServerTurn.has(serverTurn)) byServerTurn.set(serverTurn, s.itemPoint);
  }
  const points = [...byServerTurn.entries()].sort((a, b) => a[0] - b[0]);
  const landedByTurn = new Map(turns.map((t) => [t.turn, t.landed ?? {}]));
  const eqs: Equation[] = [];
  for (let i = 1; i < points.length; i++) {
    const [ta, ia] = points[i - 1]!;
    const [tb, ib] = points[i]!;
    if (tb - ta > MAX_SPAN) continue;
    const counts = new Map<number, number>();
    let missing = false;
    for (let t = ta + offset; t <= tb - 1 + offset; t++) {
      const landed = landedByTurn.get(t);
      if (!landed) {
        missing = true;
        break;
      }
      for (const [v, c] of Object.entries(landed)) if (c > 0) counts.set(Number(v), (counts.get(Number(v)) ?? 0) + c);
    }
    if (!missing) eqs.push({ counts, delta: ib - ia });
  }
  return eqs;
}

function solve(eqs: Equation[]): { tiles: TileMeasurement[]; quality: number } {
  const known = new Map<number, TileMeasurement>();
  for (let round = 0; round < 20; round++) {
    const estimates = new Map<number, number[]>();
    for (const eq of eqs) {
      const unknown = [...eq.counts.keys()].filter((v) => !known.has(v));
      if (unknown.length !== 1) continue;
      const v = unknown[0]!;
      let rest = eq.delta;
      for (const [k, c] of eq.counts) if (k !== v) rest -= known.get(k)!.score * c;
      const est = rest / eq.counts.get(v)!;
      if (Number.isInteger(est)) estimates.set(v, [...(estimates.get(v) ?? []), est]);
    }
    let added = false;
    for (const [v, ests] of estimates) {
      const m = mode(ests)!;
      const agree = ests.filter((e) => e === m).length;
      if (agree >= MIN_AGREE && agree / ests.length >= MIN_AGREE_RATIO) {
        known.set(v, { value: v, score: m, agree, samples: ests.length });
        added = true;
      }
    }
    if (!added) break;
  }
  // 何も踏まなかった区間で得点が動かなかったことも、境目が合っている証拠として数える
  const quiet = eqs.filter((eq) => eq.counts.size === 0 && eq.delta === 0).length;
  // 解けた値で全部の式が合う数（境目のずれを選ぶ基準）
  const fits = eqs.filter((eq) => {
    if (eq.counts.size === 0) return false;
    let sum = 0;
    for (const [v, c] of eq.counts) {
      const k = known.get(v);
      if (!k) return false;
      sum += k.score * c;
    }
    return sum === eq.delta;
  }).length;
  return { tiles: [...known.values()].sort((a, b) => a.value - b.value), quality: fits + quiet };
}

export function measureTileScores(turns: MeasureTurn[]): MeasureResult {
  let best: MeasureResult & { quality: number } = { offset: 0, tiles: [], equations: 0, quality: -1 };
  for (const offset of [0, -1, 1]) {
    const eqs = buildEquations(turns, offset);
    const { tiles, quality } = solve(eqs);
    if (quality > best.quality) best = { offset, tiles, equations: eqs.length, quality };
  }
  return { offset: best.offset, tiles: best.tiles, equations: best.equations };
}
