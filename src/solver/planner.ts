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
import { moveValue as currentMoveValue } from "./evaluator";
import type { SolverDecision } from "./types";

/**
 * 経路探索の方策（試合中は毎フェーズ数ms で手を決める。LLM は待たない）。
 *
 * 1. 今の区画の分かっているマスで、自分から全マスへの最安経路（ダイクストラ）を出す。行き先の分かっているワープは道として使う
 *    （この試合で入ったもの・過去の試合の記録。WorldMap.getKnownPortalLinks）。
 * 2. 目標の候補（点のあるマス・見えていない所に接するマス・メインの指定）を価値で選ぶ。得になる目標が無い（取り尽くした）時は、
 *    行き先の分からないワープを「出口」として目標にする（価値は evaluator の targetValue の exhausted）。
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
  /** 行き先の分かっているワープ: 入口 → 着地（無ければ -1） */
  readonly portalDest: Int32Array;
  /** 着地 → そこへ飛ぶ入口（逆向きの探索用） */
  readonly portalFrom = new Map<number, number[]>();
  /** 桂馬（CMD2、間のマスを飛び越える）を経路に入れるか */
  readonly knight: boolean;

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
    this.knight = p.knightWeight >= 0.5;
    // 行き先の分かっているワープ（着地が盤の中で、通れるマスの時だけ）
    this.portalDest = new Int32Array(n).fill(-1);
    for (const l of wm.getKnownPortalLinks()) {
      const a = this.idx(l.from[0], l.from[1]);
      const b = this.idx(l.to[0], l.to[1]);
      if (a < 0 || b < 0 || a === b || !this.known[a] || !ev.isPortalValue(this.value[a]!) || this.cost[b] === INF) continue;
      if (blocked.has(`${l.from[0]},${l.from[1]}`)) continue;
      this.portalDest[a] = b;
      const list = this.portalFrom.get(b) ?? [];
      list.push(a);
      this.portalFrom.set(b, list);
    }
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
        let j = this.nb[i * 4 + k]!;
        if (j < 0) continue;
        let c = this.cost[j]!;
        if (c === INF) {
          // 行き先の分かっているワープ: 入った1歩で着地へ
          const to = this.portalDest[j]!;
          if (to < 0) continue;
          j = to;
          c = PORTAL_STEP_COST;
        }
        const nd = d + c;
        if (nd < dist[j]!) {
          dist[j] = nd;
          steps[j] = steps[i]! + 1;
          heap.push(nd, j);
        }
      }
      // 桂馬: 間のマス（奈落の帯・ジオードの囲みなど）を飛び越える
      if (this.knight) {
        const [x, y] = this.xy(i);
        for (const [dx, dy] of KNIGHT_MOVES) {
          const j = this.idx(x + dx, y + dy);
          if (j < 0 || this.cost[j] === INF) continue;
          const nd = d + this.cost[j]! + KNIGHT_EXTRA_COST;
          if (nd < dist[j]!) {
            dist[j] = nd;
            steps[j] = steps[i]! + 1;
            heap.push(nd, j);
          }
        }
      }
    }
    return { dist, steps };
  }

  /** 全マスから dst（複数なら一番近いもの）までの最安の手間（ワープは一方通行なので、逆向きにたどる） */
  dijkstraTo(dsts: number | number[]): Float64Array {
    const n = this.w * this.h;
    const dist = new Float64Array(n).fill(INF);
    const heap = new MinHeap();
    const list = typeof dsts === "number" ? [dsts] : dsts;
    for (const d of list) {
      dist[d] = 0;
      heap.push(0, d);
    }
    const dst = list.length === 1 ? list[0]! : -1;
    while (heap.size > 0) {
      const [d, u] = heap.pop();
      if (d > dist[u]!) continue;
      // u へ1歩で入れるマス v（v→u の手間は u に入る手間）
      const cu = this.cost[u]!;
      if (cu !== INF) {
        for (let k = 0; k < 4; k++) {
          const v = this.nb[u * 4 + k]!;
          if (v < 0 || (this.cost[v] === INF && v !== dst)) continue;
          if (d + cu < dist[v]!) {
            dist[v] = d + cu;
            heap.push(d + cu, v);
          }
        }
      }
      // u へ桂馬で飛べるマス
      if (this.knight && cu !== INF) {
        const [ux, uy] = this.xy(u);
        for (const [dx, dy] of KNIGHT_MOVES) {
          const v = this.idx(ux - dx, uy - dy);
          if (v < 0 || this.cost[v] === INF) continue;
          const nd = d + cu + KNIGHT_EXTRA_COST;
          if (nd < dist[v]!) {
            dist[v] = nd;
            heap.push(nd, v);
          }
        }
      }
      // u に着くワープの入口の隣
      for (const a of this.portalFrom.get(u) ?? []) {
        for (let k = 0; k < 4; k++) {
          const v = this.nb[a * 4 + k]!;
          if (v < 0 || this.cost[v] === INF) continue;
          if (d + PORTAL_STEP_COST < dist[v]!) {
            dist[v] = d + PORTAL_STEP_COST;
            heap.push(d + PORTAL_STEP_COST, v);
          }
        }
      }
    }
    return dist;
  }
}

/** 全マスから、ワープ（入ると飛ぶマス）の隣までの最安の手間（隣が 0）。隣が無ければ全部 INF */
function toPortal(board: Board, portal: number): Float64Array {
  const nbs: number[] = [];
  for (let k = 0; k < 4; k++) {
    const nb = board.nb[portal * 4 + k]!;
    if (nb >= 0 && board.cost[nb] !== INF) nbs.push(nb);
  }
  return nbs.length ? board.dijkstraTo(nbs) : new Float64Array(board.w * board.h).fill(INF);
}

/** ワープに入る1歩の手間（歩く1歩と同じ） */
const PORTAL_STEP_COST = 10;
/** 桂馬の動き（CMD2 の keilu・keiru・keild・keird）。歩く手より 10 多くかかる（-20） */
const KNIGHT_MOVES: [number, number][] = [[-1, -2], [1, -2], [-1, 2], [1, 2]];
const KNIGHT_EXTRA_COST = 10;

interface Candidate {
  i: number;
  value: number;
  terminal: boolean;
}

/** 敵ごとの、自分からの歩数の記録（試合ごとの WorldMap に付ける。区画が変わっても歩数は変わらない） */
const enemyTracks = new WeakMap<WorldMap, Map<number, [number, number][]>>();

/**
 * 一番近い敵が追ってきているか: 直近 3 ターン、近く（4 歩以内）に居続けて離れていない。
 * （近づいてきた回数で見る決め方も試したが、隣に張り付いて当て合う相手を見逃して当てられる回数が増えた）
 */
function nearestEnemyInfo(wm: WorldMap, turn: number, x: number, y: number): { chasing: boolean } {
  const tracks = enemyTracks.get(wm) ?? new Map<number, [number, number][]>();
  enemyTracks.set(wm, tracks);
  let best: { d: number; chasing: boolean } | null = null;
  for (const e of wm.getEnemySightings()) {
    if (e.lastSeenTurn < turn - 1) continue;
    const d = Math.abs(e.x - x) + Math.abs(e.y - y);
    const t = tracks.get(e.tileId) ?? [];
    if (t.length === 0 || t[t.length - 1]![0] !== turn) t.push([turn, d]);
    else t[t.length - 1]![1] = Math.min(t[t.length - 1]![1], d);
    while (t.length > 4) t.shift();
    tracks.set(e.tileId, t);
    const recent = t.filter(([tt]) => tt >= turn - 3);
    const chasing = recent.length >= 3 && recent.every(([, dd]) => dd <= 4) && recent[recent.length - 1]![1] <= recent[0]![1];
    if (!best || d < best.d) best = { d, chasing };
  }
  return { chasing: best?.chasing ?? false };
}

/** ターンごとのアイテムの得点の見込み（試合ごとの WorldMap に付ける。出口のワープの周回を見つける用） */
const itemHistory = new WeakMap<WorldMap, Map<number, number>>();

/**
 * 出口のワープ（行き先の分からないワープ）を目標にしてよいか。直近 40 ターンに 3 回以上ワープしたのに、
 * 最初のワープの時からアイテムの得点が増えていなければ、ワープを回っているだけなので使わない
 * （学習の LLM の要望 2026-11-23: 4 ターンごとに同じ所へ戻り、そのたびに狙う相手に当てられた）。
 */
const warpTurns = new WeakMap<WorldMap, { seg: unknown; turns: number[] }>();
function exitsAllowed(wm: WorldMap, turn: number): boolean {
  const hist = itemHistory.get(wm) ?? new Map<number, number>();
  itemHistory.set(wm, hist);
  const item = wm.getStats().estimatedItemScore;
  if (!hist.has(turn)) hist.set(turn, item);
  for (const t of hist.keys()) if (t < turn - 60) hist.delete(t);
  // ワープした回数は区画が変わった回数で数える（同じワープを何度も通ると、ワープのつながりは1本のままで数が増えない。
  // 2026-11-23 room720 の試合で T733〜 ずっと同じワープを出入りしていた）
  const w = warpTurns.get(wm) ?? { seg: wm.getSegmentId(), turns: [] as number[] };
  warpTurns.set(wm, w);
  const seg = wm.getSegmentId();
  if (seg !== w.seg) {
    w.seg = seg;
    if (w.turns[w.turns.length - 1] !== turn) w.turns.push(turn);
  }
  while (w.turns.length && w.turns[0]! < turn - 40) w.turns.shift();
  const warps = [...w.turns, ...wm.getWarpLinks().filter((l) => l.observedTurn >= turn - 40).map((l) => l.observedTurn)];
  if (new Set(warps).size < 3) return true;
  const first = Math.min(...warps);
  const then = [...hist.entries()].filter(([t]) => t <= first).sort((a, b) => b[0] - a[0])[0]?.[1];
  return then === undefined || item > then;
}

/** 経路探索で手を決める（SolverDecision と同じ形で返す）。CMD2 で隣に敵がいれば、当てる価値と比べてアイテムを置いて当てる */
export function planMove(wm: WorldMap, ctx: PlannerContext): SolverDecision & { insight: PlanInsight } {
  const d = planRoute(wm, ctx);
  if (ctx.phase !== "CMD2" || ctx.params.attackGain <= 0) return d;
  const attack = pickAttack(wm, ctx, d);
  return attack ?? d;
}

/**
 * 隣（上下左右）に今のターンに自分の観測で見えた敵がいれば（Webマップの位置は使わない。ワープの後に位置合わせがずれると、斜め隣の敵を隣と思って
 * 当たらない手を出し続けたことがある。学習の LLM の要望 2026-11-23）、その向きにアイテムを置く手（p*3s*。-30、置いた後に横へ1マス動く）。
 * 動いた先が分かっていて通れる（罠・ワープでない）時だけ。当てる手と予定の一歩を評価関数の moveValue で比べ（当てる手の得点は attackGain。
 * 予定の一歩は着地が敵の近くなら dangerCost を引く）、当てる手が 30 より大きく上回る時に選ぶ。
 */
function pickAttack(wm: WorldMap, ctx: PlannerContext, planned: SolverDecision & { insight: PlanInsight }): (SolverDecision & { insight: PlanInsight }) | null {
  const { params: p, evaluator: ev } = ctx;
  const [x, y] = wm.getPosition();
  const plannedSpec = CMD2_SPECS[planned.command as Cmd2Command];
  const plannedTile = plannedSpec ? wm.getTile(x + plannedSpec.move[0], y + plannedSpec.move[1]) : undefined;
  const plannedGain = plannedTile ? Math.max(0, ev.tileGain(plannedTile.value)) : 0;
  if (p.attackGain <= plannedGain + 30) return null;
  const moveValue = (ev as Partial<EvaluatorModule>).moveValue ?? currentMoveValue;
  const enemies = wm.getEnemySightings().filter((e) => e.lastSeenTurn >= ctx.turn - 1);
  const enemyDist = (tx: number, ty: number) => (enemies.length ? Math.min(...enemies.map((e) => Math.abs(e.x - tx) + Math.abs(e.y - ty))) : Infinity);
  const enemyNow = enemyDist(x, y);
  const { chasing } = nearestEnemyInfo(wm, ctx.turn, x, y);
  const plannedScore = plannedSpec
    ? moveValue({ phase: "CMD2", cmd: planned.command, gain: plannedGain, actionCost: plannedSpec.estActionCost, remaining: 0, enemyDist: enemyDist(x + plannedSpec.move[0], y + plannedSpec.move[1]), enemyNow, chasing }, p)
    : plannedGain;
  for (const e of wm.getLocalEnemySightings()) {
    if (e.lastSeenTurn < ctx.turn || Math.abs(e.x - x) + Math.abs(e.y - y) !== 1) continue;
    const dir = DIRS.find((k) => DIR_DELTA[k][0] === e.x - x && DIR_DELTA[k][1] === e.y - y)!;
    const cmd = (Object.keys(CMD2_SPECS) as Cmd2Command[]).find((c) => CMD2_SPECS[c].put3Dir === dir && CMD2_SPECS[c].obsShape === "ray");
    if (!cmd) continue;
    const mv = CMD2_SPECS[cmd].move;
    const dest = wm.getTile(x + mv[0], y + mv[1]);
    if (!dest || dest.offField || ev.isPortalValue(dest.value) || ev.stepCost(dest.value, dest.visitedCount, p) === null) continue;
    // 当てる手は、当て返される見込みを引かない（隣にいれば、離れても次のターンに当てられうる。当て合いは当てる方が得）
    const score = moveValue({ phase: "CMD2", cmd, gain: p.attackGain, actionCost: CMD2_SPECS[cmd].estActionCost, remaining: 0, enemyDist: Infinity, enemyNow, chasing }, p);
    if (score <= plannedScore + 30) continue;
    return { ...planned, command: cmd, reason: `隣の敵 (${e.x},${e.y}) にアイテムを置いて当てる（見込み ${Math.round(score)}）` };
  }
  return null;
}

function planRoute(wm: WorldMap, ctx: PlannerContext): SolverDecision & { insight: PlanInsight } {
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
  /** 行き先の分からないワープ（取り尽くした時の出口の候補）: 入口と、そこまでの手間 */
  const exits: { i: number; d: number }[] = [];
  const exitsOk = exitsAllowed(wm, ctx.turn);
  for (let i = 0; i < n; i++) {
    if (i === self || !board.known[i]) continue;
    const portal = ev.isPortalValue(board.value[i]!);
    if (portal && board.portalDest[i]! >= 0) continue;
    let d = from0.dist[i]!;
    if (portal) {
      // ワープは通れない扱いなので、隣までの距離 + 1歩
      for (let k = 0; k < 4; k++) {
        const j = board.nb[i * 4 + k]!;
        if (j >= 0 && from0.dist[j]! + 10 < d) d = from0.dist[j]! + 10;
      }
    }
    if (d === INF) continue;
    if (portal && exitsOk) exits.push({ i, d });
    const gain = ev.tileGain(board.value[i]!);
    const ua = unknownAround(i);
    if (!portal && gain <= 0 && ua === 0) continue;
    const value = ev.targetValue({ value: board.value[i]!, gain, cluster: gain > 0 ? clusterAround(i) : 0, unknownAround: ua, portal }, p);
    if (value <= 0) continue;
    scored.push({ c: { i, value, terminal: portal }, key: value - p.distWeight * d });
  }
  // 取り尽くした（ワープ以外に得になる目標が無い）: 行き先の分からないワープを出口として目標にする
  if (!scored.some((s) => !s.c.terminal && s.c.value > 0)) {
    for (const e of exits) {
      const value = ev.targetValue({ value: board.value[e.i]!, gain: 0, cluster: 0, unknownAround: 0, portal: true, exhausted: true }, p);
      if (value > 0 && !scored.some((s) => s.c.i === e.i)) scored.push({ c: { i: e.i, value, terminal: true }, key: value - p.distWeight * e.d });
    }
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
    // 得になる目標が無い: 行き先の分からないワープ（出口）があればそこへ。無ければ一番近い候補へ（見えていない所を減らす）、
    // それも無ければ観測。直近に立った所は候補から外す（2マスの行ったり来たりを防ぐ）
    const recent = new Set(wm.getRecentTrail(6).map(([tx, ty]) => board.idx(tx, ty)));
    const exitValue = ev.targetValue({ value: 0, gain: 0, cluster: 0, unknownAround: 0, portal: true, exhausted: true }, p);
    const usable = picked.map((c, j) => ({ c, j, d: distTo(null, j).d })).filter((e) => e.d < INF && !recent.has(e.c.i));
    const exit = exitValue > 0 ? exits.filter((e) => !recent.has(e.i)).sort((a, b) => a.d - b.d)[0] : undefined;
    if (exit && !usable.some((e) => e.c.terminal && e.c.i === exit.i)) {
      picked.push({ i: exit.i, value: exitValue, terminal: true });
      usable.push({ c: picked[picked.length - 1]!, j: picked.length - 1, d: exit.d });
    }
    const nearest = (exit ? usable.filter((e) => e.c.i === exit.i) : usable).sort((a, b) => a.d - b.d)[0];
    if (!nearest) return scanOrFallback(wm, ctx, board, finish);
    bestNode = { seq: [nearest.j], at: nearest.j, steps: distTo(null, nearest.j).s, score: 0 };
  }

  const first = picked[bestNode.seq[0]!]!;
  // 目標までの残りの手間（逆向きの探索）。目標がワープ（入ると飛ぶ）なら、その隣までの手間 + 1歩
  const toFirst = first.terminal ? toPortal(board, first.i) : board.dijkstraTo(first.i);
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
    // 目標がワープ: 隣のマスなら 0
    if (first.terminal && Math.abs(board.xy(li)[0] - fx) + Math.abs(board.xy(li)[1] - fy) === 1) return 0;
    return toFirst[li]!;
  };
  const options: { cmd: string; score: number; warp: boolean; danger: boolean }[] = [];
  const specs = phase === "CMD1" ? CMD1_SPECS : CMD2_SPECS;
  // 敵からの歩数の見込み（上下左右の歩数。壁は数えないので、実際より近く見積もる＝用心する側）
  const enemyDist = (i: number): number => {
    if (enemies.length === 0) return Infinity;
    const [cx, cy] = board.xy(i);
    return Math.min(...enemies.map((e) => Math.abs(e.x - cx) + Math.abs(e.y - cy)));
  };
  // CMD1 の着地からは、次の CMD2 で行ける一番遠いマスでターンを終えられる
  const bestNextDist = (li: number): number => {
    const [cx, cy] = board.xy(li);
    let best = enemyDist(li);
    for (const s of Object.values(CMD2_SPECS)) {
      const walk = s.category === "walk" || (s.category === "kei" && board.knight);
      if (!walk) continue;
      const j = board.idx(cx + s.move[0], cy + s.move[1]);
      if (j < 0 || !board.known[j] || board.cost[j] === INF) continue;
      best = Math.max(best, enemyDist(j));
    }
    return best;
  };
  const moveValue = (ev as Partial<EvaluatorModule>).moveValue ?? currentMoveValue;
  const enemyNow = enemyDist(self);
  const { chasing } = nearestEnemyInfo(wm, ctx.turn, x, y);
  const value = (cmd: string, gain: number, actionCost: number, remaining: number, li: number) => {
    const ed = phase === "CMD1" ? bestNextDist(li) : enemyDist(li);
    return { score: moveValue({ phase, cmd, gain, actionCost, remaining, enemyDist: ed, enemyNow, chasing }, p), danger: ed <= p.dangerDist && chasing };
  };
  for (const [cmd, spec] of Object.entries(specs) as [Cmd1Command | Cmd2Command, (typeof CMD1_SPECS)[Cmd1Command]][]) {
    const isWalk = spec.category === "walk" || (spec.category === "get_ready" && (spec.move[0] !== 0 || spec.move[1] !== 0));
    const isKnight = spec.category === "kei";
    if (!isWalk && !(isKnight && p.knightWeight >= 0.5)) continue;
    const step = board.idx(x + spec.move[0], y + spec.move[1]);
    if (step < 0 || !board.known[step]) continue;
    const landingPortal = step === first.i && first.terminal;
    // 行き先の分かっているワープに入る手は、飛んだ先に着いたとして数える
    const warpTo = board.cost[step] === INF && !landingPortal ? board.portalDest[step]! : -1;
    if (board.cost[step] === INF && !landingPortal && warpTo < 0) continue;
    const li = warpTo >= 0 ? warpTo : step;
    const rem = remainingFrom(li);
    if (rem === INF) continue;
    const gain = landingPortal ? 0 : warpTo >= 0 ? ev.tileGain(board.value[step]!) + Math.max(0, ev.tileGain(board.value[li]!)) : ev.tileGain(board.value[li]!);
    options.push({ cmd, ...value(cmd, gain, spec.estActionCost, rem, li), warp: warpTo >= 0 });
  }
  if (phase === "CMD1" && board.knight) {
    const rem = remainingFrom(self);
    if (rem !== INF) options.push({ cmd: "gr", ...value("gr", 0, CMD1_SPECS.gr.estActionCost, rem, self), warp: false });
  }
  // 目標へ向かう手がどれも危ない: 目標と関係なく、敵から離れられる手（通れて知っているマス）も比べる
  if (enemies.length > 0 && !options.some((o) => !o.danger)) {
    for (const [cmd, spec] of Object.entries(specs) as [Cmd1Command | Cmd2Command, (typeof CMD1_SPECS)[Cmd1Command]][]) {
      const isWalk = spec.category === "walk" || (spec.category === "kei" && board.knight) || (spec.category === "get_ready" && (spec.move[0] !== 0 || spec.move[1] !== 0));
      if (!isWalk || options.some((o) => o.cmd === cmd)) continue;
      const li = board.idx(x + spec.move[0], y + spec.move[1]);
      if (li < 0 || !board.known[li] || board.cost[li] === INF) continue;
      const rem = remainingFrom(li);
      options.push({ cmd, ...value(cmd, ev.tileGain(board.value[li]!), spec.estActionCost, rem === INF ? 1000 : rem, li), warp: false });
    }
  }
  options.sort((a, b) => b.score - a.score);
  const choice = options[0];
  const insight = { route, score: Math.round(bestNode.score), candidates: picked.length };
  if (!choice) return scanOrFallback(wm, ctx, board, finish);
  const routeText = route.slice(0, 3).map((r) => `(${r.x},${r.y})${r.value}`).join("→");
  const viaWarp = choice.warp;
  const flee = enemyNow <= p.dangerDist + 1 && !choice.danger ? "（敵から離れる）" : "";
  const tag = directiveIdx === first.i ? "指定の目標" : first.terminal ? "出口のワープへ" : ev.tileGain(board.value[first.i]!) > 0 ? "回収" : "探索";
  return finish(choice.cmd, `${tag}${viaWarp ? "（行き先の分かっているワープを通る）" : ""}${flee} ${routeText} 見込み${insight.score}`, insight);
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
