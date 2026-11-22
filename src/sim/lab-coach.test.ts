import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EVALUATOR_PATH, SIM_PROFILES_PATH, TRAIN_CONFIG_PATH } from "../paths";
import { histogramDistance, mapStructure, readCoachLog, runLabCoach, stuckTurns, tileHistogram } from "./lab-coach";
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
  const p = { evaluator: path.join(dir, "evaluator.ts"), profiles: path.join(dir, "sim-profiles.json"), trainConfig: path.join(dir, "train-config.json"), styles: path.join(dir, "styles.json"), review: path.join(dir, "REVIEW.md"), dir: path.join(dir, "out"), log: path.join(dir, "log.jsonl") };
  writeFileSync(p.styles, JSON.stringify({ styles: [{ id: "standard", name: "バランス", objective: {} }, { id: "hunter", name: "ハンター", objective: { put: 1 } }] }));
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

test("地図の形: 帯で区切られた区画の数・大きい区画の外の点・罠に囲まれた点", () => {
  // 0 = 穴, 12 = 奈落, 4 = ジオード, 77 = 点の高いアイテム（土 10 より高いものを点と数える）
  const g = [
    [0, 0, 0, 0, 12, 0, 0],
    [0, 0, 0, 0, 12, 0, 0],
    [0, 4, 0, 0, 12, 0, 0],
    [4, 77, 4, 0, 12, 0, 77],
    [0, 4, 0, 0, 12, 0, 0],
  ];
  const s = mapStructure(g);
  expect(s.regions).toBe(2);
  expect(s.enclosed).toBeGreaterThan(0);
  expect(s.outsideMain).toBeGreaterThan(0);
});

test("学習の LLM が足したモデル: 前からあるモデルは消さず、範囲の中だけ通す", async () => {
  const { stylesProblem } = await import("./lab-coach");
  const before = JSON.stringify({ styles: [{ id: "standard", name: "バランス", objective: {} }, { id: "hunter", name: "ハンター", objective: { put: 1 } }] });
  const add = (s: object) => JSON.stringify({ styles: [...JSON.parse(before).styles, s] });
  expect(stylesProblem(add({ id: "warper", name: "ワープ使い", objective: { item: 0.5 }, fixed: { exitValue: 800 } }), before)).toBeNull();
  expect(stylesProblem(JSON.stringify({ styles: [{ id: "standard", name: "バランス" }] }), before)).toContain("消した");
  expect(stylesProblem(add({ id: "x", name: "x", objective: { put: 50 } }), before)).toContain("範囲外");
  expect(stylesProblem(add({ id: "x", name: "x", fixed: { depth: 99 } }), before)).toContain("範囲外");
  expect(stylesProblem(add({ id: "x", name: "x", objective: { speed: 1 } }), before)).toContain("知らない目的");
  expect(stylesProblem("{", before)).toContain("JSON");
});

test("報告の「ハーネスへの要望」の節を取り出す（無い・なしなら null）", async () => {
  const { harnessRequests } = await import("./lab-coach");
  expect(harnessRequests("直した。\n\n## ハーネスへの要望\n- 方策に敵から逃げる特徴が欲しい（地図 3 で T40〜90 当てられ続けた）\n")).toContain("逃げる");
  expect(harnessRequests("直した。\n## ハーネスへの要望\nなし\n")).toBeNull();
  expect(harnessRequests("直した。")).toBeNull();
  expect(harnessRequests("## ハーネスへの要望\n- A\n## 次\n- B")).toBe("- A");
});

test("理論値の目安との差: 地図ごとに一番高いものを目安に、知らないこと・考えが浅いことに分ける", async () => {
  const { summarizeGap } = await import("./oracle");
  const r = (score: number) => ({ scenario: "m", score, totalTurns: 10 }) as EpisodeResult;
  const g = summarizeGap([r(1000), r(3000)], [r(2000), r(2000)], [r(4000), r(1000)]);
  expect(g.reference).toBe(350);
  expect(g.policy).toBe(200);
  expect(g.ratio).toBeCloseTo(0.571, 3);
  expect(g.knowledgeGap).toBe(50);
  expect(g.searchGap).toBe(100);
});

test("学習の LLM がモデルを足し、ハーネスへの要望を agent/REVIEW.md に書く。前からあるモデルを消したら戻す", async () => {
  const p = sandbox();
  const styles = JSON.parse(readFileSync(p.styles, "utf-8"));
  const r = await runLabCoach(
    { trigger: "manual", room: null, train: fakeTrain, runs: [] },
    {
      guard: false,
      paths: p,
      ask: async () => {
        writeFileSync(p.styles, JSON.stringify({ styles: [...styles.styles, { id: "warper", name: "ワープ使い", objective: {}, fixed: { exitValue: 900 } }] }));
        return { status: "ok", text: "ワープ使いを足した。\n\n## ハーネスへの要望\n- 敵から逃げる特徴が欲しい", durationMs: 1 };
      },
    },
  );
  expect(r.changes.find((c) => c.what === "styles")).toMatchObject({ accepted: true, detail: "モデルを足した: warper" });
  expect(r.changes.find((c) => c.what === "review")).toMatchObject({ accepted: true });
  expect(readFileSync(p.review, "utf-8")).toContain("敵から逃げる特徴");

  const bad = await runLabCoach(
    { trigger: "manual", room: null, train: fakeTrain, runs: [] },
    { guard: false, paths: { ...p, dir: path.join(p.dir, "2") }, ask: async () => { writeFileSync(p.styles, JSON.stringify({ styles: [styles.styles[0]] })); return { status: "ok", text: "", durationMs: 1 }; } },
  );
  expect(bad.changes.find((c) => c.what === "styles")).toMatchObject({ accepted: false });
  expect(readFileSync(p.styles, "utf-8")).toContain("warper");
});

test("弱点: 失っている点を大きい順に並べ、直し方の手がかりを添える", async () => {
  const { weaknessLines } = await import("./lab-coach");
  const r = { scenario: "m", totalTurns: 100, score: 0, putDamage: -50000, hazardHits: 1, policyErrors: 0 } as EpisodeResult;
  const lines = weaknessLines({ runs: [r], gap: null });
  expect(lines[0]).toContain("相手に当てられた: −500");
  expect(lines[0]).toContain("moveValue");
  expect(lines[1]).toContain("罠");
});

test("評価関数の手の価値: 追ってくる敵の近くでターンを終える手は dangerCost、追ってこない敵は dangerUnsure 倍を引く", async () => {
  const { defaultParams, moveValue } = await import("../solver/evaluator");
  const p = { ...defaultParams(), distWeight: 1, dangerCost: 5000, dangerUnsure: 0.2, dangerDist: 2 };
  const m = { phase: "CMD2" as const, cmd: "wr", gain: 100, actionCost: -10, remaining: 20, enemyDist: Infinity, enemyNow: 5, chasing: false };
  expect(moveValue(m, p)).toBe(70);
  expect(moveValue({ ...m, enemyDist: 2, chasing: true }, p)).toBe(70 - 5000);
  expect(moveValue({ ...m, enemyDist: 2 }, p)).toBe(70 - 1000);
  expect(moveValue({ ...m, enemyDist: 3, chasing: true }, p)).toBe(70);
});
