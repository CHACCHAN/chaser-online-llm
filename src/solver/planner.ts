import {
  CMD1_SPECS,
  CMD2_SPECS,
  DIR_DELTA,
  DIRS,
  type Cmd1Command,
  type Cmd2Command,
  type WorldMap,
} from "../memory/world-map";
import type * as Evaluator from "./evaluator";
import type { SolverDecision } from "./types";

/**
 * 経路探索の方策（試合中は毎フェーズ数ms で手を決める。LLM は待たない）。
 *
 * 1. 今の区画の分かっているマスで、自分から全マスへの最安経路（ダイクストラ）を出す。
 * 2. 目標の候補（点のあるマス・見えていない所に接するマス・メインの指定）を価値で選ぶ。
 * 3. 候補どうしの距離を出し、残りターンの中で「どの順に回ると一番得か」をビームサーチで探す。
 * 4. その最初の目標へ近づく手を、このフェーズで打てる手（歩く・桂馬・観測）から選ぶ。
 *
 * マスの価値・通る手間・重みは evaluator.ts（エージェントが改修してよい）と学習したパラメータで決まる。
 */

export type EvaluatorModule = typeof Evaluator;

/** メイン（LLM）からの作戦。座標は今の区画のローカル座標（pos と同じ） */
export interface Directive {
  target?: [number, number] | null;
  /** 通らないマス */
  avoid?: [number, number][];
  note?: string;
}

export interface PlanInsight {
  /** 選んだ順の目標（ローカル座標・価値・歩数） */
  route: { x: number; y: number; value: number; steps: number }[];
  /** 経路の見込み（価値 − 手間） */
  score: number;
  candidates: number;
  ms: number;
}

export interface PlannerContext {
  phase: "CMD1" | "CMD2";
  turn: number;
  /** このフェーズを含めた残りターン（不明なら null） */
  remainingTurns: number | null;
  params: Evaluator.Params;
  evaluator: EvaluatorModule;
  directive?: Directive | null;
}

const INF = Number.POSITIVE_INFINITY;

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(k: number, v: number) {
    const keys = this.keys;
    const vals = this.vals;
    let i = keys.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= k) break;
      keys[i] = keys[p]!;
      vals[i] = vals[p]!;
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop(): [number, number] {
    const keys = this.keys;
    const vals = this.vals;
    const k0 = keys[0]!;
    const v0 = vals[0]!;
    const k = keys.pop()!;
    const v = vals.pop()!;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r]! < keys[l]! ? r : l;
        if (keys[c]! >= k) break;
        keys[i] = keys[c]!;
        vals[i] = vals[c]!;
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return [k0, v0];
  }
}

/** 今の区画の地図を配列にしたもの（周りに未知の1マスの余白） */
class Board {
  readonly minX: number;
  readonly minY: number;
  readonly w: number;
  readonly h: number;
  readonly value: Int32Array;
  readonly known: Uint8Array;
  readonly visited: Uint8Array;
  readonly cost: Float64Array;
  readonly nb: Int32Array;

  constructor(wm: WorldMap, blocked: Set<string>, p: Evaluator.Params, ev: EvaluatorModule) {
    const [sx, sy] = wm.getPosition();
    let minX = sx;
    let maxX = sx;
    let minY = sy;
    let maxY = sy;
    wm.forEachKnownTile((x, y) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
    this.minX = minX - 1;
    this.minY = minY - 1;
    this.w = maxX - minX + 3;
    this.h = maxY - minY + 3;
    const n = this.w * this.h;
    this.value = new Int32Array(n);
    this.known = new Uint8Array(n);
    this.visited = new Uint8Array(n);
    this.cost = new Float64Array(n).fill(INF);
    wm.forEachKnownTile((x, y, rec) => {
      const i = this.idx(x, y);
      this.value[i] = rec.value;
      this.known[i] = 1;
      this.visited[i] = Math.min(255, rec.visitedCount);
      if (blocked.has(`${x},${y}`)) return;
      const c = ev.stepCost(rec.value, rec.visitedCount, p);
      if (c !== null) this.cost[i] = c;
    });
    // 4近傍（盤の外は -1）
    this.nb = new Int32Array(n * 4).fill(-1);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        if (y > 0) this.nb[i * 4] = i - this.w;
        if (x < this.w - 1) this.nb[i * 4 + 1] = i + 1;
        if (y < this.h - 1) this.nb[i * 4 + 2] = i + this.w;
        if (x > 0) this.nb[i * 4 + 3] = i - 1;
      }
    }
  }

  idx(x: number, y: number): number {
    const bx = x - this.minX;
    const by = y - this.minY;
    if (bx < 0 || by < 0 || bx >= this.w || by >= this.h) return -1;
    return by * this.w + bx;
  }

  xy(i: number): [number, number] {
    return [(i % this.w) + this.minX, Math.floor(i / this.w) + this.minY];
  }

  /** src から全マスへの最安の手間と歩数 */
  dijkstra(src: number): { dist: Float64Array; steps: Int32Array } {
    const n = this.w * this.h;
    const dist = new Float64Array(n).fill(INF);
    const steps = new Int32Array(n).fill(-1);
    dist[src] = 0;
    steps[src] = 0;
    const heap = new MinHeap();
    heap.push(0, src);
    while (heap.size > 0) {
      const [d, i] = heap.pop();
      if (d > dist[i]!) continue;
      for (let k = 0; k < 4; k++) {
        const j = this.nb[i * 4 + k]!;
        if (j < 0) continue;
        const c = this.cost[j]!;
        if (c === INF) continue;
        const nd = d + c;
        if (nd < dist[j]!) {
          dist[j] = nd;
          steps[j] = steps[i]! + 1;
          heap.push(nd, j);
        }
      }
    }
    return { dist, steps };
  }
}

interface Candidate {
  i: number;
  value: number;
  terminal: boolean;
}

/** 経路探索で手を決める（SolverDecision と同じ形で返す） */
export function planMove(wm: WorldMap, ctx: PlannerContext): SolverDecision & { insight: PlanInsight } {
  const t0 = performance.now();
  const { phase, params: p, evaluator: ev } = ctx;
  const [x, y] = wm.getPosition();
  const grid = wm.getLastGrid();
  const finish = (command: string, reason: string, insight: Partial<PlanInsight> = {}, extra: Partial<SolverDecision> = {}) => ({
    command: command as SolverDecision["command"],
    reason,
    confidence: 0.9,
    ...extra,
    insight: { route: [], score: 0, candidates: 0, ...insight, ms: Math.round((performance.now() - t0) * 10) / 10 },
  });

  // ワープの番号が観測の中心に出たら、着地先がまだ分からない。動かずに観測する（古い地図で動かない）
  if (grid?.[4] !== undefined && ev.isPortalValue(grid[4])) {
    return finish(phase === "CMD1" ? "gr" : wm.pickSafeFallback("CMD2"), "ワープ直後: 着地先を確かめる", {}, { triggerHarness: true, triggerReason: "PORTAL_POSITION_UNCONFIRMED" });
  }

  // 最近見た敵のまわりは通らない
  const blocked = new Set<string>();
  const enemies = wm.getEnemySightings().filter((e) => e.lastSeenTurn >= ctx.turn - 1);
  const r = Math.round(p.enemyRadius);
  for (const e of enemies) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.abs(dx) + Math.abs(dy) <= r) blocked.add(`${e.x + dx},${e.y + dy}`);
  }
  for (const e of enemies) blocked.add(`${e.x},${e.y}`);
  for (const [ax, ay] of ctx.directive?.avoid ?? []) blocked.add(`${ax},${ay}`);
  blocked.delete(`${x},${y}`);

  const board = new Board(wm, blocked, p, ev);
  const self = board.idx(x, y);
  const from0 = board.dijkstra(self);

  // 目標の候補
  const n = board.w * board.h;
  const cands: Candidate[] = [];
  const unknownAround = (i: number) => {
    const [cx, cy] = board.xy(i);
    let u = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const j = board.idx(cx + dx, cy + dy);
      if (j < 0 || !board.known[j]) u++;
    }
    return u;
  };
  const clusterAround = (i: number) => {
    const [cx, cy] = board.xy(i);
    let s = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if ((dx === 0 && dy === 0) || Math.abs(dx) + Math.abs(dy) > 2) continue;
      const j = board.idx(cx + dx, cy + dy);
      if (j < 0 || !board.known[j] || board.cost[j] === INF) continue;
      const g = ev.tileGain(board.value[j]!);
      if (g > 0) s += g;
    }
    return s;
  };
  const scored: { c: Candidate; key: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (i === self || !board.known[i]) continue;
    const portal = ev.isPortalValue(board.value[i]!);
    let d = from0.dist[i]!;
    if (portal) {
      // ワープは通れない扱いなので、隣までの距離 + 1歩
      for (let k = 0; k < 4; k++) {
        const j = board.nb[i * 4 + k]!;
        if (j >= 0 && from0.dist[j]! + 10 < d) d = from0.dist[j]! + 10;
      }
    }
    if (d === INF) continue;
    const gain = ev.tileGain(board.value[i]!);
    const ua = unknownAround(i);
    if (!portal && gain <= 0 && ua === 0) continue;
    const value = ev.targetValue({ value: board.value[i]!, gain, cluster: gain > 0 ? clusterAround(i) : 0, unknownAround: ua, portal }, p);
    if (value <= 0) continue;
    scored.push({ c: { i, value, terminal: portal }, key: value - p.distWeight * d });
  }
  // メインの指定: 分かっていて行けるマスならそこ、無理ならそれに一番近い行けるマス
  let directiveIdx = -1;
  const dt = ctx.directive?.target;
  if (dt) {
    let best = INF;
    for (let i = 0; i < n; i++) {
      if (i === self || from0.dist[i] === INF || !board.known[i]) continue;
      const [cx, cy] = board.xy(i);
      const m = Math.abs(cx - dt[0]) + Math.abs(cy - dt[1]);
      if (m < best) {
        best = m;
        directiveIdx = i;
      }
    }
    if (directiveIdx >= 0) {
      const existing = scored.find((s) => s.c.i === directiveIdx);
      if (existing) existing.c.value += p.directiveBonus;
      else scored.push({ c: { i: directiveIdx, value: p.directiveBonus, terminal: false }, key: p.directiveBonus - p.distWeight * from0.dist[directiveIdx]! });
    }
  }
  scored.sort((a, b) => b.key - a.key);
  const K = Math.round(p.candidates);
  const picked = scored.slice(0, K).map((s) => s.c);
  if (directiveIdx >= 0 && !picked.some((c) => c.i === directiveIdx)) picked.push(scored.find((s) => s.c.i === directiveIdx)!.c);

  if (picked.length === 0) return scanOrFallback(wm, ctx, board, finish);

  // 候補どうしの距離
  const from = picked.map((c) => (c.terminal ? null : board.dijkstra(c.i)));
  const distTo = (fromIdx: number | null, j: number): { d: number; s: number } => {
    const target = picked[j]!;
    const src = fromIdx === null ? from0 : from[fromIdx];
    if (!src) return { d: INF, s: -1 };
    if (!target.terminal) return { d: src.dist[target.i]!, s: src.steps[target.i]! };
    let best = { d: INF, s: -1 };
    for (let k = 0; k < 4; k++) {
      const nb = board.nb[target.i * 4 + k]!;
      if (nb >= 0 && src.dist[nb]! + 10 < best.d) best = { d: src.dist[nb]! + 10, s: src.steps[nb]! + 1 };
    }
    return best;
  };

  // 残りの歩数（CMD1・CMD2 とも1歩ずつ動ける）
  const remainingSteps = ctx.remainingTurns === null ? INF : Math.max(1, ctx.remainingTurns * 2 - (phase === "CMD2" ? 1 : 0));
  interface Node { seq: number[]; at: number | null; steps: number; score: number }
  let beam: Node[] = [{ seq: [], at: null, steps: 0, score: 0 }];
  let bestNode: Node | null = null;
  const depth = Math.max(1, Math.round(p.depth));
  const width = Math.max(1, Math.round(p.beam));
  for (let level = 0; level < depth; level++) {
    const next: Node[] = [];
    for (const node of beam) {
      if (node.at !== null && picked[node.at]!.terminal) continue;
      for (let j = 0; j < picked.length; j++) {
        if (node.seq.includes(j)) continue;
        const { d, s } = distTo(node.at, j);
        if (d === INF || node.steps + s > remainingSteps) continue;
        const steps = node.steps + s;
        const score = node.score + Math.pow(p.discount, steps) * picked[j]!.value - p.distWeight * d;
        next.push({ seq: [...node.seq, j], at: j, steps, score });
      }
    }
    if (next.length === 0) break;
    next.sort((a, b) => b.score - a.score);
    beam = next.slice(0, width);
    if (!bestNode || beam[0]!.score > bestNode.score) bestNode = beam[0]!;
  }
  if (!bestNode || bestNode.score <= 0) {
    // 得になる目標が無い: 一番近い候補へ（見えていない所を減らす）、それも無ければ観測
    const nearest = picked.map((c, j) => ({ j, d: distTo(null, j).d })).filter((e) => e.d < INF).sort((a, b) => a.d - b.d)[0];
    if (!nearest) return scanOrFallback(wm, ctx, board, finish);
    bestNode = { seq: [nearest.j], at: nearest.j, steps: distTo(null, nearest.j).s, score: 0 };
  }

  const first = picked[bestNode.seq[0]!]!;
  const toFirst = first.terminal ? null : from[bestNode.seq[0]!]!;
  const route = bestNode.seq.map((j) => {
    const [cx, cy] = board.xy(picked[j]!.i);
    return { x: cx, y: cy, value: Math.round(picked[j]!.value), steps: 0 };
  });
  let acc = 0;
  let at: number | null = null;
  for (let k = 0; k < bestNode.seq.length; k++) {
    acc += distTo(at, bestNode.seq[k]!).s;
    route[k]!.steps = acc;
    at = bestNode.seq[k]!;
  }

  // このフェーズの手: 着地先の得点 + 動作得点 − 目標までの残りの手間 が一番大きいもの
  const [fx, fy] = board.xy(first.i);
  const remainingFrom = (li: number): number => {
    if (li === first.i) return 0;
    if (toFirst) return toFirst.dist[li]!;
    // 目標がワープ: 隣のマスまでの距離
    return Math.abs(board.xy(li)[0] - fx) + Math.abs(board.xy(li)[1] - fy) === 1 ? 0 : INF;
  };
  const options: { cmd: string; score: number }[] = [];
  const specs = phase === "CMD1" ? CMD1_SPECS : CMD2_SPECS;
  for (const [cmd, spec] of Object.entries(specs) as [Cmd1Command | Cmd2Command, (typeof CMD1_SPECS)[Cmd1Command]][]) {
    const isWalk = spec.category === "walk" || (spec.category === "get_ready" && (spec.move[0] !== 0 || spec.move[1] !== 0));
    const isKnight = spec.category === "kei";
    if (!isWalk && !(isKnight && p.knightWeight >= 0.5)) continue;
    const li = board.idx(x + spec.move[0], y + spec.move[1]);
    if (li < 0 || !board.known[li]) continue;
    const landingPortal = li === first.i && first.terminal;
    if (board.cost[li] === INF && !landingPortal) continue;
    const rem = remainingFrom(li);
    if (rem === INF) continue;
    const gain = landingPortal ? 0 : ev.tileGain(board.value[li]!);
    options.push({ cmd, score: gain + spec.estActionCost - p.distWeight * rem });
  }
  options.sort((a, b) => b.score - a.score);
  const choice = options[0];
  const insight = { route, score: Math.round(bestNode.score), candidates: picked.length };
  if (!choice) return scanOrFallback(wm, ctx, board, finish);
  const routeText = route.slice(0, 3).map((r) => `(${r.x},${r.y})${r.value}`).join("→");
  const tag = directiveIdx === first.i ? "指定の目標" : first.terminal ? "ワープへ" : ev.tileGain(board.value[first.i]!) > 0 ? "回収" : "探索";
  return finish(choice.cmd, `${tag} ${routeText} 見込み${insight.score}`, insight);
}

/** 行ける目標が無い: 観測する（CMD1 は gr、CMD2 は見えていない所の多い方へ dig）か、安全な手 */
function scanOrFallback(
  wm: WorldMap,
  ctx: PlannerContext,
  board: Board,
  finish: (command: string, reason: string, insight?: Partial<PlanInsight>, extra?: Partial<SolverDecision>) => SolverDecision & { insight: PlanInsight },
): SolverDecision & { insight: PlanInsight } {
  const [x, y] = wm.getPosition();
  if (ctx.phase === "CMD1") return finish("gr", "行ける目標が無い: 観測する", {}, { confidence: 0.5 });
  let best: { cmd: string; unseen: number } | null = null;
  for (const dir of DIRS) {
    const cmd = `d${dir}` as Cmd2Command;
    const spec = CMD2_SPECS[cmd];
    const li = board.idx(x + spec.move[0], y + spec.move[1]);
    if (li < 0 || !board.known[li] || board.cost[li] === INF) continue;
    const [dx, dy] = DIR_DELTA[dir];
    let unseen = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (!wm.getTile(x + dx * 3 + ox, y + dy * 3 + oy)) unseen++;
    if (unseen * ctx.params.scanValue > 40 && (!best || unseen > best.unseen)) best = { cmd, unseen };
  }
  if (best) return finish(best.cmd, `行ける目標が無い: ${best.cmd} で先を見る`, {}, { confidence: 0.5 });
  // 分かっていて通れるマス（穴でもよい）へ一番安く動く。場外・未知のマスへは動かない（場外は -500）
  let safest: { cmd: string; cost: number } | null = null;
  for (const dir of DIRS) {
    const cmd = `w${dir}`;
    const [dx, dy] = DIR_DELTA[dir];
    const li = board.idx(x + dx, y + dy);
    if (li < 0 || !board.known[li] || board.cost[li] === INF) continue;
    if (!safest || board.cost[li]! < safest.cost) safest = { cmd, cost: board.cost[li]! };
  }
  if (safest) return finish(safest.cmd, "行ける目標が無い: 分かっている安全なマスへ", {}, { confidence: 0.3, triggerHarness: true, triggerReason: "STUCK_IN_HOLES_NO_FRONTIER" });
  return finish(wm.pickSafeFallback("CMD2"), "行ける目標が無い: 安全な手", {}, { confidence: 0.3, triggerHarness: true, triggerReason: "STUCK_IN_HOLES_NO_FRONTIER" });
}
