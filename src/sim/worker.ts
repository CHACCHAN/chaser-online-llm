/// <reference lib="webworker" />
import * as defaultEvaluator from "../solver/evaluator";
import type { EvaluatorModule } from "../solver/planner";
import { makePlannerPolicy, type PolicyFn } from "../solver/policy";
import { runEpisode } from "./episode";
import { makeScenario } from "./mapgen";
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
  return makePlannerPolicy(job.policy.params, ev);
}

self.onmessage = async (ev: MessageEvent<EpisodeJob>) => {
  const job = ev.data;
  try {
    const scn = makeScenario(makeRng(job.seed), { room: job.room });
    const result = runEpisode(scn, await policyFor(job), { ...(job.maxTurns ? { maxTurns: job.maxTurns } : {}), trace: job.trace === true });
    postMessage({ ok: true, result });
  } catch (err) {
    postMessage({ ok: false, error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
  }
};
