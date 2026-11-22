import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { POLICY_PARAMS_PATH } from "../paths";
import { handleLabRequest } from "../ui/lab-routes";
import { LearningLab, readTrainLog, type LabState } from "./lab";

/** 「学習」画面の仕事（学習・比べる・1試合の再生）。worker 2つ・20ターンの短い試合で確かめる */
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries({ SIM_WORKERS: "2", SIM_MAX_TURNS: "20", TRAIN_IDLE: "false" })) {
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

test("学習: 世代ごとの成績が届き、終わると記録に残る。試すだけなら保存しない。同時に2つは動かさない", async () => {
  const lab = new LearningLab();
  const states: LabState[] = [];
  lab.onChange((s) => states.push(s));
  const running = lab.train({ room: null, minutes: 0.08, dryRun: true, trigger: "manual" });
  expect(lab.busy).toBe(true);
  expect(await lab.bench({ room: null, n: 4, a: "default", b: "current" })).toBeNull();
  const r = await running;
  expect(r).not.toBeNull();
  expect(r!.generations).toBeGreaterThan(0);
  const last = lab.state().last!;
  expect(last.kind).toBe("train");
  expect(last.generations.length).toBe(r!.generations);
  expect(last.comparison?.n).toBeGreaterThan(0);
  expect(lab.busy).toBe(false);
  expect(states.some((s) => s.job?.generations.length)).toBe(true);
  expect(existsSync(POLICY_PARAMS_PATH)).toBe(false);
  expect(readTrainLog(1)[0]?.trigger).toBe("manual");
}, 60_000);

test("止める: 回っている世代が終わったところで止まる。比べる・1試合の再生", async () => {
  const lab = new LearningLab();
  const running = lab.train({ room: null, minutes: 5, dryRun: true, trigger: "manual" });
  lab.stop();
  const r = await running;
  expect(r!.generations).toBeLessThanOrEqual(1);
  expect(lab.state().last!.stopped).toBe(true);

  const c = await lab.bench({ room: null, n: 4, a: "default", b: "default" });
  expect(c!.n).toBe(4);
  expect(c!.diff).toBe(0);

  const ep = await lab.episode({ seed: 3, room: null, maxTurns: 15, policy: "current" });
  expect(ep.trace!.frames.length).toBe(ep.totalTurns);
  expect(ep.trace!.grid.length).toBe(ep.trace!.height);
  expect(ep.trace!.frames.some((f) => f.changed.length > 0)).toBe(true);
}, 60_000);

test("試合をしていない間の学習は、試合が始まると止まり、ほかの仕事に譲る", async () => {
  const lab = new LearningLab();
  lab.setIdle(true);
  await Bun.sleep(50);
  expect(lab.state().job?.trigger).toBe("idle");
  lab.setMatchActive(true);
  expect(lab.state().idle.reason).toContain("試合中");
  while (lab.busy) await Bun.sleep(50);
  lab.setIdle(false);
  lab.setMatchActive(false);
  expect(lab.busy).toBe(false);
}, 60_000);

test("API: 概要を返し、1試合の再生を返す", async () => {
  const ov = await (await handleLabRequest(new Request("http://x/api/lab"), new URL("http://x/api/lab")))!.json();
  expect(ov.ok).toBe(true);
  expect(Object.keys(ov.policy.space)).toContain("distWeight");
  const req = new Request("http://x/api/lab/episode", { method: "POST", body: JSON.stringify({ seed: 5, maxTurns: 10, policy: "default" }) });
  const ep = await (await handleLabRequest(req, new URL(req.url)))!.json();
  expect(ep.ok).toBe(true);
  expect(ep.result.trace.frames.length).toBe(10);
  expect(await handleLabRequest(new Request("http://x/api/state"), new URL("http://x/api/state"))).toBeNull();
}, 60_000);
