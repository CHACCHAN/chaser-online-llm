import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorldMap } from "../memory/world-map";
import { POLICY_PARAMS_PATH } from "../paths";
import { decideTurnAction, type SolverDecision } from "./active-solver";
import * as evaluatorModule from "./evaluator";
import { clampParams, defaultParams, type Params } from "./evaluator";
import { planMove, type Directive, type EvaluatorModule, type PlanInsight } from "./planner";

/**
 * 試合中に手を決める方策の共通の形（シミュレータでも同じものを使う）。
 * - planner: 経路探索（evaluator.ts ＋ 学習したパラメータ）。既定
 * - solver: 従来のソルバー（src/solver/active-solver.ts）
 */
export type PolicyKind = "planner" | "solver";
export const POLICY_KINDS: readonly PolicyKind[] = ["planner", "solver"];

export interface PolicyInfo {
  /** 1試合の全ターン数（不明なら null） */
  totalTurns: number | null;
  directive?: Directive | null;
}

export type PolicyFn = (wm: WorldMap, phase: "CMD1" | "CMD2", turn: number, info: PolicyInfo) => SolverDecision & { insight?: PlanInsight };

export interface PolicyParamsFile {
  version: 1;
  params: Params;
  updatedAt: string;
  /** どうやって決めた値か（default / train / manual） */
  source: string;
  /** 学習の時の成績（シミュレータの平均得点など） */
  bench?: Record<string, number | string>;
}

export function loadPolicyParams(file = POLICY_PARAMS_PATH): Params {
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf-8")) as PolicyParamsFile;
      return clampParams(data.params ?? {});
    }
  } catch {
    // 壊れていたら初期値で続ける
  }
  return defaultParams();
}

export function loadPolicyParamsFile(file = POLICY_PARAMS_PATH): PolicyParamsFile | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as PolicyParamsFile) : null;
  } catch {
    return null;
  }
}

export function savePolicyParams(params: Params, source: string, bench?: PolicyParamsFile["bench"], file = POLICY_PARAMS_PATH): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const data: PolicyParamsFile = { version: 1, params: clampParams(params), updatedAt: new Date().toISOString(), source, ...(bench ? { bench } : {}) };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

const remainingTurns = (turn: number, totalTurns: number | null) => (totalTurns === null ? null : Math.max(1, totalTurns - turn + 1));

export function makePlannerPolicy(params: Params = loadPolicyParams(), evaluator: EvaluatorModule = evaluatorModule): PolicyFn {
  return (wm, phase, turn, info) =>
    planMove(wm, { phase, turn, remainingTurns: remainingTurns(turn, info.totalTurns), params, evaluator, directive: info.directive ?? null });
}

export function makeSolverPolicy(decide: typeof decideTurnAction = decideTurnAction): PolicyFn {
  return (wm, phase, turn, info) => decide(wm, phase, turn, info.directive?.target ? { target: info.directive.target, note: info.directive.note } : null);
}
