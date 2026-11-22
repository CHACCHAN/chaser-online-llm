import type { WorldMap } from "../memory/world-map";
import type { SolverDecision } from "../solver/types";
import { loadModelParams, loadStyles } from "../solver/models";
import type { EvaluatorModule, PlanInsight } from "../solver/planner";
import { makePlannerPolicy, type PolicyFn } from "../solver/policy";

/**
 * 試合中の LLM を呼ぶ「きっかけ」。方策（学習したモデル）の出力と、ハーネスの観測から毎フェーズ計算する（数ミリ秒）。
 * 鳴った時だけ試合中の LLM を呼ぶ（AGENT_CALL_MODE=trigger）。使うきっかけ・しきい値は準備の LLM が選ぶ（match-plan.ts。docs/architecture.md の「試合中の LLM を呼ぶきっかけ」）。
 * しきい値は TRIGGER_DEFS の範囲の中で変えられる（次の段階で準備の LLM が選ぶ）。
 */

export type TriggerId =
  | "modelSplit"
  | "valueDrop"
  | "noTarget"
  | "stuck"
  | "unknownTile"
  | "enemyNear"
  | "hit"
  | "scoreGap"
  | "warpMiss"
  | "endgame"
  | "heartbeat";

export interface TriggerDef {
  id: TriggerId;
  label: string;
  /** model = 学習したモデルの出力から、observation = 観測から、time = ターン数から */
  source: "model" | "observation" | "time";
  doc: string;
  /** しきい値（無いものは起きたら鳴る） */
  param?: { name: string; default: number; min: number; max: number; integer?: boolean; unit: string };
}

export const TRIGGER_DEFS: TriggerDef[] = [
  { id: "modelSplit", label: "モデルの不一致", source: "model", doc: "特性ごとのモデル（バランス・ハンターなど）に同じ盤面で手を出させ、試合で使うモデルと違う手を出したモデルの数。学習していない（パラメータが同じ）モデルは数えない", param: { name: "違う手のモデルの数", default: 2, min: 1, max: 3, integer: true, unit: "個" } },
  { id: "valueDrop", label: "見込みの急落", source: "model", doc: "（今の推定得点 ＋ 予定の経路の見込み）が前のフェーズより下がった割合（予定の経路の見込みに対して）。罠が見えた・点を先に取られた・行けなくなった時に下がる", param: { name: "下がった割合", default: 0.5, min: 0.1, max: 1, unit: "" } },
  { id: "noTarget", label: "行く先が無い", source: "model", doc: "方策が「行ける目標が無い」で観測・安全な手を続けたフェーズの数", param: { name: "続いたフェーズ", default: 4, min: 1, max: 20, integer: true, unit: "フェーズ" } },
  { id: "stuck", label: "行ったり来たり", source: "observation", doc: "直近 8 ターンにいたマスの種類の数（少ないほど同じ所を回っている）", param: { name: "8ターンのマスの数", default: 3, min: 1, max: 6, integer: true, unit: "マス" } },
  { id: "unknownTile", label: "知らないタイル", source: "observation", doc: "knowledge/tiles.json に無いタイルの番号を見た（方策は通らない壁として扱う）" },
  { id: "enemyNear", label: "敵が近い", source: "observation", doc: "このターンか前のターンに見えた敵までの距離（マンハッタン）", param: { name: "距離", default: 3, min: 1, max: 12, integer: true, unit: "マス" } },
  { id: "hit", label: "当てられた", source: "observation", doc: "Webマップの自分のプットダメージ（PD）が前より減った量", param: { name: "減った量", default: 1, min: 1, max: 100000, integer: true, unit: "点" } },
  { id: "scoreGap", label: "得点のずれ", source: "observation", doc: "Webマップの公式の合計（T、無ければアイテム得点 I）とハーネスの推定の差が、前に鳴った時から動いた量", param: { name: "ずれ", default: 2000, min: 100, max: 100000, integer: true, unit: "点" } },
  { id: "warpMiss", label: "ワープ後の位置合わせ失敗", source: "observation", doc: "ワープの後、Webマップで位置を合わせられないまま次の手を選んだ" },
  { id: "endgame", label: "終盤", source: "time", doc: "残りターンが全体のこの割合を切った（1試合に1回）", param: { name: "残りの割合", default: 0.1, min: 0.01, max: 0.5, unit: "" } },
  { id: "heartbeat", label: "定期", source: "time", doc: "何も起きなくても、このターンごとに鳴る", param: { name: "間隔", default: 50, min: 5, max: 1000, integer: true, unit: "ターン" } },
];

export interface TriggerConfig {
  enabled: Record<TriggerId, boolean>;
  thresholds: Record<TriggerId, number>;
  /** 同じきっかけが続けて鳴らない間（ターン） */
  cooldownTurns: number;
}

export function defaultTriggerConfig(): TriggerConfig {
  return {
    enabled: Object.fromEntries(TRIGGER_DEFS.map((d) => [d.id, true])) as Record<TriggerId, boolean>,
    thresholds: Object.fromEntries(TRIGGER_DEFS.map((d) => [d.id, d.param?.default ?? 0])) as Record<TriggerId, number>,
    cooldownTurns: 5,
  };
}

/** 外から来た設定（準備の LLM など）を範囲に収める。知らない項目は捨て、無い項目は既定のまま */
export function normalizeTriggerConfig(raw: unknown): TriggerConfig {
  const cfg = defaultTriggerConfig();
  if (!raw || typeof raw !== "object") return cfg;
  const r = raw as { enabled?: Record<string, unknown>; thresholds?: Record<string, unknown>; cooldownTurns?: unknown };
  for (const d of TRIGGER_DEFS) {
    if (typeof r.enabled?.[d.id] === "boolean") cfg.enabled[d.id] = r.enabled[d.id] as boolean;
    const v = r.thresholds?.[d.id];
    if (d.param && typeof v === "number" && Number.isFinite(v)) {
      const c = Math.min(d.param.max, Math.max(d.param.min, v));
      cfg.thresholds[d.id] = d.param.integer ? Math.round(c) : c;
    }
  }
  if (typeof r.cooldownTurns === "number" && Number.isFinite(r.cooldownTurns)) cfg.cooldownTurns = Math.min(50, Math.max(0, Math.round(r.cooldownTurns)));
  return cfg;
}

export interface FiredTrigger {
  id: TriggerId;
  /** 画面・記録に出す名前（TRIGGER_DEFS の label） */
  label?: string;
  phase?: "CMD1" | "CMD2";
  /** 鳴った時の値（しきい値と比べた値） */
  value: number;
  detail: string;
}

/** 特性ごとのモデル（試合で使うモデル以外）。パラメータが試合で使うモデルと同じものは入れない */
export interface ModelVoter {
  id: string;
  name: string;
  policy: PolicyFn;
}

export interface PhaseInput {
  wm: WorldMap;
  phase: "CMD1" | "CMD2";
  turn: number;
  totalTurns: number | null;
  /** 試合で使うモデルの、LLM の目標なしの手 */
  play: SolverDecision & { insight?: PlanInsight };
}

export interface TurnEndInput {
  wm: WorldMap;
  turn: number;
  totalTurns: number | null;
  /** Webマップで取れた自分の得点（取れた時だけ。ourTurn はその時のハーネスのターン） */
  web?: { ourTurn: number; itemPoint: number; totalScore?: number; putDamage?: number } | null;
  /** ワープ後の位置合わせを待って、合わせられなかった */
  warpMisaligned?: boolean;
}

const NO_TARGET_PREFIX = "行ける目標が無い";

export class TriggerMonitor {
  readonly config: TriggerConfig;
  private voters: ModelVoter[];
  private readonly last = new Map<TriggerId, number>();
  private readonly fired: Record<string, number> = {};
  private readonly raw: Record<string, number> = {};
  private prevExpected: { value: number; route: number } | null = null;
  private noTargetRun = 0;
  private readonly positions: string[] = [];
  private readonly estByTurn = new Map<number, { item: number; total: number }>();
  private lastPutDamage: number | null = null;
  private lastGapFired = 0;
  private endgameDone = false;

  constructor(voters: ModelVoter[], config: TriggerConfig = defaultTriggerConfig()) {
    this.voters = voters;
    this.config = config;
  }

  /** 試合中に使うモデルを切り替えた時に、比べるモデルを入れ替える（数えた回数はそのまま） */
  setVoters(voters: ModelVoter[]): void {
    this.voters = voters;
  }

  /** 比べるモデルの数（パラメータが試合で使うモデルと違うもの） */
  get voterCount(): number {
    return this.voters.length;
  }

  private emit(out: FiredTrigger[], turn: number, f: FiredTrigger): void {
    if (!this.config.enabled[f.id]) return;
    this.raw[f.id] = (this.raw[f.id] ?? 0) + 1;
    const prev = this.last.get(f.id);
    const cool = f.id === "unknownTile" || f.id === "endgame" || f.id === "heartbeat" || f.id === "hit" ? 0 : this.config.cooldownTurns;
    if (prev !== undefined && turn - prev < cool) return;
    this.last.set(f.id, turn);
    this.fired[f.id] = (this.fired[f.id] ?? 0) + 1;
    out.push({ ...f, label: TRIGGER_DEFS.find((d) => d.id === f.id)?.label ?? f.id });
  }

  /** フェーズの初め（手を送る前）: モデルの出力と、そのフェーズの観測から。votes はモデルごとの手（違う時だけ記録に残す） */
  phase(input: PhaseInput): { fired: FiredTrigger[]; votes: Record<string, string> | null } {
    const { wm, phase, turn, play } = input;
    const out: FiredTrigger[] = [];
    const th = this.config.thresholds;

    // モデルの不一致（LLM の目標なしで、同じ盤面に手を出させる）
    let votes: Record<string, string> | null = null;
    if (this.voters.length > 0) {
      const differ: string[] = [];
      const all: Record<string, string> = {};
      for (const v of this.voters) {
        try {
          const d = v.policy(wm, phase, turn, { totalTurns: input.totalTurns, directive: null });
          all[v.id] = d.command;
          if (d.command !== play.command) differ.push(`${v.name} ${d.command}`);
        } catch {
          // 比べるモデルの例外は試合に響かせない
        }
      }
      if (differ.length > 0) votes = all;
      const need = Math.min(th.modelSplit, this.voters.length);
      if (differ.length >= need) this.emit(out, turn, { id: "modelSplit", phase, value: differ.length, detail: `今のモデル ${play.command}／${differ.join("・")}` });
    }

    // 見込みの急落（推定得点 ＋ 予定の経路の見込み）
    const route = play.insight?.score;
    if (typeof route === "number" && Number.isFinite(route)) {
      const expected = wm.getStats().estimatedTotalScore + route;
      if (this.prevExpected && this.prevExpected.route >= 300) {
        const drop = (this.prevExpected.value - expected) / this.prevExpected.route;
        if (drop >= th.valueDrop) this.emit(out, turn, { id: "valueDrop", phase, value: Math.round(drop * 100) / 100, detail: `見込み ${Math.round(this.prevExpected.value)} → ${Math.round(expected)}` });
      }
      this.prevExpected = { value: expected, route };
    }

    // 行く先が無い
    if (play.reason.startsWith(NO_TARGET_PREFIX)) {
      this.noTargetRun += 1;
      if (this.noTargetRun >= th.noTarget) this.emit(out, turn, { id: "noTarget", phase, value: this.noTargetRun, detail: `${this.noTargetRun} フェーズ続けて行ける目標が無い` });
    } else this.noTargetRun = 0;

    // 知らないタイル
    const flags = wm.getLastEventFlags();
    if (flags.newUnknownTiles.length > 0) this.emit(out, turn, { id: "unknownTile", phase, value: flags.newUnknownTiles.length, detail: `番号 ${flags.newUnknownTiles.join(",")}` });

    // 敵が近い
    const [x, y] = wm.getPosition();
    let near: { d: number; e: { x: number; y: number; tileId: number } } | null = null;
    for (const e of wm.getEnemySightings()) {
      if (e.lastSeenTurn < turn - 1) continue;
      const d = Math.abs(e.x - x) + Math.abs(e.y - y);
      if (!near || d < near.d) near = { d, e };
    }
    if (near && near.d <= th.enemyNear) this.emit(out, turn, { id: "enemyNear", phase, value: near.d, detail: `敵 ${near.e.tileId} まで ${near.d} マス` });
    return { fired: out, votes };
  }

  /** ターンの終わり（CMD2 と # の後）: 位置・得点・ターン数から */
  turnEnd(input: TurnEndInput): FiredTrigger[] {
    const { wm, turn } = input;
    const out: FiredTrigger[] = [];
    const th = this.config.thresholds;
    const stats = wm.getStats();
    this.estByTurn.set(turn, { item: stats.estimatedItemScore, total: stats.estimatedTotalScore });
    if (this.estByTurn.size > 64) this.estByTurn.delete(Math.min(...this.estByTurn.keys()));

    // 行ったり来たり（区画ごとの座標で数える）
    const [x, y] = wm.getPosition();
    this.positions.push(`${wm.getSegmentId()}:${x},${y}`);
    if (this.positions.length > 8) this.positions.shift();
    if (this.positions.length === 8) {
      const distinct = new Set(this.positions).size;
      if (distinct <= th.stuck) this.emit(out, turn, { id: "stuck", value: distinct, detail: `直近 8 ターンで ${distinct} マスだけ` });
    }

    // 当てられた・得点のずれ（Webマップで取れた時だけ）
    const w = input.web;
    if (w) {
      if (typeof w.putDamage === "number") {
        if (this.lastPutDamage !== null && this.lastPutDamage - w.putDamage >= th.hit) {
          this.emit(out, turn, { id: "hit", value: this.lastPutDamage - w.putDamage, detail: `プットダメージ ${this.lastPutDamage} → ${w.putDamage}` });
        }
        this.lastPutDamage = w.putDamage;
      }
      const est = this.estByTurn.get(w.ourTurn);
      if (est) {
        const gap = typeof w.totalScore === "number" ? w.totalScore - est.total : w.itemPoint - est.item;
        if (Math.abs(gap - this.lastGapFired) >= th.scoreGap) {
          this.emit(out, turn, { id: "scoreGap", value: gap, detail: `${typeof w.totalScore === "number" ? "公式の合計" : "公式のアイテム得点"} − 推定 = ${gap}` });
          this.lastGapFired = gap;
        }
      }
    }

    if (input.warpMisaligned) this.emit(out, turn, { id: "warpMiss", value: 1, detail: "ワープ後に位置を合わせられなかった" });

    // 終盤・定期
    const total = input.totalTurns;
    if (total && !this.endgameDone && total - turn <= Math.ceil(total * th.endgame)) {
      this.endgameDone = true;
      this.emit(out, turn, { id: "endgame", value: total - turn, detail: `残り ${total - turn} / ${total} ターン` });
    }
    if (th.heartbeat > 0 && turn % th.heartbeat === 0) this.emit(out, turn, { id: "heartbeat", value: turn, detail: `${turn} ターン目` });
    return out;
  }

  /** 試合の終わりの集計（鳴った回数＝クールダウン後、raw＝条件を満たした回数） */
  summary(turns: number): { counts: Record<string, number>; raw: Record<string, number>; turns: number; voters: number; config: TriggerConfig } {
    return { counts: { ...this.fired }, raw: { ...this.raw }, turns, voters: this.voters.length, config: this.config };
  }
}

/** パラメータが同じかどうか（学習していないモデルは試合で使うモデルと同じなので比べない） */
export function sameParams(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 1e-9) return false;
  return true;
}

/** 試合の初めに読み込んだ全部のモデル（試合中はファイルが変わってもこれを使う） */
export interface LoadedModel {
  id: string;
  name: string;
  params: Record<string, number>;
  policy: PolicyFn;
}

export function loadAllModels(evaluator?: EvaluatorModule): LoadedModel[] {
  return loadStyles().map((s) => {
    const params = loadModelParams(s.id);
    return { id: s.id, name: s.name, params: params as unknown as Record<string, number>, policy: makePlannerPolicy(params, evaluator) };
  });
}

/** 使っているモデル以外で、パラメータが違うモデル（同じものは同じ手を出すので比べない） */
export function votersFrom(models: LoadedModel[], active: string): ModelVoter[] {
  const play = models.find((m) => m.id === active)?.params ?? {};
  return models.filter((m) => m.id !== active && !sameParams(m.params, play)).map((m) => ({ id: m.id, name: m.name, policy: m.policy }));
}

/** 試合で使うモデル以外の、パラメータが違うモデルに手を出させる準備（同じ評価関数で） */
export function buildVoters(playModel: string, evaluator?: EvaluatorModule): ModelVoter[] {
  return votersFrom(loadAllModels(evaluator), playModel);
}
