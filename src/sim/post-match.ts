import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EVALUATOR_PATH, POLICY_DIR, PROJECT_ROOT, TACTICS_PATH } from "../paths";
import { getSetting, numSetting } from "../settings";
import { loadModelParams, loadStyles, playModelId } from "../solver/models";
import { loadOpponentPlan } from "./opponents";
import { SimPool } from "./pool";
import { compareResults, comparePolicies, evaluatePolicy, makeEvalSet, notWorse, perTurn, type Comparison } from "./train";

/**
 * 試合後のシミュレータの仕事（evolve.ts から呼ぶ）。
 * - エージェントが評価関数（src/solver/evaluator.ts）を改修したら、改修前と同じ地図で比べ、弱くなっていれば元に戻す。
 * - 方策のパラメータの学習は lab.ts（WebUI の「学習」と同じ仕事の受け持ち）。
 * - 振り返りに渡すための、今の方策のシミュレータでの成績。
 */

const workers = () => {
  const n = Number(getSetting("SIM_WORKERS") || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};
const maxTurns = () => numSetting("SIM_MAX_TURNS", { min: 10, integer: true });

/** 改修前の評価関数を、相対 import を絶対パスに直して var/policy/ に書く（worker から読み込めるように） */
const EVALUATOR_BASELINE_PATH = path.join(POLICY_DIR, "evaluator-baseline.ts");
/** 振り返りの途中で止まった時に戻すための、改修前の評価関数 */
export const EVALUATOR_BACKUP_PATH = path.join(POLICY_DIR, "evaluator-backup.ts");

function writeImportable(code: string, file: string): void {
  const solverDir = path.join(PROJECT_ROOT, "src/solver");
  const fixed = code.replace(/from\s+"(\.{1,2}\/[^"]+)"/g, (_m, rel: string) => `from "${path.resolve(solverDir, rel)}"`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, fixed);
}

export function backupEvaluator(code: string | null): void {
  if (code === null) return;
  mkdirSync(POLICY_DIR, { recursive: true });
  writeFileSync(EVALUATOR_BACKUP_PATH, code);
}

export function clearEvaluatorBackup(): void {
  rmSync(EVALUATOR_BACKUP_PATH, { force: true });
  rmSync(TACTICS_BACKUP_PATH, { force: true });
}

/** 作戦スクリプト: 改修前の写し（比べる用）と、振り返りの途中で止まった時に戻すための控え */
const TACTICS_BASELINE_PATH = path.join(POLICY_DIR, "tactics-baseline.ts");
export const TACTICS_BACKUP_PATH = path.join(POLICY_DIR, "tactics-backup.ts");

export function backupTactics(code: string | null): void {
  if (code === null) return;
  mkdirSync(POLICY_DIR, { recursive: true });
  writeFileSync(TACTICS_BACKUP_PATH, code);
}

/** 作戦スクリプトで打つ時の、特性ごとのモデルのパラメータと最初のモデル（試合と同じ） */
export function tacticsSpec(file?: string): { models: Record<string, ReturnType<typeof loadModelParams>>; start: string; path?: string } {
  return { models: Object.fromEntries(loadStyles().map((s) => [s.id, loadModelParams(s.id)])), start: playModelId(), ...(file ? { path: file } : {}) };
}

export interface TacticsGateResult extends GateResult {
  /** 改修後の作戦スクリプトの例外・おかしな値の回数（全部の地図の合計）・モデルの切り替えの回数 */
  errors: number;
  switches: { before: number; after: number };
  lastError: string | null;
}

/**
 * 作戦スクリプトの改修を確かめる: 同じ地図・同じ相手で、改修前と改修後の作戦スクリプトでモデルを切り替えながら打たせて比べる。
 * 例外・おかしな値が1回でもあるか、はっきり悪くなっていれば不合格
 */
export async function gateTacticsChange(baselineCode: string, room: number | null, n = 24): Promise<TacticsGateResult> {
  writeImportable(baselineCode, TACTICS_BASELINE_PATH);
  const pool = new SimPool(workers());
  try {
    const set = makeEvalSet(710_000, n, room, maxTurns());
    const opponents = loadOpponentPlan();
    const params = loadModelParams(playModelId());
    const [ra, rb] = await Promise.all([
      evaluatePolicy(pool, { kind: "planner", params, tactics: tacticsSpec(TACTICS_BASELINE_PATH) }, set, opponents),
      evaluatePolicy(pool, { kind: "planner", params, tactics: tacticsSpec(TACTICS_PATH) }, set, opponents),
    ]);
    const c = compareResults(ra, rb);
    const errors = rb.reduce((a, r) => a + (r.tactics?.errors ?? 0), 0);
    const switches = { before: ra.reduce((a, r) => a + (r.tactics?.switches ?? 0), 0), after: rb.reduce((a, r) => a + (r.tactics?.switches ?? 0), 0) };
    const lastError = rb.map((r) => r.tactics?.lastError).find((e) => !!e) ?? null;
    return { ok: errors === 0 && notWorse(c), comparison: c, error: errors > 0 ? `作戦スクリプトの例外・おかしな値 ${errors} 回（${lastError}）` : null, errors, switches, lastError };
  } catch (err) {
    return { ok: false, comparison: null, error: err instanceof Error ? err.message.split("\n")[0]! : String(err), errors: 0, switches: { before: 0, after: 0 }, lastError: null };
  } finally {
    pool.close();
    rmSync(TACTICS_BASELINE_PATH, { force: true });
  }
}

export interface GateResult {
  ok: boolean;
  comparison: Comparison | null;
  error: string | null;
}

/** 改修後の評価関数が改修前より弱くないか（同じ地図・同じパラメータで比べる。読み込めない・例外も不合格） */
export async function gateEvaluatorChange(baselineCode: string, room: number | null, n = 24): Promise<GateResult> {
  writeImportable(baselineCode, EVALUATOR_BASELINE_PATH);
  const pool = new SimPool(workers());
  try {
    const params = loadModelParams(playModelId());
    const set = makeEvalSet(700_000, n, room, maxTurns());
    const c = await comparePolicies(
      pool,
      { kind: "planner", params, evaluatorPath: EVALUATOR_BASELINE_PATH },
      { kind: "planner", params, evaluatorPath: `${EVALUATOR_PATH}` },
      set,
    );
    return { ok: notWorse(c), comparison: c, error: null };
  } catch (err) {
    return { ok: false, comparison: null, error: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
  } finally {
    pool.close();
    rmSync(EVALUATOR_BASELINE_PATH, { force: true });
  }
}

export interface RoomBench {
  perTurn: number;
  maps: number;
  hazardHits: number;
  /** 本物の地図（var/maps/）を使った試合の数 */
  realMaps: number;
}

/** 今の方策の、このルームに似せた地図での成績（振り返りに渡す） */
export async function benchRoom(room: number, n = 16): Promise<RoomBench> {
  const pool = new SimPool(workers());
  try {
    const set = { seeds: Array.from({ length: n }, (_, i) => 800_000 + i), rooms: Array.from({ length: n }, () => room), maxTurns: maxTurns() };
    const rs = await evaluatePolicy(pool, { kind: "planner", params: loadModelParams(playModelId()) }, set);
    return {
      perTurn: Math.round((rs.reduce((s, r) => s + perTurn(r), 0) / rs.length) * 10) / 10,
      maps: rs.length,
      hazardHits: rs.reduce((s, r) => s + r.hazardHits, 0),
      realMaps: rs.filter((r) => r.scenario.startsWith("real:")).length,
    };
  } finally {
    pool.close();
  }
}
