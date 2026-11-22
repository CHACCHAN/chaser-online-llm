import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { POLICY_PARAMS_PATH } from "../paths";
import { handleLabRequest } from "../ui/lab-routes";
import { LearningLab, type LabState } from "./lab";

/** 「学習」画面の流れ（地図を作る → 並べた地図で学習 → 学習前・後の記録）。worker 2つ・20ターンの短い試合で確かめる */
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

test("地図を作ると今の方策で全部打たせ、並べた地図で学習すると学習前・後の記録が同じ地図でそろう", async () => {
  const lab = new LearningLab();
  const states: LabState[] = [];
  lab.onChange((s) => states.push(s));

  expect(await lab.makeMaps({ n: 4, room: null })).toBe(true);
  let ms = lab.mapSet();
  expect(ms.set!.maps.length).toBe(4);
  expect(ms.grids.length).toBe(4);
  expect(ms.before!.length).toBe(4);
  expect(ms.before![0]!.trace!.frames.length).toBe(ms.before![0]!.totalTurns);
  expect(ms.set!.before).not.toBeNull();
  expect(ms.after).toBeNull();

  const r = await lab.train({ room: null, minutes: 0.08, dryRun: true, trigger: "manual", onSet: true });
  expect(r!.generations).toBeGreaterThan(0);
  ms = lab.mapSet();
  expect(ms.after!.length).toBe(4);
  expect(ms.after!.map((e) => e.scenario)).toEqual(ms.before!.map((e) => e.scenario));
  expect(ms.set!.validation!.n).toBeGreaterThan(0);
  expect(ms.set!.accepted).toBe(false); // 試すだけなので保存しない
  expect(existsSync(POLICY_PARAMS_PATH)).toBe(false);
  expect(states.some((s) => s.job?.generations.length)).toBe(true);
  expect(lab.busy).toBe(false);
}, 90_000);

test("止める: 回っている世代が終わったところで止まる。仕事は同時に1つ", async () => {
  const lab = new LearningLab();
  const running = lab.train({ room: null, minutes: 5, dryRun: true, trigger: "manual" });
  expect(await lab.makeMaps({ n: 2, room: null })).toBe(false);
  lab.stop();
  const r = await running;
  expect(r!.generations).toBeLessThanOrEqual(1);
  expect(lab.state().last!.stopped).toBe(true);
}, 60_000);

test("試合をしていない間の学習は、試合が始まると止まる", async () => {
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

test("API: 状態を返し、地図を作る前の学習は断る", async () => {
  const st = await (await handleLabRequest(new Request("http://x/api/lab"), new URL("http://x/api/lab")))!.json();
  expect(st.ok).toBe(true);
  const req = new Request("http://x/api/lab/train", { method: "POST", body: JSON.stringify({ minutes: 1 }) });
  const res = (await handleLabRequest(req, new URL(req.url)))!;
  expect(res.status).toBe(400);
  expect(await handleLabRequest(new Request("http://x/api/state"), new URL("http://x/api/state"))).toBeNull();
});
