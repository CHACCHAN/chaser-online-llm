import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EVALUATOR_PATH, SIM_PROFILES_PATH, TRAIN_CONFIG_PATH } from "../paths";
import { histogramDistance, readCoachLog, runLabCoach, stuckTurns, tileHistogram } from "./lab-coach";
import { LearningLab } from "./lab";
import type { EpisodeResult } from "./episode";
import type { TrainResult } from "./train";

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries({ SIM_WORKERS: "2", SIM_MAX_TURNS: "20", TRAIN_IDLE: "false", LAB_COACH: "true" })) {
    saved[k] = Bun.env[k];
    Bun.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete Bun.env[k];
    else Bun.env[k] = v;
  }
});

/** 本物のファイルを触らないよう、写しの場所で動かす */
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "coach-"));
  const p = { evaluator: path.join(dir, "evaluator.ts"), profiles: path.join(dir, "sim-profiles.json"), trainConfig: path.join(dir, "train-config.json"), dir: path.join(dir, "out"), log: path.join(dir, "log.jsonl") };
  copyFileSync(EVALUATOR_PATH, p.evaluator);
  copyFileSync(SIM_PROFILES_PATH, p.profiles);
  copyFileSync(TRAIN_CONFIG_PATH, p.trainConfig);
  return p;
}

const fakeTrain: TrainResult = {
  model: "standard", modelName: "バランス", generations: 3, episodes: 100, before: {} as TrainResult["before"], after: {} as TrainResult["after"], accepted: false, ms: 1000,
  comparison: { a: 300, b: 305, diff: 5, se: 4, wins: 12, n: 24, hazardsA: 0, hazardsB: 0 },
};
const run = (positions: [number, number][]): EpisodeResult => ({
  scenario: "gen:5x5", webMap: true, totalTurns: positions.length, score: 3000, action: 0, item: 0, hazardHits: 0, policyErrors: 0, msPerPhase: 1, opponents: [], opponentKinds: [], put: 0, putDamage: 0, won: null,
  trace: { width: 5, height: 5, grid: [[0]], players: [{ id: 1000, self: true }], frames: positions.map((p, i) => ({ turn: i + 1, pos: [p], scores: [0], cmds: ["gr", "wr"], reason: "", changed: [] })) },
});

test("足踏み（最後に2マスを行き来）を数え、タイルの割合の違いを測る", () => {
  const osc = run([[0, 0], [1, 0], [2, 0], ...Array.from({ length: 10 }, (_, i) => [i % 2 ? 3 : 2, 0] as [number, number])]);
  expect(stuckTurns(osc)).toBe(11); // 3つ目の (2,0) も同じ2マスの中
  expect(stuckTurns(run([[0, 0], [1, 0], [2, 0], [3, 0]]))).toBe(0);
  const a = tileHistogram([[[0, 0], [1, 1]]]);
  expect(histogramDistance(a, a)).toBe(0);
  expect(histogramDistance(a, tileHistogram([[[2, 2], [2, 2]]]))).toBe(2);
});

test("学習のやり方の改修: 範囲の中なら採用、外なら戻す。評価関数は比べて弱ければ戻す", async () => {
  const p = sandbox();
  const cfgBefore = readFileSync(p.trainConfig, "utf-8");
  let prompt = "";
  const r = await runLabCoach(
    { trigger: "manual", room: null, train: fakeTrain, runs: [run([[0, 0], [1, 0]])] },
    {
      guard: false,
      paths: p,
      ask: async (text) => {
        prompt = text;
        const cfg = JSON.parse(readFileSync(p.trainConfig, "utf-8"));
        writeFileSync(p.trainConfig, JSON.stringify({ ...cfg, batch: 20 }));
        writeFileSync(p.evaluator, readFileSync(p.evaluator, "utf-8") + "\n// 改修\n");
        return { status: "ok", text: "batch を増やした", durationMs: 1 };
      },
      gateEvaluator: async () => ({ ok: false, comparison: { a: 300, b: 280, diff: -20, se: 3, wins: 2, n: 24, hazardsA: 0, hazardsB: 1 }, error: null }),
    },
  );
  expect(prompt).toContain("学習の LLM");
  expect(prompt).toContain("地図ごとの成績");
  expect(r.status).toBe("ok");
  expect(r.changes.find((c) => c.what === "trainConfig")).toMatchObject({ accepted: true });
  expect(JSON.parse(readFileSync(p.trainConfig, "utf-8")).batch).toBe(20);
  expect(r.changes.find((c) => c.what === "evaluator")).toMatchObject({ accepted: false });
  expect(readFileSync(p.evaluator, "utf-8")).not.toContain("// 改修");
  expect(readCoachLog(5, p.log)[0]!.summary).toBe("batch を増やした");

  const bad = await runLabCoach(
    { trigger: "manual", room: null, train: fakeTrain, runs: [] },
    { guard: false, paths: { ...p, dir: path.join(p.dir, "2") }, ask: async () => { writeFileSync(p.trainConfig, JSON.stringify({ popSize: 1000 })); return { status: "ok", text: "", durationMs: 1 }; } },
  );
  expect(bad.changes[0]).toMatchObject({ what: "trainConfig", accepted: false });
  expect(JSON.parse(readFileSync(p.trainConfig, "utf-8")).batch).toBe(20);
  void cfgBefore;
});

test("止められたら（試合が始まった等）確かめていない改修は全部戻す", async () => {
  const p = sandbox();
  const before = readFileSync(p.trainConfig, "utf-8");
  const r = await runLabCoach(
    { trigger: "idle", room: null, train: fakeTrain, runs: [] },
    { guard: false, paths: p, shouldStop: () => true, ask: async () => { writeFileSync(p.trainConfig, JSON.stringify({ batch: 30 })); return { status: "ok", text: "", durationMs: 1 }; } },
  );
  expect(r.status).toBe("stopped");
  expect(readFileSync(p.trainConfig, "utf-8")).toBe(before);
});

test("学習が終わると学習の LLM が続けて動き、結果が状態に載る", async () => {
  const p = sandbox();
  const lab = new LearningLab();
  let asked = 0;
  lab.coachDeps = { guard: false, paths: p, ask: async () => { asked += 1; return { status: "ok", text: "直す所は無かった", durationMs: 1 }; } };
  expect(await lab.makeMaps({ n: 3, room: null })).toBe(true);
  const r = await lab.train({ room: null, minutes: 0.08, trigger: "manual", onSet: true });
  expect(r!.generations).toBeGreaterThan(0);
  expect(asked).toBe(1);
  expect(lab.state().last!.coach!.state).toBe("done");
  expect(lab.state().lastCoach!.summary).toBe("直す所は無かった");
  expect(readFileSync(path.join(p.dir, "report.md"), "utf-8")).toContain("| 2 |");
  // 試すだけ（dryRun）の時は動かさない
  await lab.train({ room: null, minutes: 0.08, trigger: "manual", onSet: true, dryRun: true });
  expect(asked).toBe(1);
}, 90_000);
