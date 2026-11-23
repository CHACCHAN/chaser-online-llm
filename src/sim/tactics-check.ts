import { PROJECT_ROOT, TACTICS_PATH } from "../paths";
import * as evaluator from "../solver/evaluator";
import { getStyle, loadModelParams, loadStyles, playModelId } from "../solver/models";
import { makePlannerPolicy } from "../solver/policy";
import { makeTacticalPolicy, type TacticsModule } from "../solver/tactics-runtime";
import { runEpisode } from "./episode";
import { makeScenario } from "./mapgen";
import { assignOpponents, loadOpponentPlan } from "./opponents";
import { makeRng } from "./rng";

/**
 * 作戦スクリプトの確かめ（シミュレータで比べる前に）: 短い試合を数枚打たせ、例外・おかしな値・1フェーズの時間を見る。
 * 止まらないスクリプトに備えて、checkTacticsFile は別プロセス（bun src/cli.ts tactics-check）で時間を切る。
 */

export interface TacticsCheck {
  ok: boolean;
  phases: number;
  errors: number;
  lastError: string | null;
  switches: number;
  maxMs: number;
  problem: string | null;
}

/** 1フェーズの上限（ms）。手を出す方策は数ミリ秒なので、それより重い作戦スクリプトは不合格 */
export const TACTICS_MAX_MS = 50;

export async function checkTacticsInProcess(file?: string): Promise<TacticsCheck> {
  let mod: TacticsModule;
  try {
    mod = (await import(`${file ?? TACTICS_PATH}?t=${Date.now()}`)) as TacticsModule;
    if (typeof mod.onPhase !== "function") throw new Error("onPhase を export していない");
  } catch (err) {
    return { ok: false, phases: 0, errors: 1, lastError: err instanceof Error ? err.message : String(err), switches: 0, maxMs: 0, problem: "読み込めない" };
  }
  const models = loadStyles().map((s) => ({ id: s.id, name: s.name, trait: getStyle(s.id).trait, policy: makePlannerPolicy(loadModelParams(s.id), evaluator) }));
  const total = { phases: 0, errors: 0, lastError: null as string | null, switches: 0, maxMs: 0 };
  const plan = loadOpponentPlan();
  for (const seed of [11, 12, 13]) {
    const scn = makeScenario(makeRng(seed), { room: null });
    const policy = makeTacticalPolicy(models, playModelId(), mod);
    runEpisode(scn, policy, { maxTurns: 60, opponents: assignOpponents(seed, scn.starts.length - 1, plan) });
    const s = policy.tactics.stats;
    total.phases += s.phases;
    total.errors += s.errors;
    total.lastError ??= s.lastError;
    total.switches += s.switches;
    total.maxMs = Math.max(total.maxMs, s.maxMs);
  }
  const problem = total.errors > 0 ? `例外・おかしな値 ${total.errors} 回` : total.maxMs > TACTICS_MAX_MS ? `1フェーズ ${total.maxMs}ms（上限 ${TACTICS_MAX_MS}ms）` : null;
  return { ok: problem === null, ...total, problem };
}

/** 別プロセスで確かめる（timeoutMs を過ぎたら止まらないとみて不合格） */
export async function checkTacticsFile(file: string = TACTICS_PATH, timeoutMs = 90_000): Promise<TacticsCheck> {
  const proc = Bun.spawn(["bun", "src/cli.ts", "tactics-check", "--file", file], { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  try {
    const m = out.match(/\{[\s\S]*\}\s*$/);
    if (m) return JSON.parse(m[0]) as TacticsCheck;
  } catch {
    // 下で不合格
  }
  return { ok: false, phases: 0, errors: 0, lastError: null, switches: 0, maxMs: 0, problem: proc.killed || code === null ? `${Math.round(timeoutMs / 1000)} 秒で終わらなかった（止まらない処理がある）` : `確かめられなかった（終了コード ${code}）` };
}
