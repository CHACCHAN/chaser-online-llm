/// <reference lib="webworker" />
import * as defaultEvaluator from "../solver/evaluator";
import { PARAM_SPACE } from "../solver/evaluator";
import type { EvaluatorModule } from "../solver/planner";
import { makePlannerPolicy, type PolicyFn } from "../solver/policy";
import { runEpisode } from "./episode";
import { makeScenario } from "./mapgen";
import { assignOpponents, loadOpponentPlan } from "./opponents";
import type { EpisodeJob } from "./pool";
import { makeRng } from "./rng";

/** SimPool の worker: 1試合ずつシミュレータを回して結果を返す */

const modules = new Map<string, Promise<unknown>>();
const load = <T>(file: string): Promise<T> => {
  if (!modules.has(file)) modules.set(file, import(file));
  return modules.get(file) as Promise<T>;
};

async function policyFor(job: EpisodeJob): Promise<PolicyFn> {
  const ev = job.policy.evaluatorPath ? await load<EvaluatorModule>(job.policy.evaluatorPath) : defaultEvaluator;
  const params = job.oracle === "deep" ? { ...job.policy.params, candidates: PARAM_SPACE.candidates.max, depth: PARAM_SPACE.depth.max, beam: PARAM_SPACE.beam.max } : job.policy.params;
  return makePlannerPolicy(params, ev);
}

self.onmessage = async (ev: MessageEvent<EpisodeJob>) => {
  const job = ev.data;
  try {
    const made = makeScenario(makeRng(job.seed), { room: job.room });
    const scn = job.oracle ? { ...made, webMap: true } : made;
    const opponents = assignOpponents(job.seed, scn.starts.length - 1, job.opponents ?? loadOpponentPlan());
    const result = runEpisode(scn, await policyFor(job), { ...(job.maxTurns ? { maxTurns: job.maxTurns } : {}), trace: job.trace === true, opponents, knowAllWarps: !!job.oracle });
    postMessage({ ok: true, result });
  } catch (err) {
    postMessage({ ok: false, error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
  }
};
