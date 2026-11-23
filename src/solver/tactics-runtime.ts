import type { WorldMap } from "../memory/world-map";
import type { ModelRules } from "../agent/match-plan";
import type { Directive } from "./planner";
import type { PolicyFn } from "./policy";

/**
 * 作戦スクリプトの実行（ハーネス）。作戦スクリプト src/solver/tactics.ts（LLM が書く）を、試合中は毎フェーズの初めに呼び、
 * 返した行動（モデルの切り替え・目標・通らないマス・LLM を呼ぶか）をハーネスがすぐ反映する。LLM の返事（40〜90 秒）を待たない。
 * シミュレータでも同じスクリプトが動く（makeTacticalPolicy）ので、方針どおりに切り替えると点が上がるかを同じ地図で比べられる。
 *
 * - 例外を投げた・おかしな値を返したフェーズは、その行動を使わずに続ける（errors に数える）。
 * - スクリプトの状態は memory に残す（1試合の間だけ）。
 * - 目標は、着いた時・ワープで座標系が変わった時に消える。
 */

export interface TacticsEnemy {
  x: number;
  y: number;
  /** 自分からの歩数（上下左右） */
  dist: number;
  tileId: number;
  lastSeenTurn: number;
  /** 前に見た時より近づいたか（初めて見たなら null） */
  approaching: boolean | null;
}

export interface TacticsSignal {
  id: string;
  label: string;
  detail: string;
}

export interface TacticsState {
  turn: number;
  phase: "CMD1" | "CMD2";
  totalTurns: number | null;
  remainingTurns: number | null;
  /** 今の座標（今の区画の座標。ワープで変わる） */
  pos: [number, number];
  /** Webマップの絶対座標（位置合わせできていなければ null） */
  globalPos: [number, number] | null;
  /** 今のモデル・最初のモデル・選べるモデル（knowledge/styles.json） */
  model: string;
  startModel: string;
  models: { id: string; name: string; trait: string }[];
  /** 直近 3 ターンに見た敵（近い順） */
  enemies: TacticsEnemy[];
  nearestEnemy: number | null;
  score: { estimated: number; item: number; putPoint: number; putDamage: number };
  /** アイテム得点の直近 10 ターンの増分（10 ターン経っていなければ null） */
  itemGain10: number | null;
  /** 直近 8 ターンにいたマスの種類（少ないほど行ったり来たり） */
  distinctCells8: number;
  /** この試合で当てられた（プットダメージが減った）ターンと量 */
  hitsTaken: { turn: number; amount: number }[];
  /** 今の目標（LLM の作戦目標か、このスクリプトの目標） */
  target: [number, number] | null;
  targetBy: "llm" | "tactics" | null;
  /** 試合中の LLM（シミュレータでは available=false） */
  llm: { available: boolean; thinking: boolean; lastAskedTurn: number | null; calls: number };
  /** ハーネスのきっかけ（src/agent/triggers.ts）で鳴っていて、まだ LLM に渡していないもの（試合だけ） */
  signals: TacticsSignal[];
  /** 準備の LLM が作戦方針から決めた切り替えの決まり（無ければ null） */
  rules: ModelRules | null;
  inSim: boolean;
  /** スクリプトの状態（1試合の間残る。自由に読み書きしてよい） */
  memory: Record<string, unknown>;
}

export interface TacticsAction {
  /** 切り替えるモデルの id */
  model?: string;
  /** 目標（今の座標）。null で消す。書かなければそのまま */
  target?: [number, number] | null;
  /** 通らないマス（今の座標、50 個まで）。書かなければそのまま、[] で消す */
  avoid?: [number, number][];
  /** LLM を呼ぶ理由（書けば、LLM が空いていれば呼ぶ）。シミュレータでは何もしない */
  askLlm?: string | null;
  /** 記録に残すひとこと */
  note?: string;
}

export interface TacticsModule {
  onPhase(s: TacticsState): TacticsAction | null | undefined | void;
}

export interface TacticsStepInput {
  wm: WorldMap;
  phase: "CMD1" | "CMD2";
  turn: number;
  totalTurns: number | null;
  model: string;
  llmTarget: [number, number] | null;
  llm: TacticsState["llm"];
  signals: TacticsSignal[];
}

export interface TacticsStats {
  phases: number;
  errors: number;
  lastError: string | null;
  switches: number;
  asks: number;
  targets: number;
  /** 1フェーズの最大の時間（ms） */
  maxMs: number;
}

const okCell = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= 1000);

export class TacticsRuntime {
  readonly memory: Record<string, unknown> = {};
  private readonly itemByTurn = new Map<number, number>();
  private readonly hits: { turn: number; amount: number }[] = [];
  private lastPutDamage: number | null = null;
  private readonly seen = new Map<number, number>();
  private frame: number | null = null;
  scriptTarget: [number, number] | null = null;
  avoid: [number, number][] = [];
  readonly stats: TacticsStats = { phases: 0, errors: 0, lastError: null, switches: 0, asks: 0, targets: 0, maxMs: 0 };

  constructor(
    private readonly mod: TacticsModule | null,
    private readonly opts: { models: { id: string; name: string; trait: string }[]; startModel: string; rules: ModelRules | null; inSim: boolean },
  ) {}

  /** プランナーに渡す目標・通らないマス（LLM の目標があればそちらを使う） */
  directive(llmTarget: [number, number] | null, note?: string): Directive | null {
    const target = llmTarget ?? this.scriptTarget;
    if (!target && this.avoid.length === 0) return null;
    return { ...(target ? { target } : {}), ...(this.avoid.length ? { avoid: this.avoid } : {}), ...(note ? { note } : {}) };
  }

  state(input: TacticsStepInput): TacticsState {
    const { wm, turn } = input;
    // ワープで座標系が変わったら、古い座標の目標・通らないマスを消す
    if (this.frame !== null && wm.frameVersion !== this.frame) {
      this.scriptTarget = null;
      this.avoid = [];
      this.seen.clear();
    }
    this.frame = wm.frameVersion;
    const [x, y] = wm.getPosition();
    if (this.scriptTarget && this.scriptTarget[0] === x && this.scriptTarget[1] === y) this.scriptTarget = null;
    const st = wm.getStats();
    if (!this.itemByTurn.has(turn)) this.itemByTurn.set(turn, st.estimatedItemScore);
    if (this.lastPutDamage !== null && st.putDamage < this.lastPutDamage) this.hits.push({ turn, amount: st.putDamage - this.lastPutDamage });
    this.lastPutDamage = st.putDamage;
    const enemies: TacticsEnemy[] = wm
      .getEnemySightings()
      .filter((e) => e.lastSeenTurn >= turn - 3)
      .map((e) => {
        const dist = Math.abs(e.x - x) + Math.abs(e.y - y);
        const before = this.seen.get(e.tileId);
        return { x: e.x, y: e.y, dist, tileId: e.tileId, lastSeenTurn: e.lastSeenTurn, approaching: before === undefined ? null : dist < before };
      })
      .sort((a, b) => a.dist - b.dist);
    if (input.phase === "CMD2") for (const e of enemies) this.seen.set(e.tileId, e.dist);
    const item10 = this.itemByTurn.get(turn - 10);
    const trail = wm.getRecentTrail(16);
    const target = input.llmTarget ?? this.scriptTarget;
    return {
      turn,
      phase: input.phase,
      totalTurns: input.totalTurns,
      remainingTurns: input.totalTurns === null ? null : Math.max(0, input.totalTurns - turn + 1),
      pos: [x, y],
      globalPos: wm.getGlobalPosition(),
      model: input.model,
      startModel: this.opts.startModel,
      models: this.opts.models,
      enemies,
      nearestEnemy: enemies[0]?.dist ?? null,
      score: { estimated: st.estimatedTotalScore, item: st.estimatedItemScore, putPoint: st.putPoint, putDamage: st.putDamage },
      itemGain10: item10 === undefined ? null : st.estimatedItemScore - item10,
      distinctCells8: new Set(trail.map(([a, b]) => `${a},${b}`)).size,
      hitsTaken: [...this.hits],
      target,
      targetBy: input.llmTarget ? "llm" : this.scriptTarget ? "tactics" : null,
      llm: input.llm,
      signals: input.signals,
      rules: this.opts.rules,
      inSim: this.opts.inSim,
      memory: this.memory,
    };
  }

  /** 1フェーズ分。返すのは確かめた行動（モデルが変わる時だけ model） */
  step(input: TacticsStepInput): { action: TacticsAction; ms: number } {
    const action: TacticsAction = {};
    if (!this.mod?.onPhase) return { action, ms: 0 };
    const s = this.state(input);
    const t0 = performance.now();
    let raw: TacticsAction | null | undefined | void;
    try {
      raw = this.mod.onPhase(s);
    } catch (err) {
      this.stats.errors += 1;
      this.stats.lastError = `T${input.turn} ${input.phase}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      raw = null;
    }
    const ms = performance.now() - t0;
    this.stats.phases += 1;
    this.stats.maxMs = Math.max(this.stats.maxMs, Math.round(ms * 10) / 10);
    if (!raw || typeof raw !== "object") return { action, ms };
    const bad = (why: string) => {
      this.stats.errors += 1;
      this.stats.lastError = `T${input.turn} ${input.phase}: ${why}`;
    };
    if (raw.model !== undefined) {
      if (typeof raw.model === "string" && this.opts.models.some((m) => m.id === raw.model)) {
        if (raw.model !== input.model) {
          action.model = raw.model;
          this.stats.switches += 1;
        }
      } else bad(`知らないモデル ${String(raw.model).slice(0, 30)}`);
    }
    if (raw.target !== undefined) {
      if (raw.target === null) this.scriptTarget = null;
      else if (okCell(raw.target)) {
        if (!this.scriptTarget || this.scriptTarget[0] !== raw.target[0] || this.scriptTarget[1] !== raw.target[1]) this.stats.targets += 1;
        this.scriptTarget = [raw.target[0], raw.target[1]];
        action.target = this.scriptTarget;
      } else bad("target は [x, y] の整数");
    }
    if (raw.avoid !== undefined) {
      if (Array.isArray(raw.avoid) && raw.avoid.every(okCell)) {
        this.avoid = raw.avoid.slice(0, 50).map((c) => [c[0], c[1]] as [number, number]);
        action.avoid = this.avoid;
      } else bad("avoid は [x, y] の配列");
    }
    if (typeof raw.askLlm === "string" && raw.askLlm.trim()) {
      action.askLlm = raw.askLlm.trim().slice(0, 200);
      this.stats.asks += 1;
    }
    if (typeof raw.note === "string" && raw.note.trim()) action.note = raw.note.trim().slice(0, 120);
    return { action, ms };
  }
}

/**
 * シミュレータ用: 作戦スクリプトがモデルを切り替え、目標・通らないマスを出す方策（LLM はいない）。
 * models = 特性ごとのモデルの方策（同じ評価関数）。stats は試合の後に読む
 */
export function makeTacticalPolicy(
  models: { id: string; name: string; trait: string; policy: PolicyFn }[],
  startModel: string,
  mod: TacticsModule | null,
  rules: ModelRules | null = null,
): PolicyFn & { tactics: TacticsRuntime } {
  const rt = new TacticsRuntime(mod, { models: models.map(({ id, name, trait }) => ({ id, name, trait })), startModel, rules, inSim: true });
  let active = models.some((m) => m.id === startModel) ? startModel : models[0]!.id;
  const fn = ((wm, phase, turn, info) => {
    const { action } = rt.step({ wm, phase, turn, totalTurns: info.totalTurns, model: active, llmTarget: null, llm: { available: false, thinking: false, lastAskedTurn: null, calls: 0 }, signals: [] });
    if (action.model) active = action.model;
    const policy = models.find((m) => m.id === active)!.policy;
    return policy(wm, phase, turn, { totalTurns: info.totalTurns, directive: rt.directive(null, action.note) });
  }) as PolicyFn & { tactics: TacticsRuntime };
  fn.tactics = rt;
  return fn;
}
