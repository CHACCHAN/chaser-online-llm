import { buildVoters, defaultTriggerConfig, type TriggerConfig, TRIGGER_DEFS, TriggerMonitor } from "../agent/triggers";
import { loadModelParams } from "../solver/models";
import { makePlannerPolicy, type PolicyFn } from "../solver/policy";
import { runEpisode } from "./episode";
import { makeScenario } from "./mapgen";
import { assignOpponents, loadOpponentPlan } from "./opponents";
import { makeRng } from "./rng";

/**
 * シミュレータで、試合中の LLM を呼ぶきっかけがどれくらい鳴るかを数える（本物の試合の前に、しきい値の見当を付ける）。
 * Webマップの得点はシミュレータに無いので「当てられた」「得点のずれ」は鳴らない。ワープの位置合わせも無い。
 */

export interface TriggerSimResult {
  maps: number;
  turns: number;
  voters: string[];
  /** きっかけごとの、100 ターンあたりの鳴った回数（クールダウン後）と、条件を満たした回数 */
  per100: Record<string, { fired: number; raw: number }>;
  /** 1試合（その地図のターン数）あたりの鳴った回数の合計 ＝ LLM を呼ぶ回数の見込み */
  callsPerMatch: number;
}

export function measureTriggers(opts: { n: number; seed: number; room: number | null; maxTurns: number; model: string; config?: TriggerConfig }): TriggerSimResult {
  const params = loadModelParams(opts.model);
  const voters = buildVoters(opts.model);
  const plan = loadOpponentPlan(opts.model);
  const fired: Record<string, number> = {};
  const raw: Record<string, number> = {};
  let turns = 0;
  let calls = 0;
  for (let i = 0; i < opts.n; i++) {
    const seed = opts.seed + i;
    const scn = makeScenario(makeRng(seed), { room: opts.room });
    const monitor = new TriggerMonitor(voters, opts.config ?? defaultTriggerConfig());
    const play = makePlannerPolicy(params);
    let ended = 0;
    const policy: PolicyFn = (wm, phase, turn, info) => {
      // 前のターンの終わりは、次のターンの CMD1 の前に数える（位置・推定得点はその時の盤面）
      if (phase === "CMD1" && turn - 1 > ended) {
        monitor.turnEnd({ wm, turn: turn - 1, totalTurns: info.totalTurns });
        ended = turn - 1;
      }
      const d = play(wm, phase, turn, info);
      monitor.phase({ wm, phase, turn, totalTurns: info.totalTurns, play: d });
      return d;
    };
    const r = runEpisode(scn, policy, { maxTurns: opts.maxTurns, opponents: assignOpponents(seed, scn.starts.length - 1, plan) });
    turns += r.totalTurns;
    const s = monitor.summary(r.totalTurns);
    for (const [k, v] of Object.entries(s.counts)) fired[k] = (fired[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.raw)) raw[k] = (raw[k] ?? 0) + v;
    calls += Object.values(s.counts).reduce((a, b) => a + b, 0);
  }
  const per100: TriggerSimResult["per100"] = {};
  for (const d of TRIGGER_DEFS) per100[d.id] = { fired: Math.round(((fired[d.id] ?? 0) / Math.max(1, turns)) * 1000) / 10, raw: Math.round(((raw[d.id] ?? 0) / Math.max(1, turns)) * 1000) / 10 };
  return { maps: opts.n, turns, voters: voters.map((v) => v.id), per100, callsPerMatch: Math.round((calls / Math.max(1, opts.n)) * 10) / 10 };
}
